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
        const source = decodeEntities(value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim());
        const xmlArguments = parseXmlArguments(source);
        if (xmlArguments && Object.keys(xmlArguments).length) return xmlArguments;
        const candidates = [source, ...scanJsonValues(source).map(item => item.raw)];
        for (const candidate of candidates) {
            try {
                const parsed = parseJsonValue(candidate);
                if (parsed === null) continue;
                if (isRecord(parsed)) return parsed;
                if (typeof parsed === "string" && parsed !== candidate) {
                    const nested = parseArguments(parsed);
                    if (isRecord(nested) && Object.keys(nested).length) return nested;
                }
            } catch (_) { /* try the next candidate */ }
        }
        return {};
    }

    function decodeEntities(value) {
        return String(value || "")
            .replace(/&quot;/gi, '"').replace(/&#34;/g, '"')
            .replace(/&apos;|&#39;/gi, "'").replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">").replace(/&amp;/gi, "&");
    }

    function normalizeJsonPunctuation(value) {
        return String(value || "")
            .replace(/[｛]/g, "{").replace(/[｝]/g, "}")
            .replace(/[［]/g, "[").replace(/[］]/g, "]")
            .replace(/[：]/g, ":").replace(/[，]/g, ",")
            .replace(/[“”＂]/g, '"');
    }

    function parseJsonValue(value) {
        const source = String(value || "").replace(/^\uFEFF/, "").trim();
        try { return JSON.parse(source); } catch (_) {
            const normalized = normalizeJsonPunctuation(source);
            if (normalized === source) return null;
            try { return JSON.parse(normalized); } catch (_) { return null; }
        }
    }

    function parseXmlArguments(source) {
        const text = String(source || "").trim();
        const result = {};
        const parameter = /<(?:parameter|arg|argument)(?:\s*=\s*["']?([^\s"'>]+)["']?|\s+(?:name|key)\s*=\s*["']?([^\s"'>]+)["']?)\s*>([\s\S]*?)<\/(?:parameter|arg|argument)>/gi;
        let match;
        while ((match = parameter.exec(text))) {
            const key = decodeEntities(match[1] || match[2]).trim();
            if (!key) continue;
            const raw = decodeEntities(match[3]).trim();
            result[key] = parseScalar(raw);
        }
        if (Object.keys(result).length) return result;
        const namedParameter = /<(?:parameter|arg|argument)\s+([^>]+)>([\s\S]*?)<\/(?:parameter|arg|argument)>/gi;
        while ((match = namedParameter.exec(text))) {
            const attrs = match[1].match(/(?:name|key)\s*=\s*["']([^"']+)["']/i);
            if (!attrs) continue;
            result[decodeEntities(attrs[1]).trim()] = parseScalar(decodeEntities(match[2]).trim());
        }
        return result;
    }

    function parseScalar(value) {
        const text = String(value || "").trim();
        if (!text) return "";
        try { return JSON.parse(text); } catch (_) { return text; }
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
            if (char === '"' || char === '＂' || char === '“' || char === '”') { inString = true; continue; }
            if (char === "{" || char === "[" || char === "｛" || char === "［") {
                if (depth === 0) start = index;
                depth += 1;
            } else if ((char === "}" || char === "]" || char === "｝" || char === "］") && depth > 0) {
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
        if (isRecord(value.function_call)) {
            const nested = value.function_call;
            const call = makeCall(nested.name, nested.arguments ?? nested.args, nested.id || nested.call_id || value.id);
            return call ? [call] : [];
        }
        if (isRecord(value.functionCall)) return callsFromGemini(value);
        if (isRecord(value.function)) {
            const nested = value.function;
            const call = makeCall(nested.name, nested.arguments ?? nested.args, nested.id || value.id);
            return call ? [call] : [];
        }
        const routedName = value.tool_name || value.toolName || value.recipient || value.function_name;
        if (typeof routedName === "string") {
            const routedArgs = value.arguments ?? value.args ?? value.input ?? value.parameters ?? value.action;
            const call = makeCall(routedName, routedArgs, value.id || value.call_id);
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
            if (!isRecord(item) || !["function_call", "custom_tool_call"].includes(item.type)) return;
            const key = String(item.id || item.call_id || fallbackKey);
            const current = merged.get(key) || { id: item.call_id || item.id, name: "", args: "", argsObject: null, custom: item.type === "custom_tool_call" };
            if (item.type === "custom_tool_call") current.custom = true;
            if (item.call_id || item.id) current.id = item.call_id || item.id;
            if (typeof item.name === "string") current.name = item.name;
            const rawArgs = item.type === "custom_tool_call" ? (item.input ?? item.arguments ?? item.args) : (item.arguments ?? item.args);
            if (isRecord(rawArgs)) current.argsObject = rawArgs;
            else if (typeof rawArgs === "string") {
                if (item.type === "custom_tool_call" && rawArgs.trim()) current.argsObject = { input: rawArgs };
                else current.args = rawArgs;
            }
            merged.set(key, current);
        };
        for (const value of values) {
            if (!isRecord(value)) continue;
            mergeItem(value, sequence += 1);
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
            if (value.type === "response.custom_tool_call_input.delta" || value.type === "response.custom_tool_call_input.done") {
                const key = String(value.call_id || value.item_id || value.output_index || "0");
                const current = merged.get(key) || { id: value.call_id || value.item_id, name: value.name || "", args: "", argsObject: null, custom: true };
                current.custom = true;
                if (value.name && !current.name) current.name = value.name;
                if (value.type.endsWith(".done") && typeof value.input === "string") current.args = value.input;
                else if (typeof value.delta === "string") current.args += value.delta;
                merged.set(key, current);
            }
        }
        return [...merged.values()].map(item => makeCall(item.name, item.argsObject || (item.custom && item.args ? { input: item.args } : item.args), item.id)).filter(Boolean);
    }

    function collectClaudeCalls(values) {
        const calls = [];
        for (const value of values) {
            if (!isRecord(value)) continue;
            calls.push(...callsFromClaude(value), ...callsFromClaude(value.content), ...callsFromClaude(value.message?.content));
        }
        return calls;
    }

    function collectClaudeStreamCalls(values) {
        const merged = new Map();
        let sequence = 0;
        for (const value of values) {
            if (!isRecord(value)) continue;
            const block = value.content_block || value.block;
            if (value.type === "content_block_start" && isRecord(block) && block.type === "tool_use") {
                const key = String(value.index ?? block.id ?? (++sequence));
                const item = { id: block.id, name: block.name || "", argsObject: isRecord(block.input) && Object.keys(block.input).length ? block.input : null, args: "" };
                merged.set(key, item);
                if (block.id) merged.set(String(block.id), item);
            }
            if (value.type === "content_block_delta" && isRecord(value.delta)) {
                const key = String(value.id || value.index || value.block_index || "0");
                const current = merged.get(key) || { id: value.id, name: "", argsObject: null, args: "" };
                if (typeof value.delta.partial_json === "string") current.args += value.delta.partial_json;
                merged.set(key, current);
            }
        }
        return [...new Set(merged.values())].map(item => makeCall(item.name, item.argsObject || item.args, item.id)).filter(Boolean);
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
        const claudeStream = collectClaudeStreamCalls(values);
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
        for (const group of [openAI, responses, claude, claudeStream, gemini, generic]) {
            if (group.length) return dedupe(group);
        }
        return [];
    }

    function classifyStructured(value) {
        const values = Array.isArray(value) ? value : [value];
        const groups = [
            collectOpenAIToolCalls(values),
            collectResponsesCalls(values),
            collectClaudeCalls(values), collectClaudeStreamCalls(values),
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
            .replace(/<\/?function(?:\s*=\s*[^>]+)?\b[^>]*>/gi, "")
            .replace(/<\/?(?:parameter|arg|argument)(?:\s+[^>]*)?>/gi, "")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    // Reasoning/scratchpad channels are never executable output.  Some relays
    // flatten them into the text stream, so remove those sections before any
    // JSON/XML tool-call detection takes place.
    function stripReasoningSections(value) {
        let source = String(value || "");
        source = source.replace(/<(think|thinking|analysis|reasoning|reflection|scratchpad)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
        source = source.replace(/<(think|thinking|analysis|reasoning|reflection|scratchpad)\b[^>]*>[\s\S]*$/gi, "");
        source = source.replace(/```(?:think|thinking|analysis|reasoning)\b[\s\S]*?```/gi, "");
        // Harmony/Codex channel markers occasionally arrive in plain text.
        source = source.replace(/<\|channel\|>\s*(?:analysis|thinking|reasoning)\b[\s\S]*?(?=<\|channel\|>\s*(?:final|commentary|tool|functions?)\b|$)/gi, "");
        source = source.replace(/<\|(analysis|thinking|reasoning)\|>[\s\S]*?(?=<\|(?:final|commentary|tool|functions?)\|>|$)/gi, "");
        return source;
    }

    function extractToolCallEvidence(value, maxLength = 2000) {
        const source = normalizeJsonPunctuation(stripReasoningSections(value)).trim();
        if (!source) return "";
        const candidates = [];
        for (const item of scanJsonValues(source)) {
            if (/\b(?:tool_call|tool_calls|function_call|functionCall|tool_name|recipient|arguments|args)\b/i.test(item.raw)) candidates.push(item.raw);
        }
        const xml = source.match(/<(?:tool_call|function|tool|recipient)\b[\s\S]*?(?:<\/\s*(?:tool_call|function|tool|recipient)>|$)/i);
        if (xml) candidates.push(xml[0]);
        const action = source.match(/(?:^|\n)\s*Action\s*:[\s\S]*?(?:\n\s*Action\s*Input\s*:[\s\S]*?(?=\n\s*Action\s*:|$)|$)/i);
        if (action) candidates.push(action[0].trim());
        const evidence = candidates.length ? candidates.join("\n") : source;
        return evidence.length > maxLength ? `${evidence.slice(0, maxLength)}\n…(已截断)` : evidence;
    }

    function hasMalformedToolCall(value) {
        const source = normalizeJsonPunctuation(stripReasoningSections(value));
        return /(?:"tool_call"\s*:|"tool_calls"\s*:|"function_call"\s*:|<tool_call\b|<function\s*=|<tool\s*=|(?:^|\n)\s*(?:to|recipient)\s*[=:])/i.test(source);
    }

    function diagnoseToolCallResponse(value) {
        const source = normalizeJsonPunctuation(stripReasoningSections(value)).replace(/^\uFEFF/, "").trim();
        const evidence = extractToolCallEvidence(source, 4000);
        const markers = hasMalformedToolCall(source);
        let issue = "no_tool_call";
        let location = "response";
        let suggestion = "Return one standalone JSON object per tool call using the required tool_call wrapper; include finish_task as the final call.";
        if (!source) {
            issue = "empty_response";
            suggestion = "Return a tool call now. If the task is already complete, return finish_task.";
        } else if (markers) {
            issue = "malformed_or_unsupported_tool_call";
            location = evidence ? "tool-call fragment" : "response";
            suggestion = "Use JSON syntax, double quotes, and the exact local tool name. Unicode values such as Chinese are allowed inside strings.";
            const open = (source.match(/{/g) || []).length;
            const close = (source.match(/}/g) || []).length;
            if (open !== close) {
                issue = "unbalanced_json_braces";
                suggestion = "Close every JSON object and ensure the arguments object is complete before sending the call.";
            }
        } else if (source) {
            issue = "missing_tool_call";
            suggestion = "Do not send prose alone. Encode the intended action as a standalone tool_call JSON object, then end with finish_task when done.";
        }
        return { issue, location, suggestion, evidence, sourceLength: source.length };
    }

    function parseText(text) {
        const source = stripReasoningSections(text);
        if (/^\s*"(?:\\.|[^"\\])*"\s*$/.test(source)) {
            try {
                const decoded = parseJsonValue(source);
                if (decoded === null) throw new Error("invalid JSON");
                if (typeof decoded === "string" && decoded !== source) return parseText(decoded);
            } catch (_) { /* continue with the original text */ }
        }
        const found = [];
        const add = (call, start, end) => { if (call) found.push({ call, start, end }); };
        let match;

        let structuredPriority = Infinity;
        for (const candidate of scanJsonValues(source)) {
            let parsed;
            parsed = parseJsonValue(candidate.raw);
            if (parsed === null) continue;
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
        // XML tool calling variants emitted by OpenAI-compatible and Codex relays.
        const xmlPatterns = [
            /<tool_call\b[^>]*>\s*<(?:function|tool)\s*=\s*["']?([^\s>"']+)["']?[^>]*>([\s\S]*?)<\/(?:function|tool)>\s*<\/tool_call>/gi,
            /<(?:function|tool|recipient)\s*=\s*["']?([^\s>"']+)["']?[^>]*>([\s\S]*?)<\/(?:function|tool|recipient)>/gi,
            /<tool_call\b[^>]*>\s*<name>\s*([^<]+?)\s*<\/name>([\s\S]*?)<\/tool_call>/gi
        ];
        for (const pattern of xmlPatterns) {
            while ((match = pattern.exec(source))) {
                const name = decodeEntities(match[1]).trim();
                const body = decodeEntities(match[2]).trim();
                let args = parseArguments(body);
                if (!Object.keys(args).length) {
                    const jsonBody = body.match(/\{[\s\S]*\}/);
                    if (jsonBody) args = parseArguments(jsonBody[0]);
                }
                add({ ...makeCall(name, args), _priority: 4 }, match.index, pattern.lastIndex);
            }
        }
        // Harmony/Codex relays sometimes expose the recipient channel in text.
        const harmony = /(?:^|\n)\s*(?:to|recipient)\s*[=:]\s*([\w.-]+)(?:\s+[^\n]*)?\s*\n\s*(\{[\s\S]*?\})(?=\n|$)/gi;
        while ((match = harmony.exec(source))) {
            const recipient = match[1];
            const args = parseArguments(match[2]);
            const call = makeCall(recipient, args);
            if (call) add({ ...call, _priority: 4 }, match.index, harmony.lastIndex);
        }
        const xml = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi;
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
        const visibleText = segments.filter(item => item.type === "text").map(item => item.text).join("\n\n");
        const malformed = emittedCalls.length === 0 && hasMalformedToolCall(source);
        return { calls: emittedCalls, segments, text: visibleText, hasMalformedToolCall: malformed, diagnostics: diagnoseToolCallResponse(source) };
    }

    const FALLBACK_END_LINE = 1000000;
    function translateToolName(value) {
        const original = String(value || "").trim();
        if (!original) return "";
        const key = original.toLocaleLowerCase("en-US").replace(/^\/*/, "").replace(/[\s:-]+/g, "_");
        const aliases = {
            "functions.exec": "run_shell", "functions.exec_command": "run_shell", "tools.exec": "run_shell",
            "functions.run_shell": "run_shell", "tools.run_shell": "run_shell",
            "container.exec": "run_shell", "container.exec_command": "run_shell", "shell_command": "run_shell",
            "exec_command": "run_shell", "execute_command": "run_shell", "terminal": "run_shell", "bash": "run_shell", "shell": "run_shell",
            "local_shell": "run_shell", "command": "run_shell", "sh": "run_shell", "powershell": "run_shell",
            "read": "read_file_range", "cat": "read_file_range", "read_file": "read_file_range",
            "functions.read_file": "read_file_range", "create_file": "write_file", "write": "write_file",
            "functions.read_file_range": "read_file_range", "tools.read_file": "read_file_range",
            "functions.write_file": "write_file", "functions.edit_file": "edit_file", "edit": "edit_file",
            "str_replace_editor": "str_replace_editor", "str_replace_based_edit_tool": "str_replace_based_edit_tool",
            "functions.apply_patch": "apply_patch", "codex.apply_patch": "apply_patch",
            "list_directory": "list_dir", "ls": "list_dir", "functions.list_dir": "list_dir",
            "search": "grep_files", "find": "grep_files", "ripgrep": "grep_files", "grep": "grep_files",
            "functions.grep_files": "grep_files", "open_image": "view_image", "read_image": "view_image",
            "show_image": "view_image", "functions.view_image": "view_image", "plan": "update_plan",
            "set_plan": "update_plan", "functions.update_plan": "update_plan"
        };
        if (aliases[key]) return aliases[key];
        const suffix = key.split(".").pop();
        return aliases[suffix] || original;
    }
    function canonicalizeToolCall(call) {
        if (!call || typeof call !== "object") return call;
        const originalName = String(call.name || "").trim();
        const name = translateToolName(originalName);
        const sourceArgs = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments) ? call.arguments : {};
        const args = { ...sourceArgs };
        if (name === "run_shell") {
            let command = args.command ?? args.cmd ?? args.input ?? args.script;
            if (Array.isArray(command)) command = command.join(" ");
            return { ...call, name: "run_shell", arguments: { command: String(command || "") } };
        }
        if (name === "read_file_range" && (originalName !== "read_file_range" || args.offset !== undefined || args.limit !== undefined || args.file_path !== undefined || args.path !== undefined && (args.start_line === undefined || args.end_line === undefined))) {
            const filePath = String(args.file_path || args.path || "");
            const offset = Number(args.offset) > 0 ? Number(args.offset) : 1;
            const limit = Number(args.limit) > 0 ? Number(args.limit) : 0;
            return {
                ...call,
                name: "read_file_range",
                arguments: { path: filePath, start_line: offset, end_line: limit > 0 ? offset + limit - 1 : FALLBACK_END_LINE }
            };
        }
        if (name === "str_replace_based_edit_tool" || name === "str_replace_editor" || name === "text_editor") {
            const command = String(args.command || "").trim();
            const filePath = String(args.path || "");
            if (command === "view") {
                const viewRange = Array.isArray(args.view_range) ? args.view_range : [];
                const startLine = Number(viewRange[0]) > 0 ? Number(viewRange[0]) : 1;
                const endLine = Number(viewRange[1]) > 0 ? Number(viewRange[1]) : FALLBACK_END_LINE;
                return { ...call, name: "read_file_range", arguments: { path: filePath, start_line: startLine, end_line: endLine } };
            }
            if (command === "str_replace") {
                return { ...call, name: "edit_file", arguments: { path: filePath, old_text: String(args.old_str || ""), new_text: String(args.new_str || "") } };
            }
            if (command === "create") {
                return { ...call, name: "write_file", arguments: { path: filePath, content: String(args.file_text || args.content || "") } };
            }
            if (command === "insert") {
                return { ...call, name: "_claude_insert_text", arguments: { path: filePath, insert_line: Number(args.insert_line) || 0, insert_text: String(args.insert_text || "") } };
            }
            if (command === "undo_edit") {
                return { ...call, name: "_claude_undo_edit", arguments: { path: filePath } };
            }
        }
        if (name === "apply_patch") {
            return { ...call, name: "_codex_apply_patch", arguments: { input: String(args.input || args.patch || args.diff || args.content || "") } };
        }
        if (name === "list_dir" || name === "list_directory" || name === "ls") {
            return { ...call, name: "list_dir", arguments: { dir_path: String(args.dir_path || args.path || "."), offset: Number(args.offset) || 0, limit: Number(args.limit) || 0, depth: Number(args.depth) || 1 } };
        }
        if (name === "grep_files" || name === "search_files" || name === "grep") {
            return { ...call, name: "grep_files", arguments: { pattern: String(args.pattern || ""), include: String(args.include || ""), path: String(args.path || "."), limit: Number(args.limit) || 100 } };
        }
        if (name === "view_image" || name === "read_image" || name === "show_image") {
            return { ...call, name: "view_image", arguments: { path: String(args.path || args.file_path || "") } };
        }
        if (name === "update_plan" || name === "plan" || name === "set_plan") {
            return { ...call, name: "update_plan", arguments: { explanation: String(args.explanation || ""), plan: Array.isArray(args.plan) ? args.plan : [] } };
        }
        return name !== originalName ? { ...call, name, arguments: args } : call;
    }
    function canonicalizeToolCalls(calls) {
        if (!Array.isArray(calls)) return calls;
        return calls.map(canonicalizeToolCall).filter(Boolean);
    }

    function normalize(input) {
        if (typeof input === "string") return parseText(input).calls;
        return normalizeStructured(input);
    }

    function parseAgentResponse(text, structuredCalls) {
        const calls = Array.isArray(structuredCalls) && structuredCalls.length ? structuredCalls : parseText(text).calls;
        if (Array.isArray(structuredCalls) && structuredCalls.length) {
            const prose = String(text || "").trim();
            return { calls, segments: [...(prose ? [{ type: "text", text: prose }] : []), ...calls.map(call => ({ type: "tool_call", call }))], text: prose, diagnostics: diagnoseToolCallResponse(prose) };
        }
        return parseText(text);
    }

    return {
        normalize,
        normalizeToolCall: input => normalize(input)[0] || null,
        normalizeToolCalls: normalize,
        parseText,
        parseAgentResponse,
        parseArguments,
        stripReasoningSections,
        extractToolCallEvidence,
        diagnoseToolCallResponse,
        hasMalformedToolCall,
        translateToolName,
        canonicalizeToolCall,
        canonicalizeToolCalls
    };
});
