(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.AgentProtocol = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    const TOOL_DEFINITIONS = `Tool Definitions

You can call local tools by returning one or more consecutive standalone JSON objects. Do not wrap tool calls in Markdown fences and do not return a JSON array.

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
Ends the Agent Loop. It must be the last tool call in the response that completes the task.`;

    const CORE_AGENT_RULES = `Core Agent Rules

1. Tool calls must use exactly this shape: {"tool_call":{"name":"tool_name","arguments":{}}}
2. When calling multiple tools in one response, output consecutive standalone tool-call objects in execution order.
3. A single model response may contain at most 30 tool calls.
4. Tool calls are executed sequentially. A later call observes changes made by earlier calls.
5. Explore the project through tools. The application does not scan or summarize the workspace automatically.
6. read_file_range, write_file, and edit_file are restricted to the bound workspace. Never attempt parent traversal or workspace escape.
7. Before editing, read enough surrounding content to construct a precise change.
8. edit_file requires old_text to occur exactly once. If it fails, read the file again and make old_text more specific.
9. Tool results remain in context in full. Use them as authoritative execution results.
10. If a run_shell command is rejected, try a different method and do not repeat the rejected command unchanged.
11. Complete the task before calling finish_task. Calls before finish_task still execute, and finish_task must be last.
12. In the final response, write the user-facing result first, then place the finish_task JSON object at the absolute end.`;

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
        return String(value || "")
            .replace(/```(?:json)?\s*```/gi, "")
            .replace(/^\s*```(?:json)?\s*/i, "")
            .replace(/\s*```(?:json)?\s*$/i, "")
            .trim();
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
            const toolCall = parsed && parsed.tool_call;
            if (!toolCall || typeof toolCall !== "object" || typeof toolCall.name !== "string") continue;
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
        formatCurrentTime
    };
});
