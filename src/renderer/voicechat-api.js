(function () {
    function extractText(value) {
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) {
            return value.map(part => {
                if (typeof part === 'string') return part;
                if (typeof part?.text === 'string') return part.text;
                if (typeof part?.output_text === 'string') return part.output_text;
                return '';
            }).filter(Boolean).join('');
        }
        if (value && typeof value === 'object') {
            if (typeof value.text === 'string') return value.text;
            if (typeof value.output_text === 'string') return value.output_text;
            if (typeof value.content === 'string') return value.content;
        }
        return '';
    }

    function buildResponsesInput(messages) {
        const filtered = (Array.isArray(messages) ? messages : []).filter(message => message?.role !== 'system');
        const hasImage = filtered.some(message => Array.isArray(message?.content)
            && message.content.some(part => part?.type === 'image_url' || part?.type === 'input_image'));
        if (!hasImage) {
            return filtered.map(message => {
                const text = extractText(message?.content).trim();
                if (!text) return '';
                return `${message?.role === 'assistant' ? 'assistant' : 'user'}: ${text}`;
            }).filter(Boolean).join('\n\n');
        }
        return filtered.map(message => {
            const role = message?.role === 'assistant' ? 'assistant' : 'user';
            const textType = role === 'assistant' ? 'output_text' : 'input_text';
            return {
                role,
                content: (Array.isArray(message?.content) ? message.content : [{ type: 'text', text: String(message?.content || '') }])
                    .map(part => {
                        if (part?.type === 'image_url') {
                            return {
                                type: 'input_image',
                                image_url: typeof part.image_url === 'string' ? part.image_url : (part.image_url?.url || '')
                            };
                        }
                        if (part?.type === 'input_image' || part?.type === 'input_file') return part;
                        return { type: textType, text: extractText(part) };
                    })
            };
        });
    }

    function buildMessagesPayload(basePayload) {
        const { messages: sourceMessages, max_tokens, max_output_tokens, prompt_cache_key, cache_control, temperature, top_p, top_k, ...rest } = basePayload || {};
        const messages = Array.isArray(sourceMessages) ? sourceMessages : [];
        const payload = { ...rest };
        if (max_tokens !== undefined || max_output_tokens !== undefined) {
            payload.max_tokens = max_tokens ?? max_output_tokens;
        }
        const systemText = messages
            .filter(message => message?.role === 'system')
            .map(message => extractText(message?.content))
            .filter(Boolean)
            .join('\n\n')
            .trim();
        if (systemText) payload.system = systemText;
        payload.messages = messages
            .filter(message => message?.role === 'user' || message?.role === 'assistant')
            .map(message => ({
                role: message.role,
                content: buildMessagesContent(message?.content)
            }))
            .filter(message => message.content.length);
        return payload;
    }

    function buildMessagesContent(content) {
        if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
        if (!Array.isArray(content)) {
            const text = String(content || '');
            return text ? [{ type: 'text', text }] : [];
        }
        const blocks = [];
        for (const part of content) {
            if (!part || typeof part !== 'object') continue;
            if (part.type === 'image_url' || part.type === 'input_image') {
                const url = typeof part.image_url === 'string' ? part.image_url : (part.image_url?.url || '');
                const dataUrl = String(url || '').match(/^data:([^;,]+);base64,(.+)$/s);
                if (dataUrl) blocks.push({ type: 'image', source: { type: 'base64', media_type: dataUrl[1], data: dataUrl[2].replace(/\s/g, '') } });
                else if (/^https?:\/\//i.test(String(url || ''))) blocks.push({ type: 'image', source: { type: 'url', url } });
                continue;
            }
            const text = part.type === 'text' ? String(part.text || '') : extractText(part);
            if (text) blocks.push({ type: 'text', text });
        }
        return blocks;
    }

    function extractMessagesOutput(payload) {
        const blocks = Array.isArray(payload?.content) ? payload.content : [];
        return blocks
            .filter(block => block?.type === 'text' || (!block?.type && typeof block?.text === 'string'))
            .map(block => String(block.text || ''))
            .filter(Boolean)
            .join('');
    }

    function buildPayload(basePayload, endpoint) {
        if (endpoint === '/v1/messages' || endpoint === '/messages') return buildMessagesPayload(basePayload);
        if (endpoint !== '/responses') return basePayload;
        const messages = Array.isArray(basePayload?.messages) ? basePayload.messages : [];
        const systemMessage = messages.find(message => message?.role === 'system');
        const { messages: _, max_tokens, prompt_cache_key, cache_control, ...rest } = basePayload;
        return {
            ...rest,
            input: buildResponsesInput(messages),
            ...(systemMessage && extractText(systemMessage.content).trim()
                ? { instructions: extractText(systemMessage.content) }
                : {}),
            ...(max_tokens !== undefined ? { max_output_tokens: max_tokens } : {}),
            ...(prompt_cache_key ? { prompt_cache_key } : {})
        };
    }

    function extractResponsesOutput(payload) {
        const response = payload?.response && typeof payload.response === 'object' ? payload.response : payload;
        if (typeof response?.output_text === 'string') return response.output_text;
        if (!Array.isArray(response?.output)) return '';
        return response.output
            .filter(item => item?.type === 'message' || item?.role === 'assistant')
            .flatMap(item => Array.isArray(item?.content) ? item.content : [])
            .filter(part => !part?.type || part.type === 'output_text' || part.type === 'text')
            .map(extractText)
            .filter(Boolean)
            .join('');
    }

    function extractUpdate(payload, endpoint) {
        if (!payload || typeof payload !== 'object') return {};
        if (endpoint === '/v1/messages' || endpoint === '/messages') {
            const type = String(payload.type || '');
            const delta = payload.delta && typeof payload.delta === 'object' ? payload.delta : {};
            if (type === 'content_block_delta') {
                if (delta.type === 'text_delta' || typeof delta.text === 'string') return { delta: String(delta.text || '') };
                return {};
            }
            if (type === 'content_block_start') {
                const block = payload.content_block || {};
                return block.type === 'text' ? { snapshot: String(block.text || '') } : {};
            }
            if (!type) return { snapshot: extractMessagesOutput(payload) };
            return {};
        }
        if (endpoint === '/chat/completions' || Array.isArray(payload.choices)) {
            const choice = payload.choices?.[0] || {};
            return {
                delta: extractText(choice.delta?.content || choice.text),
                snapshot: extractText(choice.message?.content)
            };
        }
        const type = String(payload.type || '');
        if (type === 'response.output_text.delta') return { delta: extractText(payload.delta) };
        if (type === 'response.output_text.done') return { snapshot: extractText(payload.text || payload.output_text || payload.delta) };
        if (type === 'response.content_part.done' || type === 'response.output_item.done') {
            return { snapshot: extractText(payload.part?.type === 'output_text' ? payload.part : '') || extractResponsesOutput({ output: payload.item ? [payload.item] : [] }) };
        }
        if (type === 'response.completed' || type === 'response.done') return { snapshot: extractResponsesOutput(payload) };
        if (!type) return { snapshot: extractResponsesOutput(payload) };
        return {};
    }

    function mergeText(current, delta, snapshot) {
        let next = String(current || '');
        if (delta) next += String(delta);
        if (!snapshot) return next;
        const complete = String(snapshot);
        if (!next || complete.startsWith(next)) return complete;
        if (next.startsWith(complete) || next.endsWith(complete)) return next;
        return complete;
    }

    function parseEvent(block) {
        const lines = String(block || '').replace(/\r\n/g, '\n').split('\n');
        const data = [];
        let eventType = '';
        for (const line of lines) {
            if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            else if (line.startsWith('event:')) eventType = line.slice(6).trim();
        }
        return { data: data.join('\n').trim(), eventType };
    }

    async function streamText(options) {
        const SUPPORTED_ENDPOINTS = ['/responses', '/chat/completions', '/v1/messages'];
        const preferredEndpoint = SUPPORTED_ENDPOINTS.includes(options.endpoint) ? options.endpoint : '/responses';
        const send = endpoint => {
            const headers = {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${options.apiKey || ''}`
            };
            if (endpoint === '/v1/messages') headers['anthropic-version'] = '2023-06-01';
            return fetch(`${String(options.baseUrl || '').replace(/\/$/, '')}${endpoint}`, {
                method: 'POST',
                headers,
                body: JSON.stringify(buildPayload(options.payload, endpoint)),
                signal: options.signal
            });
        };

        let endpoint = preferredEndpoint;
        let response = await send(endpoint);
        if (response.status === 501) {
            // A 501 means the relay does not implement that path at all, so walk the
            // remaining protocols in turn before giving up.
            await response.text().catch(() => '');
            for (const candidate of SUPPORTED_ENDPOINTS.filter(item => item !== preferredEndpoint)) {
                endpoint = candidate;
                if (typeof options.onFallback === 'function') options.onFallback(endpoint);
                response = await send(endpoint);
                if (response.status !== 501) break;
                await response.text().catch(() => '');
            }
        }
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`LLM API 错误 (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
            const payload = await response.json();
            const text = endpoint === '/chat/completions'
                ? extractText(payload?.choices?.[0]?.message?.content)
                : (endpoint === '/v1/messages' ? extractMessagesOutput(payload) : extractResponsesOutput(payload));
            if (typeof options.onText === 'function') options.onText(text);
            return { text, endpoint };
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';
        let sawEvent = false;
        const applyPayload = payload => {
            const errorMessage = payload?.error?.message || payload?.response?.error?.message;
            if (payload?.type === 'response.error' || payload?.type === 'response.failed' || errorMessage) {
                throw new Error(errorMessage || 'API stream error');
            }
            const update = extractUpdate(payload, endpoint);
            const next = mergeText(fullText, update.delta, update.snapshot);
            if (next !== fullText) {
                fullText = next;
                if (typeof options.onText === 'function') options.onText(fullText);
            }
        };
        const consumeEvent = block => {
            const event = parseEvent(block);
            if (!event.data || event.data === '[DONE]') return;
            sawEvent = true;
            const payload = JSON.parse(event.data);
            if (!payload.type && event.eventType) payload.type = event.eventType;
            applyPayload(payload);
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() || '';
            blocks.forEach(consumeEvent);
        }
        buffer += decoder.decode();
        if (buffer.trim()) {
            if (/^(?:event:|data:)/m.test(buffer)) consumeEvent(buffer);
            else if (!sawEvent) {
                try {
                    applyPayload(JSON.parse(buffer));
                } catch (error) {
                    if (error instanceof SyntaxError) {
                        fullText = buffer.trim();
                        if (typeof options.onText === 'function') options.onText(fullText);
                    } else {
                        throw error;
                    }
                }
            }
        }
        return { text: fullText, endpoint };
    }

    window.VoiceChatAPI = { buildPayload, streamText };
})();
