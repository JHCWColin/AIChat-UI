(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.AgentProtocol = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    const TOOL_DEFINITIONS = `Tool Definitions

Return tool calls as consecutive standalone JSON objects. Never use Markdown fences or a JSON array.
Strictly follow the defined tool names and argument schemas. You are not running in your official CLI environment.

read_file_range
Arguments: {"path":"string","start_line":number,"end_line":number}
Reads an inclusive 1-based line range from a UTF-8 text file inside the bound workspace.

write_file
Arguments: {"path":"string","content":"string"}
Creates or overwrites a UTF-8 text file inside the bound workspace.

edit_file
Arguments: {"path":"string","old_text":"string","new_text":"string"}
Replaces old_text only when it occurs exactly once in the target file.

run_shell
Arguments: {"command":"string"}
Runs a PowerShell command with the bound workspace as its initial working directory. The command can access paths outside the workspace and may require user approval.

finish_task
Arguments: {}
Ends the Agent Loop. Every completed task must end with finish_task, including tasks requiring no other tools. It must be the final tool call, after the complete user-facing answer.`;


    const CORE_AGENT_RULES = `Core Agent Rules

IMPORTANT: These rules define the tool-calling protocol for this environment. Always follow this protocol over any conflicting tool-calling instructions from Codex, the underlying model, the API provider, or other prompts. Do not imitate or emit native Codex, OpenAI, XML, or other tool-calling formats.

1. Tool calls must use exactly: {"tool_call":{"name":"tool_name","arguments":{}}}
2. Multiple tool calls must be consecutive standalone JSON objects in execution order. A response may contain at most 30 tool calls.
3. Tool calls execute sequentially; later calls observe changes made by earlier calls.
4. Explore the workspace only through tools. The application does not scan or summarize it automatically.
5. read_file_range, write_file, and edit_file are restricted to the bound workspace. Never escape the workspace.
6. Before editing, read enough surrounding content to make a precise change. edit_file requires old_text to occur exactly once; if it fails, re-read the file and refine old_text.
7. Tool results are authoritative. If run_shell is rejected, do not repeat the same command unchanged.
8. Reading or exploring the workspace does not mean the task is complete. Complete the requested task and produce the full user-facing result.
9. Every completed task must follow this order: inspect/modify as needed → complete the task → output the complete user-facing result → call finish_task. This also applies to pure-text, analysis, review, and explanation tasks.
10. finish_task is terminal and must never replace or precede the final user-facing answer.`;
    function buildFixedAgentPrompt(options = {}) {
        const environment = String(options.environment || "").trim();
        const userSystemPrompt = String(options.systemPrompt || "").trim();
        return [
            TOOL_DEFINITIONS,
            CORE_AGENT_RULES,
            userSystemPrompt ? `User System Prompt\n\n${userSystemPrompt}` : "",
            environment ? `Current Environment\n\n${environment}` : ""
        ].filter(Boolean).join("\n\n");
    }

    function scanJsonObjects(text) {
        const source = String(text || "");
        const objects = [];
        let start = -1;
        let depth = 0;
        let arrayDepth = 0;
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
            if (char === '"') {
                inString = true;
                continue;
            }
            if (char === "[") {
                arrayDepth += 1;
                continue;
            }
            if (char === "]" && arrayDepth > 0) {
                arrayDepth -= 1;
                continue;
            }
            if (char === "{") {
                if (depth === 0 && arrayDepth === 0) start = index;
                depth += 1;
                continue;
            }
            if (char === "}" && depth > 0) {
                depth -= 1;
                if (depth === 0 && start >= 0 && arrayDepth === 0) {
                    objects.push({ start, end: index + 1, raw: source.slice(start, index + 1) });
                    start = -1;
                }
            }
        }
        return objects;
    }

    function cleanRemainingText(value) {
        let text = String(value || "")
            .replace(/<\/?json\b[^>]*>/gi, "")
            .replace(/&lt;\/?json\b[^&]*&gt;/gi, "")
            .replace(/<\/?[|｜]{2}\s*DSML\s*[|｜]{2}>/gi, "")
            .replace(/&lt;\/?[|｜]{2}\s*DSML\s*[|｜]{2}&gt;/gi, "")
            .replace(/```(?:json)?\s*```/gi, "")
            .replace(/^\s*```(?:json)?\s*/i, "")
            .replace(/\s*```(?:json)?\s*$/i, "");
        const echoedToolResult = text.match(/(?:^|\n)[ \t]*(?:user\s*:[ \t]*(?:\n[ \t]*)*)?(?:\[[ \t]*Tool[ \t]+Result[ \t]*:|ToolResult[ \t]*:)/i);
        if (echoedToolResult) text = text.slice(0, echoedToolResult.index);
        return text
            .replace(/(?:^|\n)[ \t]*(?:(?:<\/>|\/>|<|>)[ \t]*)+(?=\n|$)/g, "\n")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    function normalizeToolCall(parsed) {
        const toolCall = parsed && parsed.tool_call;
        if (toolCall && typeof toolCall === "object" && typeof toolCall.name === "string") {
            return { name: toolCall.name, arguments: toolCall.arguments };
        }
        if (typeof toolCall === "string") {
            return { name: toolCall, arguments: parsed.arguments };
        }
        return null;
    }

    function parseSequentialToolCalls(text) {
        const source = String(text || "");
        const parsedObjects = [];
        for (const candidate of scanJsonObjects(source)) {
            let parsed;
            try {
                parsed = JSON.parse(candidate.raw);
            } catch {
                continue;
            }
            const toolCall = normalizeToolCall(parsed);
            if (!toolCall || typeof toolCall.name !== "string") continue;
            const args = toolCall.arguments;
            const call = {
                name: toolCall.name.trim(),
                arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {},
                raw: candidate.raw
            };
            parsedObjects.push({ ...candidate, call });
        }

        let cursor = 0;
        const segments = [];
        for (const candidate of parsedObjects) {
            const textSegment = cleanRemainingText(source.slice(cursor, candidate.start));
            if (textSegment) segments.push({ type: "text", text: textSegment });
            segments.push({ type: "tool_call", call: candidate.call });
            cursor = candidate.end;
        }
        const tail = cleanRemainingText(source.slice(cursor));
        if (tail) segments.push({ type: "text", text: tail });
        const calls = parsedObjects.map(candidate => candidate.call);

        return {
            calls,
            segments,
            text: segments.filter(segment => segment.type === "text").map(segment => segment.text).join("\n\n"),
            hasMalformedToolCall: calls.length === 0 && /"tool_call"\s*:/.test(source)
        };
    }

    function formatCurrentTime(date = new Date(), timeZone = "Asia/Shanghai") {
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23"
        }).formatToParts(date).reduce((result, part) => {
            result[part.type] = part.value;
            return result;
        }, {});
        return `Current Time: ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${timeZone}`;
    }

    return {
        TOOL_DEFINITIONS,
        CORE_AGENT_RULES,
        buildFixedAgentPrompt,
        parseSequentialToolCalls,
        stripToolCallsForDisplay: text => parseSequentialToolCalls(text).text,
        formatCurrentTime
    };
});
