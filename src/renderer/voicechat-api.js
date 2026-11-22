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

    function buildResponsesInput(messages, forceStructured = false) {
        const filtered = (Array.isArray(messages) ? messages : []).filter(message => message?.role !== 'system');
        const hasImage = filtered.some(message => Array.isArray(message?.content)
            && message.content.some(part => part?.type === 'image_url' || part?.type === 'input_image'));
        if (!hasImage && !forceStructured) {
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

    // ---- Gemini 原生（generateContent） ----
    function toGeminiParts(content) {
        const parts = [];
        const pushText = text => {
            const value = String(text == null ? '' : text);
            if (value.trim()) parts.push({ text: value });
        };
        if (typeof content === 'string') { pushText(content); return parts; }
        if (!Array.isArray(content)) { pushText(content); return parts; }
        for (const part of content) {
            if (!part || typeof part !== 'object') continue;
            if (part.type === 'image_url' || part.type === 'input_image') {
                const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
                const value = String(url || '').trim();
                const dataUrl = value.match(/^data:([^;,]+);base64,(.+)$/s);
                if (dataUrl) parts.push({ inline_data: { mime_type: dataUrl[1], data: dataUrl[2] } });
                else if (value) parts.push({ file_data: { file_uri: value } });
                continue;
            }
            if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') pushText(part.text ?? '');
        }
        return parts;
    }

    function buildGeminiPayload(basePayload) {
        const messages = Array.isArray(basePayload?.messages) ? basePayload.messages : [];
        const contents = [];
        const systemTexts = [];
        for (const message of messages) {
            const role = String(message?.role || 'user');
            if (role === 'system' || role === 'developer') {
                const text = toGeminiParts(message.content).map(part => part.text || '').filter(Boolean).join('\n');
                if (text.trim()) systemTexts.push(text);
                continue;
            }
            const parts = toGeminiParts(message.content);
            if (!parts.length) continue;
            const geminiRole = role === 'assistant' || role === 'model' ? 'model' : 'user';
            const previous = contents[contents.length - 1];
            if (previous && previous.role === geminiRole) previous.parts.push(...parts);
            else contents.push({ role: geminiRole, parts });
        }
        const generationConfig = {};
        const maxTokens = Number(basePayload?.max_tokens);
        if (Number.isFinite(maxTokens) && maxTokens > 0) generationConfig.maxOutputTokens = Math.round(maxTokens);
        const temperature = Number(basePayload?.temperature);
        if (Number.isFinite(temperature)) generationConfig.temperature = temperature;
        const topP = Number(basePayload?.top_p);
        if (Number.isFinite(topP)) generationConfig.topP = topP;
        const payload = { contents };
        if (systemTexts.length) payload.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] };
        if (Object.keys(generationConfig).length) payload.generationConfig = generationConfig;
        return payload;
    }

    function geminiParts(payload) {
        const candidate = Array.isArray(payload?.candidates) ? payload.candidates[0] : null;
        return Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    }

    function extractGeminiUpdate(payload) {
        let delta = '';
        for (const part of geminiParts(payload)) {
            if (typeof part?.text === 'string' && part.thought !== true) delta += part.text;
        }
        return { delta };
    }

    function extractGeminiOutput(payload) {
        return geminiParts(payload)
            .filter(part => typeof part?.text === 'string' && part.thought !== true)
            .map(part => part.text).join('');
    }

    // ---- Ollama 原生（/api/chat） ----
    function buildOllamaPayload(basePayload) {
        const messages = (Array.isArray(basePayload?.messages) ? basePayload.messages : []).map(message => {
            const role = String(message?.role || 'user');
            const entry = { role: role === 'developer' ? 'system' : role, content: '' };
            const images = [];
            if (typeof message?.content === 'string') {
                entry.content = message.content;
            } else if (Array.isArray(message?.content)) {
                const texts = [];
                for (const part of message.content) {
                    if (!part || typeof part !== 'object') continue;
                    if (part.type === 'image_url' || part.type === 'input_image') {
                        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
                        const dataUrl = String(url || '').trim().match(/^data:([^;,]+);base64,(.+)$/s);
                        if (dataUrl) images.push(dataUrl[2]);
                    } else if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
                        const text = String(part.text ?? '');
                        if (text) texts.push(text);
                    }
                }
                entry.content = texts.join('\n');
            }
            if (images.length) entry.images = images;
            return entry;
        }).filter(message => String(message.content || '').trim() || message.images);
        const payload = { model: String(basePayload?.model || ''), messages, stream: true };
        const options = {};
        const temperature = Number(basePayload?.temperature);
        if (Number.isFinite(temperature)) options.temperature = temperature;
        const topP = Number(basePayload?.top_p);
        if (Number.isFinite(topP)) options.top_p = topP;
        const maxTokens = Number(basePayload?.max_tokens);
        if (Number.isFinite(maxTokens) && maxTokens > 0) options.num_predict = Math.round(maxTokens);
        if (Object.keys(options).length) payload.options = options;
        return payload;
    }

    function extractOllamaUpdate(payload) {
        const content = payload?.message?.content;
        return { delta: typeof content === 'string' ? content : '' };
    }

    function buildPayload(basePayload, endpoint, { structuredInput = false } = {}) {
        if (endpoint === '/gemini') return buildGeminiPayload(basePayload);
        if (endpoint === '/ollama') return buildOllamaPayload(basePayload);
        if (endpoint === '/v1/messages' || endpoint === '/messages') return buildMessagesPayload(basePayload);
        if (endpoint !== '/responses') return basePayload;
        const messages = Array.isArray(basePayload?.messages) ? basePayload.messages : [];
        const systemMessage = messages.find(message => message?.role === 'system');
        const { messages: _, max_tokens, prompt_cache_key, cache_control, ...rest } = basePayload;
        return {
            ...rest,
            input: buildResponsesInput(messages, structuredInput),
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
        if (endpoint === '/gemini') return extractGeminiUpdate(payload);
        if (endpoint === '/ollama') return extractOllamaUpdate(payload);
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
        const SUPPORTED_ENDPOINTS = ['/responses', '/chat/completions', '/v1/messages', '/gemini', '/ollama'];
        const nativeEndpoint = endpoint => endpoint === '/gemini' || endpoint === '/ollama';
        const preferredEndpoint = SUPPORTED_ENDPOINTS.includes(options.endpoint) ? options.endpoint : '/responses';
        const memory = window.AIUIMemory;
        const transport = window.AIUIMemoryTransport;
        const memoryContext = options.memoryChat && transport ? memory?.getContext(options.memoryChat) : '';
        const tool = memoryContext ? memory.getTool() : null;
        const basePayload = options.payload;
        const messages = basePayload.messages || [];
        const payload = memoryContext
            ? {
                ...basePayload,
                messages: messages[0]?.role === 'system'
                    ? [{ ...messages[0], content: [messages[0].content, memoryContext].filter(Boolean).join('\n\n') }, ...messages.slice(1)]
                    : [{ role: 'system', content: memoryContext }, ...messages]
            } : basePayload;
        const send = (endpoint, body) => {
            const headers = {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${options.apiKey || ''}`
            };
            if (endpoint === '/v1/messages') {
                headers['anthropic-version'] = '2023-06-01';
                if (options.apiKey) headers['x-api-key'] = options.apiKey;
            }
            if (endpoint === '/gemini' && options.apiKey) headers['x-goog-api-key'] = options.apiKey;
            if (endpoint === '/ollama' && !options.apiKey) delete headers.Authorization;
            const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
            const requestUrl = endpoint === '/gemini'
                ? `${baseUrl}/models/${encodeURIComponent(String(options.payload?.model || '').replace(/^models\//, ''))}:streamGenerateContent?alt=sse`
                : endpoint === '/ollama' ? `${baseUrl}/api/chat` : `${baseUrl}${endpoint}`;
            return fetch(requestUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: options.signal
            });
        };
        async function request(endpoint) {
            const base = buildPayload(payload, endpoint, { structuredInput: Boolean(tool) });
            if (!tool) return { response: await send(endpoint, base) };
            const body = transport.declareTool(base, endpoint, tool);
            const response = await send(endpoint, body);
            if (await transport.isUnsupportedToolError(response)) {
                return { response: await send(endpoint, buildPayload(payload, endpoint)) };
            }
            return { response, body };
        }

        let endpoint = preferredEndpoint;
        let turn = await request(endpoint);
        if (turn.response.status === 501 && !nativeEndpoint(preferredEndpoint)) {
            // A 501 means the relay does not implement that path at all, so walk the
            // remaining protocols in turn before giving up.
            await turn.response.text().catch(() => '');
            for (const candidate of SUPPORTED_ENDPOINTS.filter(item => item !== preferredEndpoint)) {
                endpoint = candidate;
                if (typeof options.onFallback === 'function') options.onFallback(endpoint);
                turn = await request(endpoint);
                if (turn.response.status !== 501) break;
                await turn.response.text().catch(() => '');
            }
        }
        const collector = tool ? transport.createCollector(endpoint) : null;
        const readOptions = { ...options, privateProtocol: Boolean(tool) };
        const read = (response, privateCollector) => readTextResponse(response, endpoint, readOptions, privateCollector).catch(error => {
            if (tool && error instanceof SyntaxError) throw new Error('模型返回了无效的响应格式');
            throw error;
        });
        const { text, wireText } = await read(turn.response, collector);
        if (!collector || options.signal?.aborted) return { text, endpoint };
        const calls = collector.finish(wireText, memory.isCall);
        if (!calls.length) return { text, endpoint };
        const results = memory.applyCalls(calls);
        const activity = memory.summarizeResults(results);
        if (activity) options.onMemoryActivity?.(activity);
        if (text.trim() || !turn.body) return { text, endpoint };
        const followUp = collector.continuation(turn.body, calls, results);
        if (!followUp) return { text, endpoint };
        return { text: (await read(await send(endpoint, followUp))).text, endpoint };
    }

    async function readTextResponse(response, endpoint, options, collector) {
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`LLM API 错误 (${response.status})${detail && !options.privateProtocol ? `: ${detail.slice(0, 300)}` : ''}`);
        }

        const reader = response.body?.getReader();
        let wireText = '';
        let text = '';
        const publish = (streaming = false) => {
            const visible = window.AIUIMemoryTransport.visibleText(wireText, { streaming });
            if (visible === text) return;
            text = visible;
            options.onText?.(text);
        };
        if (!reader) {
            const payload = await response.json();
            collector?.ingest(payload);
            wireText = endpoint === '/chat/completions'
                ? extractText(payload?.choices?.[0]?.message?.content)
                : endpoint === '/gemini' ? extractGeminiOutput(payload)
                    : endpoint === '/ollama' ? extractText(payload?.message?.content)
                        : (endpoint === '/v1/messages' ? extractMessagesOutput(payload) : extractResponsesOutput(payload));
            publish();
            return { text, wireText };
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let sawEvent = false;
        const applyPayload = payload => {
            const errorMessage = payload?.error?.message || payload?.response?.error?.message;
            if (payload?.type === 'response.error' || payload?.type === 'response.failed' || errorMessage) {
                throw new Error(!options.privateProtocol && errorMessage ? errorMessage : '模型回复中断');
            }
            collector?.ingest(payload);
            const update = extractUpdate(payload, endpoint);
            const next = mergeText(wireText, update.delta, update.snapshot);
            if (next !== wireText) {
                wireText = next;
                publish(true);
            }
        };
        const ndjsonStream = endpoint === '/ollama';
        const consumeLine = line => {
            const text = String(line || '').trim();
            if (!text || text === '[DONE]') return;
            sawEvent = true;
            applyPayload(JSON.parse(text));
        };
        const consumeEvent = block => {
            const event = parseEvent(block);
            if (!event.data) return;
            if (event.data === '[DONE]') {
                collector?.endStream();
                return;
            }
            sawEvent = true;
            const payload = JSON.parse(event.data);
            if (!payload.type && event.eventType) payload.type = event.eventType;
            applyPayload(payload);
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = ndjsonStream ? buffer.split(/\r?\n/) : buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() || '';
            if (ndjsonStream) blocks.forEach(consumeLine);
            else blocks.forEach(consumeEvent);
        }
        buffer += decoder.decode();
        if (buffer.trim()) {
            if (ndjsonStream) {
                try { consumeLine(buffer); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
            } else if (/^(?:event:|data:)/m.test(buffer)) consumeEvent(buffer);
            else if (!sawEvent) {
                try {
                    applyPayload(JSON.parse(buffer));
                } catch (error) {
                    if (error instanceof SyntaxError && !options.privateProtocol) {
                        wireText = buffer.trim();
                    } else {
                        throw error;
                    }
                }
            }
        }
        publish();
        return { text, wireText };
    }

    window.VoiceChatAPI = { buildPayload, streamText };
})();
