(function (root, factory) {
    const normalizer = typeof module === 'object' && module.exports
        ? require('./tool-call-normalizer') : root.ToolCallNormalizer;
    const api = factory(normalizer);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AIUIMemoryTransport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (normalizer) {
    function protocolFor(endpoint) {
        if (endpoint === '/v1/messages' || endpoint === '/messages') return 'anthropic';
        if (endpoint === '/responses') return 'responses';
        if (endpoint === '/gemini') return 'gemini';
        if (endpoint === '/ollama') return 'ollama';
        return 'chat';
    }

    function declareTool(body, endpoint, tool) {
        const { name, description, parameters } = tool.function;
        const tools = body.tools || [];
        switch (protocolFor(endpoint)) {
            case 'anthropic':
                return { ...body, tools: [...tools, { name, description, input_schema: parameters }] };
            case 'responses':
                return { ...body, tools: [...tools, { type: 'function', name, description, parameters, strict: false }] };
            case 'gemini':
                return { ...body, tools: [...tools, { functionDeclarations: [{ name, description, parametersJsonSchema: parameters }] }] };
            default:
                return { ...body, tools: [...tools, tool] };
        }
    }

    async function isUnsupportedToolError(response) {
        if (![400, 404, 422].includes(response.status) || typeof response.clone !== 'function') return false;
        const message = await response.clone().text().catch(() => '');
        const feature = '(?:tool(?:s| calling| use|_choice)?|function(?:s| calling| declarations))';
        const unsupported = "(?:not supported|does(?: not|n't) support|unsupported|not enabled|unknown (?:field|parameter|argument)|unrecognized (?:field|parameter|argument)|extra inputs are not permitted)";
        return new RegExp(`${feature}[^\\r\\n]{0,100}${unsupported}|${unsupported}[^\\r\\n]{0,100}${feature}`, 'i').test(message);
    }

    function createCollector(endpoint) {
        let protocol = protocolFor(endpoint);
        let complete = false;
        let replay = [];
        let chatMessage;
        let streamedReasoning = '';
        const fragments = [];
        const blocks = [];
        const geminiParts = [];
        let anthropicStopReason;

        function ingestResponses(payload) {
            if (payload.type === 'response.output_item.done') replay[payload.output_index ?? replay.length] = payload.item;
            if (payload.type === 'response.incomplete') complete = false;
            const response = payload.response || payload;
            if (payload.type === 'response.completed' || payload.type === 'response.done' || (!payload.type && Array.isArray(response.output))) {
                complete = !response.status || response.status === 'completed';
                if (Array.isArray(response.output)) replay = response.output;
            }
        }

        function ingestAnthropic(payload) {
            if (payload.type === 'message_start') replay = payload.message?.content || [];
            if (payload.type === 'content_block_start') {
                blocks[payload.index] = { item: { ...payload.content_block }, args: '' };
            }
            if (payload.type === 'content_block_delta') {
                const block = blocks[payload.index];
                if (!block) return;
                const delta = payload.delta || {};
                if (delta.type === 'input_json_delta') block.args += delta.partial_json || '';
                if (delta.type === 'thinking_delta') block.item.thinking = (block.item.thinking || '') + (delta.thinking || '');
                if (delta.type === 'signature_delta') block.item.signature = delta.signature;
                if (delta.type === 'text_delta') block.item.text = (block.item.text || '') + (delta.text || '');
            }
            if (payload.type === 'content_block_stop') {
                const block = blocks[payload.index];
                if (!block) return;
                if (block.args) {
                    try { block.item.input = JSON.parse(block.args); }
                    catch { return; }
                }
                replay[payload.index] = block.item;
            }
            if (payload.type === 'message_delta' && payload.delta?.stop_reason) anthropicStopReason = payload.delta.stop_reason;
            if (payload.type === 'message_stop') complete = ['tool_use', 'end_turn', 'stop_sequence'].includes(anthropicStopReason);
            if (Array.isArray(payload.content)) {
                replay = payload.content;
                complete = !payload.stop_reason || ['tool_use', 'end_turn', 'stop_sequence'].includes(payload.stop_reason);
            }
        }

        function ingestGemini(payload) {
            const candidate = payload.candidates?.[0];
            if (!candidate) return;
            for (const part of candidate.content?.parts || []) {
                if (part.functionCall || part.thought || part.thoughtSignature) geminiParts.push(part);
            }
            if (candidate.finishReason) complete = candidate.finishReason === 'STOP';
        }

        function ingestChat(payload) {
            const choice = payload.choices?.[0];
            if (!choice) return;
            if (choice.message) chatMessage = choice.message;
            if (typeof choice.delta?.reasoning_content === 'string') streamedReasoning += choice.delta.reasoning_content;
            if (choice.delta?.tool_calls) fragments.push({ tool_calls: choice.delta.tool_calls });
            if (choice.finish_reason) complete = ['tool_calls', 'function_call', 'stop'].includes(choice.finish_reason);
            else if (choice.message) complete = true;
        }

        function ingestOllama(payload) {
            const message = payload.message;
            if (typeof message?.thinking === 'string') streamedReasoning += message.thinking;
            if (message?.tool_calls) fragments.push({ tool_calls: message.tool_calls });
            if (payload.done) complete = !payload.done_reason || payload.done_reason === 'stop';
        }

        function ingest(payload) {
            // Some /responses relays return Chat Completions frames.
            if (protocol === 'responses' && Array.isArray(payload.choices)) protocol = 'chat';
            switch (protocol) {
                case 'responses': return ingestResponses(payload);
                case 'anthropic': return ingestAnthropic(payload);
                case 'gemini': return ingestGemini(payload);
                case 'ollama': return ingestOllama(payload);
                default: return ingestChat(payload);
            }
        }

        function finish() {
            if (!complete) return [];
            if (protocol === 'ollama') {
                const calls = fragments.flatMap(frame => normalizer.normalizeToolCalls(frame));
                return [...new Map(calls.map(call => [JSON.stringify(call), call])).values()];
            }
            let values;
            switch (protocol) {
                case 'responses': values = { output: replay }; break;
                case 'anthropic': values = { content: replay }; break;
                case 'gemini': values = { candidates: [{ content: { parts: geminiParts } }] }; break;
                default: values = chatMessage?.tool_calls?.length ? chatMessage : fragments;
            }
            return normalizer.normalizeToolCalls(values);
        }

        function continuation(body, calls, results, reasoning = '') {
            if (protocol !== protocolFor(endpoint)) return null;
            const output = index => JSON.stringify(results[index]?.result ?? { ok: false });
            // A continuation happens only when the first reply has no answer.
            // Replay signed/opaque reasoning and the actual tool-use frames.
            switch (protocol) {
                case 'responses': {
                    if (!calls.every(call => call.id)) return null;
                    const ids = new Set(calls.map(call => call.id));
                    const items = replay.filter(item => item?.type === 'reasoning' || item?.type === 'message'
                        || (item?.type === 'function_call' && ids.has(item.call_id)));
                    const outputs = calls.map((call, index) => ({ type: 'function_call_output', call_id: call.id, output: output(index) }));
                    return { ...body, input: [...body.input, ...items, ...outputs], tool_choice: 'none' };
                }
                case 'anthropic': {
                    if (!calls.every(call => call.id)) return null;
                    const ids = new Set(calls.map(call => call.id));
                    const content = replay.filter(item => item && (item.type !== 'tool_use' || ids.has(item.id)));
                    const outputs = calls.map((call, index) => ({ type: 'tool_result', tool_use_id: call.id, content: output(index) }));
                    return { ...body, messages: [...body.messages, { role: 'assistant', content }, { role: 'user', content: outputs }], tool_choice: { type: 'none' } };
                }
                case 'gemini': {
                    const seen = new Set();
                    const parts = geminiParts.filter(part => {
                        if (!part.functionCall) return true;
                        const operation = part.functionCall;
                        const key = operation.id || JSON.stringify(operation);
                        if (seen.has(key) || !calls.some(call => call.name === operation.name)) return false;
                        seen.add(key);
                        return true;
                    });
                    const outputs = calls.map((call, index) => ({ functionResponse: { name: call.name,
                        ...(call.id ? { id: call.id } : {}), response: { result: results[index]?.result ?? { ok: false } } } }));
                    return { ...body, contents: [...body.contents, { role: 'model', parts }, { role: 'user', parts: outputs }],
                        toolConfig: { functionCallingConfig: { mode: 'NONE' } } };
                }
                case 'ollama': {
                    const { tools, ...clean } = body;
                    const tool_calls = calls.map(call => ({ function: { name: call.name, arguments: call.arguments } }));
                    const outputs = calls.map((call, index) => ({ role: 'tool', tool_name: call.name, content: output(index) }));
                    const thinking = reasoning || streamedReasoning;
                    return { ...clean, messages: [...body.messages, { role: 'assistant', content: '', tool_calls,
                        ...(thinking ? { thinking } : {}) }, ...outputs] };
                }
                default: {
                    if (!calls.every(call => call.id)) return null;
                    const tool_calls = calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
                    const outputs = calls.map((call, index) => ({ role: 'tool', tool_call_id: call.id, content: output(index) }));
                    const thinking = chatMessage?.reasoning_content || reasoning || streamedReasoning;
                    const assistant = { role: 'assistant', content: null, tool_calls };
                    if (/deepseek/i.test(body.model) && thinking) assistant.reasoning_content = thinking;
                    return { ...body, messages: [...body.messages, assistant, ...outputs], tool_choice: 'none' };
                }
            }
        }

        return { ingest, finish, continuation };
    }

    return { declareTool, createCollector, isUnsupportedToolError };
});
