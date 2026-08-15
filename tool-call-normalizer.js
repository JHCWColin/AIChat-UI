(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.ToolCallNormalizer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    /**
     * @typedef {Object} NormalizedToolCall
     * @property {string=} id
     * @property {string} name
     * @property {Record<string, any>} arguments
     */

    function isRecord(value) {
        return Boolean(value && typeof value === "object" && !Array.isArray(value));
    }

    function parseArguments(value) {
        if (isRecord(value)) return value;
        if (value === undefined || value === null || value === "") return {};
        if (typeof value !== "string") return {};
        const source = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        const candidates = [source, ...scanJsonValues(source).map(item => item.raw)];
        for (const candidate of candidates) {
            try {
                const parsed = JSON.parse(candidate);
                if (isRecord(parsed)) return parsed;
                if (typeof parsed === "string" && parsed !== candidate) {
                    const nested = parseArguments(parsed);
                    if (isRecord(nested) && Object.keys(nested).length) return nested;
                }
            } catch (_) { /* try the next candidate */ }
        }
        return {};
    }

    function scanJsonValues(text) {
        const source = String(text || "");
        const values = [];
        let start = -1;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let index = 0; index < source.length; index += 1) {
            const char = source[index];
            if (inString) {
                if (escaped) escaped = false;
                else if (char === "\\") escaped = true;
                else if (char === '"') inString = false;
                continue;
            }
            if (char === '"') { inString = true; continue; }
            if (char === "{" || char === "[") {
                if (depth === 0) start = index;
                depth += 1;
            } else if ((char === "}" || char === "]") && depth > 0) {
                depth -= 1;
                if (depth === 0 && start >= 0) {
                    values.push({ start, end: index + 1, raw: source.slice(start, index + 1) });
                    start = -1;
                }
            }
        }
        return values;
    }

    function makeCall(name, args, id) {
        const normalizedName = typeof name === "string" ? name.trim() : "";
        if (!normalizedName) return null;
        const call = { name: normalizedName, arguments: parseArguments(args) };
        if (id !== undefined && id !== null && String(id).trim()) call.id = String(id).trim();
        return call;
    }

    function callsFromClaude(value) {
        const items = Array.isArray(value) ? value : (isRecord(value) && value.type === "tool_use" ? [value] : []);
        return items.filter(item => item?.type === "tool_use")
            .map(item => makeCall(item.name, item.input, item.id)).filter(Boolean);
    }

    function callsFromGemini(value) {
        if (!isRecord(value?.functionCall)) return [];
        const call = makeCall(value.functionCall.name, value.functionCall.args, value.functionCall.id);
        return call ? [call] : [];
    }

    function callsFromGeneric(value) {
        if (!isRecord(value)) return [];
        if (value.tool_call) {
            const nested = isRecord(value.tool_call) ? value.tool_call : { name: value.tool_call, arguments: value.arguments };
            const call = makeCall(nested.name, nested.arguments ?? nested.args, nested.id || value.id);
            return call ? [call] : [];
        }
        if (typeof value.tool === "string") {
            const call = makeCall(value.tool, value.args ?? value.arguments, value.id);
            return call ? [call] : [];
        }
        if (typeof value.name === "string" && (value.arguments !== undefined || value.args !== undefined || value.input !== undefined)) {
            const call = makeCall(value.name, value.arguments ?? value.args ?? value.input, value.id || value.call_id);
            return call ? [call] : [];
        }
        return [];
    }

    function dedupe(calls) {
        const seen = new Set();
        return calls.filter(call => {
            const key = `${call.id || ""}|${call.name}|${JSON.stringify(call.arguments)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function collectOpenAIToolCalls(values) {
        const entries = [];
        for (const value of values) {
            if (!isRecord(value)) continue;
            const containers = [value, value.message, value.delta];
            for (const choice of Array.isArray(value.choices) ? value.choices : []) {
                containers.push(choice, choice?.message, choice?.delta);
            }
            for (const container of containers) {
                if (!isRecord(container) || !Array.isArray(container.tool_calls)) continue;
                container.tool_calls.forEach((item, position) => entries.push({ item, position }));
            }
        }
        const merged = new Map();
        entries.forEach(({ item, position }) => {
            if (!isRecord(item)) return;
            const fn = isRecord(item.function) ? item.function : item;
            const key = String(item.index ?? item.id ?? item.call_id ?? position);
            const current = merged.get(key) || { id: item.id || item.call_id, name: "", args: "", argsObject: null };
            if (item.id || item.call_id) current.id = item.id || item.call_id;
            if (typeof fn.name === "string") {
                if (!current.name || fn.name.startsWith(current.name)) current.name = fn.name;
                else if (!current.name.endsWith(fn.name)) current.name += fn.name;
            }
            const args = fn.arguments ?? fn.args ?? item.arguments ?? item.args;
            if (isRecord(args)) current.argsObject = args;
            else if (typeof args === "string") {
                if (!current.args || args.startsWith(current.args)) current.args = args;
                else if (!current.args.endsWith(args)) current.args += args;
            }
            merged.set(key, current);
        });
        return [...merged.values()].map(item => makeCall(item.name, item.argsObject || item.args, item.id)).filter(Boolean);
    }

    function collectResponsesCalls(values) {
        const merged = new Map();
        let sequence = 0;
        const mergeItem = (item, fallbackKey) => {
            if (!isRecord(item) || item.type !== "function_call") return;
            const key = String(item.id || item.call_id || fallbackKey);
            const current = merged.get(key) || { id: item.call_id || item.id, name: "", args: "", argsObject: null };
            if (item.call_id || item.id) current.id = item.call_id || item.id;
            if (typeof item.name === "string") current.name = item.name;
            if (isRecord(item.arguments ?? item.args)) current.argsObject = item.arguments ?? item.args;
            else if (typeof (item.arguments ?? item.args) === "string") current.args = item.arguments ?? item.args;
            merged.set(key, current);
        };
        for (const value of values) {
            if (!isRecord(value)) continue;
            for (const item of Array.isArray(value.output) ? value.output : []) mergeItem(item, sequence += 1);
            for (const item of Array.isArray(value.response?.output) ? value.response.output : []) mergeItem(item, sequence += 1);
            const itemKey = value.output_index ?? (sequence += 1);
            mergeItem(value.item, itemKey);
            if (value.type === "response.function_call_arguments.delta" || value.type === "response.function_call_arguments.done") {
                const key = String(value.call_id || value.item_id || value.output_index || "0");
                const current = merged.get(key) || { id: value.call_id || value.item_id, name: "", args: "", argsObject: null };
                if (value.type.endsWith(".done") && typeof value.arguments === "string") current.args = value.arguments;
                else if (typeof value.delta === "string") current.args += value.delta;
                merged.set(key, current);
            }
        }
        return [...merged.values()].map(item => makeCall(item.name, item.argsObject || item.args, item.id)).filter(Boolean);
    }

    function collectClaudeCalls(values) {
        const calls = [];
        for (const value of values) {
            if (!isRecord(value)) continue;
            calls.push(...callsFromClaude(value), ...callsFromClaude(value.content), ...callsFromClaude(value.message?.content));
        }
        return calls;
    }

    function collectGeminiCalls(values) {
        const calls = [];
        for (const value of values) {
            if (!isRecord(value)) continue;
            calls.push(...callsFromGemini(value), ...callsFromGemini(value.delta));
            for (const candidate of Array.isArray(value.candidates) ? value.candidates : []) {
                for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) calls.push(...callsFromGemini(part));
            }
        }
        return calls;
    }

    function normalizeStructured(input) {
        const values = Array.isArray(input) ? input : [input];
        const openAI = collectOpenAIToolCalls(values);
        const responses = collectResponsesCalls(values);
        const claude = collectClaudeCalls(values);
        const gemini = collectGeminiCalls(values);
        const generic = [];
        for (const value of values) {
            if (!isRecord(value)) continue;
            generic.push(...callsFromGeneric(value));
            if (isRecord(value.message)) {
                generic.push(...callsFromGeneric(value.message));
            }
        }
        // Detection order is part of the public contract.
        for (const group of [openAI, responses, claude, gemini, generic]) {
            if (group.length) return dedupe(group);
        }
        return [];
    }

    function classifyStructured(value) {
        const values = Array.isArray(value) ? value : [value];
        const groups = [
            collectOpenAIToolCalls(values),
            collectResponsesCalls(values),
            collectClaudeCalls(values),
            collectGeminiCalls(values),
            values.flatMap(item => isRecord(item) ? callsFromGeneric(item) : [])
        ];
        const priority = groups.findIndex(group => group.length > 0);
        return { priority, calls: priority >= 0 ? dedupe(groups[priority]) : [] };
    }

    function cleanText(value) {
        return String(value || "")
            .replace(/<\/?json\b[^>]*>/gi, "")
            .replace(/&lt;\/?json\b[^&]*&gt;/gi, "")
            .replace(/```(?:json)?/gi, "")
            .replace(/<\/?tool_call\b[^>]*>/gi, "")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    function parseText(text) {
        const source = String(text || "");
        if (/^\s*"(?:\\.|[^"\\])*"\s*$/.test(source)) {
            try {
                const decoded = JSON.parse(source);
                if (typeof decoded === "string" && decoded !== source) return parseText(decoded);
            } catch (_) { /* continue with the original text */ }
        }
        const found = [];
        const add = (call, start, end) => { if (call) found.push({ call, start, end }); };

        let structuredPriority = Infinity;
        for (const candidate of scanJsonValues(source)) {
            let parsed;
            try { parsed = JSON.parse(candidate.raw); } catch (_) { continue; }
            const classified = classifyStructured(parsed);
            if (!classified.calls.length) continue;
            structuredPriority = Math.min(structuredPriority, classified.priority);
            let start = candidate.start;
            let end = candidate.end;
            const prefix = source.slice(0, start).match(/<tool_call\b[^>]*>\s*$/i);
            const suffix = source.slice(end).match(/^\s*<\/tool_call>/i);
            if (prefix && suffix) {
                start -= prefix[0].length;
                end += suffix[0].length;
            }
            classified.calls.forEach(call => add({ ...call, _priority: classified.priority }, start, end));
        }
        const xml = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi;
        let match;
        while ((match = xml.exec(source))) {
            const calls = parseText(match[1]).calls;
            calls.forEach(call => add({ ...call, _priority: 5 }, match.index, xml.lastIndex));
        }
        const action = /(?:^|\n)\s*Action\s*:\s*([^\r\n]+)\s*\r?\n\s*Action\s*Input\s*:\s*([\s\S]*?)(?=\r?\n\s*(?:Action\s*:|$)|$)/gi;
        while ((match = action.exec(source))) add({ ...makeCall(match[1], match[2]), _priority: 6 }, match.index, action.lastIndex);

        if (structuredPriority < Infinity) {
            for (let index = found.length - 1; index >= 0; index -= 1) {
                if (found[index].call._priority !== structuredPriority) found.splice(index, 1);
            }
        } else if (found.length) {
            const textPriority = Math.min(...found.map(item => item.call._priority ?? 6));
            for (let index = found.length - 1; index >= 0; index -= 1) {
                if ((found[index].call._priority ?? 6) !== textPriority) found.splice(index, 1);
            }
        }

        found.sort((a, b) => a.start - b.start);
        const unique = [];
        const keys = new Set();
        for (const item of found) {
            const key = `${item.start}:${item.end}:${item.call.name}:${JSON.stringify(item.call.arguments)}`;
            if (!keys.has(key)) { keys.add(key); unique.push(item); }
        }
        const segments = [];
        const emittedCalls = [];
        let cursor = 0;
        for (const item of unique) {
            if (item.start < cursor) continue;
            const before = cleanText(source.slice(cursor, item.start));
            if (before) segments.push({ type: "text", text: before });
            const call = { ...item.call };
            delete call._priority;
            segments.push({ type: "tool_call", call });
            emittedCalls.push(call);
            cursor = Math.max(cursor, item.end);
        }
        const tail = cleanText(source.slice(cursor));
        if (tail) segments.push({ type: "text", text: tail });
        return { calls: emittedCalls, segments, text: segments.filter(item => item.type === "text").map(item => item.text).join("\n\n") };
    }

    function normalize(input) {
        if (typeof input === "string") return parseText(input).calls;
        return normalizeStructured(input);
    }

    function parseAgentResponse(text, structuredCalls) {
        const calls = Array.isArray(structuredCalls) && structuredCalls.length ? structuredCalls : parseText(text).calls;
        if (Array.isArray(structuredCalls) && structuredCalls.length) {
            const prose = String(text || "").trim();
            return { calls, segments: [...(prose ? [{ type: "text", text: prose }] : []), ...calls.map(call => ({ type: "tool_call", call }))], text: prose };
        }
        return parseText(text);
    }

    return {
        normalize,
        normalizeToolCall: input => normalize(input)[0] || null,
        normalizeToolCalls: normalize,
        parseText,
        parseAgentResponse,
        parseArguments
    };
});
