/* The two Context views share the single returned breakdown. No UI recounts it. */
(function() {
    const apiFailures = new Map();
    const apiCounts = new Map();
    async function countAt(url,body,headers,label,model) {
        const key = `${url}:${model}:${getAPIKey()}`;
        const serialized = JSON.stringify(body), cacheKey = `${key}:${serialized}`;
        if (apiCounts.has(cacheKey)) return apiCounts.get(cacheKey);
        if (Date.now()-(apiFailures.get(key) || 0)<60000) return null;
        try {
            const response = await fetch(url,{ method:'POST',headers,body:serialized,signal:AbortSignal.timeout(5000) });
            if (!response.ok) throw new Error(`count API ${response.status}`);
            const data = await response.json();
            const count = data.input_tokens ?? data.totalTokens ?? (Array.isArray(data.token_ids) ? data.token_ids.length : null);
            if (!Number.isFinite(count) || count < 0) throw new Error('invalid count response');
            const result = { count,label }; apiCounts.set(cacheKey,result);
            if (apiCounts.size>32) apiCounts.delete(apiCounts.keys().next().value);
            return result;
        } catch (_) { apiFailures.set(key,Date.now()); return null; }
    }
    async function officialCount(messages, model) {
        const base = new URL(getBaseURL());
        const name = String(model).split('/').pop();
        const textContent = content => typeof content === 'string' ? content : (content || []).filter(p => ['text','input_text','output_text'].includes(p.type)).map(p => p.text || '').join('\n');
        let url, body, headers = { 'Content-Type':'application/json' }, label;
        const text = messages.map(m => textContent(m.content)).join('\n');
        if (/^claude[-_]/i.test(name)) {
            // Includes Sonnet/Opus/Fable releases, snapshots and relay aliases.
            // Keep relay model IDs intact; only official Anthropic uses the bare ID.
            const countingModel = /(^|\.)anthropic\.com$/i.test(base.hostname) ? name : model;
            const clean = base.href.replace(/\/$/,'').replace(/\/(?:messages(?:\/count_tokens)?|chat\/completions|responses)$/i,'');
            const root = clean.replace(/\/v1$/i,'');
            const endpoints = [...new Set([`${root}/v1/messages/count_tokens`,`${root}/messages/count_tokens`])];
            const native = buildMessagesPayloadFromBase({ model:countingModel,messages });
            body = { model:countingModel,messages:native.messages,...(native.system ? { system:native.system }:{}) };
            headers['x-api-key'] = getAPIKey(); headers['anthropic-version'] = '2023-06-01';
            if (!/(^|\.)anthropic\.com$/i.test(base.hostname)) headers.Authorization = `Bearer ${getAPIKey()}`;
            headers['anthropic-dangerous-direct-browser-access'] = 'true';
            label = 'Anthropic count_tokens API';
            for (const endpoint of endpoints) {
                const counted = await countAt(endpoint,body,headers,label,model);
                if (counted) return counted;
            }
            return null;
        } else if (/^gemini-/i.test(name)) {
            const root = base.href.replace(/\/(?:v1beta|v1)(?:\/openai)?\/?$/, '').replace(/\/$/, '');
            url = `${root}/v1beta/models/${encodeURIComponent(name)}:countTokens`;
            const toParts = content => typeof content === 'string' ? [{ text:content || ' ' }] : (content || []).flatMap(part => {
                if (part.text) return [{ text:part.text }];
                const url = part.image_url?.url || part.image_url; const image = typeof url === 'string' && url.match(/^data:([^;]+);base64,(.*)$/s);
                return image ? [{ inlineData:{ mimeType:image[1],data:image[2] } }]:[];
            });
            body = { contents:messages.filter(m => m.role !== 'system').map(m => ({ role:m.role === 'assistant' ? 'model':'user', parts:toParts(m.content) })) };
            const system = messages.filter(m => m.role === 'system').map(m => textContent(m.content)).join('\n');
            if (system) body.systemInstruction = { parts:[{ text:system }] };
            headers['x-goog-api-key'] = getAPIKey(); label = 'Gemini countTokens API';
        } else if (/^grok-/i.test(name)) {
            const root = base.href.replace(/\/(?:v1)?\/?$/, '').replace(/\/$/, '');
            url = `${root}/v1/tokenize-text`; body = { text, model };
            headers.Authorization = `Bearer ${getAPIKey()}`; label = 'xAI tokenize-text API';
        } else if (/^(?:gpt-|o[134](?:-|$))/i.test(name)) {
            const root = base.href.replace(/\/(?:v1)?\/?$/, '').replace(/\/$/, '');
            url = `${root}/v1/responses/input_tokens`;
            const native = buildRequestPayloadForEndpoint({ model,messages,__aiuiStructuredResponsesInput:true },'/responses');
            body = { model,input:native.input,...(native.instructions ? { instructions:native.instructions }:{}) };
            headers.Authorization = `Bearer ${getAPIKey()}`; label = 'OpenAI input_tokens API';
        } else return null;
        // An unavailable counting endpoint must not flood a relay on every keystroke.
        return countAt(url,body,headers,label,model);
    }
    window.estimateContextAccurately = async (messages, options) => {
        const texts = new Set();
        await AIUIContextEstimator.estimate(messages, { ...options, tokenizer:{ count:text => { texts.add(text); return 0; } } });
        const source = [...texts];
        let result;
        try { result = await window.electronAPI?.countContextBatch(source, options.model); } catch (_) { /* browser/worker fallback */ }
        const counts = new Map(source.map((text,index) => [text,result?.counts[index]]));
        const breakdown = await AIUIContextEstimator.estimate(messages, { ...options, tokenizer:result ? { count:text => counts.get(text), describe:() => result.label } : null });
        breakdown.generic = result ? result.generic : true;
        // Accurate local vocabularies always win. Modern Claude/Gemini/Grok have
        // no published compatible local vocabulary, so try their counting API.
        if (breakdown.generic && getAPIKey()) {
            const counted = await officialCount(messages, options.model);
            if (counted) {
                const scale = breakdown.usedTokens > 0 ? counted.count / breakdown.usedTokens : 0;
                breakdown.usedTokens = counted.count;
                for (const key of Object.keys(breakdown.categories)) breakdown.categories[key] = Math.round(breakdown.categories[key] * scale);
                breakdown.freeTokens = Math.max(0, options.contextWindow - counted.count - breakdown.reserveTokens);
                breakdown.categoryEntries = breakdown.categoryEntries.map(entry => ({ ...entry, tokens:entry.key === 'freeSpace' ? breakdown.freeTokens : entry.key === 'compactionBuffer' ? breakdown.reserveTokens : Math.round(entry.tokens * scale) }));
                breakdown.usedPercent = Math.min(100, Math.round(counted.count/options.contextWindow*100));
                breakdown.overWindow = counted.count + breakdown.reserveTokens > options.contextWindow;
                breakdown.tokenizerLabel = counted.label;
                breakdown.generic = false;
            }
        }
        return breakdown;
    };
})();
