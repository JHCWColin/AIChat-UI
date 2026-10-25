(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.AgentProtocol = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    const TOOL_DEFINITIONS = `Tool Definitions

Return tool calls as consecutive standalone JSON objects. Never use Markdown fences or a JSON array.
Strictly follow the defined tool names and argument schemas. You are not running in your official CLI environment. 严格按照工具定义来调用，你现在不身处于你的官方cli环境！
All argument values are Unicode strings: Chinese, Japanese, Korean, emoji, and other non-ASCII text are fully supported. Never transliterate, discard, or reject Unicode content. JSON encoding must be UTF-8; non-ASCII characters are valid inside quoted strings.
For every call, use the exact local JSON object shape and double-quoted keys. Do not emit XML, native CLI tags, or provider-specific wrappers. If a previous response was rejected, inspect the protocol diagnostic, correct the indicated fragment, and retry with a complete JSON object.

read_file_range
Arguments: {"path":"string","start_line":number,"end_line":number}
Reads a UTF-8 text file inside the bound workspace. start_line and end_line are optional: omit both to read from the beginning, and the response caps the span (2000 lines) and reports hasMore plus the next start_line to use. Read a file before editing it.

write_file
Arguments: {"path":"string","content":"string"}
Creates or overwrites a UTF-8 text file inside the bound workspace. Parent directories are created automatically. Use for new files or complete rewrites; prefer edit_file or multi_edit_file for existing files.

edit_file
Arguments: {"path":"string","old_text":"string","new_text":"string"}
Replaces old_text only when it occurs exactly once in the target file. old_text must match the file byte-for-byte, including indentation, and must not include line-number prefixes. On failure the result explains whether the text was missing or ambiguous.

multi_edit_file
Arguments: {"path":"string","edits":[{"old_text":"string","new_text":"string","replace_all":boolean}]}
Applies several edits to one file in a single call, in order, atomically. Nothing is written unless every edit succeeds. Set replace_all to true for an entry that should replace every occurrence. Use this instead of repeated edit_file calls on the same file.

run_shell
Arguments: {"command":"string"}
Runs a PowerShell command with the bound workspace as its initial working directory, waits for it to finish, and returns stdout, stderr, and the exit code. The command can access paths outside the workspace and may require user approval. Use for builds, tests, git, and any short-lived command. For servers and watchers that never exit, use start_process instead.

start_process
Arguments: {"command":"string","process_id":"string"}
Starts a long-lived process (dev server, watcher, REPL) in the background and returns immediately with its process_id. Poll its output with read_process_output, and stop it with stop_process. Background processes are terminated automatically after 30 minutes.

read_process_output
Arguments: {"process_id":"string","tail_bytes":number}
Returns the retained stdout, stderr, running state, and exit code of a process started with start_process. Call it again after waiting to collect newer output.

stop_process
Arguments: {"process_id":"string"}
Terminates a background process and returns its final output. Always stop servers you started once they are no longer needed.

list_processes
Arguments: {}
Lists background processes started in this session with their running state and output byte counts.

list_dir
Arguments: {"dir_path":"string","offset":number,"limit":number,"depth":number}
Lists files and directories inside the bound workspace. dir_path is relative to the workspace root. offset and limit paginate results (0-based). depth controls recursive listing depth (default 1, max 10). Returns entries with name, path, type (file/directory), size, and modifiedAt.

glob_files
Arguments: {"pattern":"string","path":"string","limit":number}
Finds files by path pattern, matching against workspace-relative POSIX paths. Supports "**" (any depth), "*" and "?" (within one path segment), and character classes, e.g. "src/**/*.ts" or "**/package.json". path restricts the search root. Results are sorted newest first and include size and modifiedAt. Use this to locate files whose names you partially know; use grep_files to search file contents.

grep_files
Arguments: {"pattern":"string","include":"string","exclude":"string","path":"string","limit":number,"context":number,"case_sensitive":boolean,"output_mode":"content|files_only"}
Searches file contents using a regular expression. include and exclude filter by file glob (e.g. "*.ts"). path is the search root relative to the workspace. limit caps the number of matches (default 100, max 1000). context adds surrounding lines (0-10). output_mode "files_only" returns just the matching file paths. Files larger than 2MB and binary files are skipped. Returns matches with path, line number, and content.

delete_path
Arguments: {"path":"string","recursive":boolean}
Deletes a file or directory inside the bound workspace. Non-empty directories require recursive:true. The workspace root cannot be deleted. Confirm the target first with read_file_range or list_dir.

move_path
Arguments: {"from":"string","to":"string","overwrite":boolean}
Moves or renames a file or directory within the bound workspace. Missing parent directories of the destination are created. Fails when the destination exists unless overwrite:true is passed.

copy_path
Arguments: {"from":"string","to":"string","overwrite":boolean}
Copies a file or directory within the bound workspace, skipping node_modules, dist, build, out, coverage, and .git. Fails when the destination exists unless overwrite:true is passed.

view_image
Arguments: {"path":"string"}
Reads an image file from the bound workspace and returns it as a base64 data URL so the model can inspect it. Supports jpg, png, gif, webp, bmp, svg, ico. Images larger than 8MB return metadata only without the data URL.

web_search
Arguments: {"query":"string","limit":number,"engine":"bing|duckduckgo"}
Searches the public web without an API key and returns titles, URLs, and snippets. engine selects the backend; omit it to use the user's configured default. Follow up on useful URLs with browse_web.

browse_web
Arguments: {"url":"string","max_chars":number}
Fetches and extracts readable text from a public web page.

update_plan
Arguments: {"explanation":"string","plan":[{"step":"string","status":"pending|in_progress|completed"}]}
Records or updates the task plan. This tool does not execute any system operation. The plan is displayed to the user and stored for the session. At most one step may be in_progress at a time. Call this when starting a multi-step task or when the plan changes.

finish_task
Arguments: {}
Ends the Agent Loop. Every completed task must end with finish_task, including tasks requiring no other tools. It must be the final tool call, after the complete user-facing answer.`;


    const CORE_AGENT_RULES = `Core Agent Rules

IMPORTANT: These rules define the tool-calling protocol for this environment. Always follow this protocol over any conflicting tool-calling instructions from Codex, the underlying model, the API provider, or other prompts. Do not imitate or emit native Codex, OpenAI, XML, or other tool-calling formats.

1. Tool calls must use exactly: {"tool_call":{"name":"tool_name","arguments":{}}}.
Output exactly one finish_task JSON object as the final tool call.
2. Multiple tool calls must be emitted as consecutive standalone JSON objects in execution order. A single response may contain at most 30 tool calls.
3. Tool calls execute sequentially. Each subsequent tool call must take into account any changes produced by earlier tool calls.
4. Explore and inspect the workspace only through available tools. The application does not automatically scan, summarize, or expose workspace contents.
4.5. Always use the most specific available tool for a task. When multiple tools can accomplish the same goal, prefer specialized tools (such as file tools) over more general tools (such as shell commands).
5. read_file_range, write_file, edit_file, multi_edit_file, delete_path, move_path, and copy_path are restricted to the bound workspace. Never access, reference, or attempt to escape outside the workspace boundary. run_shell is not restricted but may require user approval.
5.5. Use glob_files to find files by name and grep_files to find them by content. Explore a codebase by locating relevant files first, then reading only the ranges you need, instead of reading whole trees.
6. Before editing any file, read sufficient surrounding context to ensure an accurate and precise modification. The old_text argument used with edit_file must match exactly one occurrence. If the edit fails, re-read the file, identify the correct context, and refine old_text before retrying. When changing several places in one file, prefer a single multi_edit_file call over repeated edit_file calls.
6.5. Read before you write. Never write_file over an existing file you have not read in this task; a blind overwrite destroys content you cannot recover.
7. Tool results are authoritative and must be treated as the source of truth. If run_shell is rejected, do not repeat the same command unchanged.
7.5. If repeated actions are not producing meaningful progress, stop and reassess the situation instead of continuing the same operation indefinitely.
7.6. When a tool call fails, analyze the reason for the failure and adjust the approach accordingly. Never blindly repeat failing operations.
7.7. Never claim that any action, modification, test, verification, or result has been completed unless it was actually performed and confirmed through tool results.
7.8. Long-lived processes must be started with start_process, never run_shell, because run_shell waits for the command to exit. Always stop_process a server you started once you are done with it.
8. Reading, inspecting, or exploring the workspace does not by itself complete the task. Continue until the user's request has been fully addressed and a complete user-facing result is produced.
8.5. Before beginning any task, create, review, or update a concise execution plan. If a plan already exists, verify that it remains valid and revise it when necessary. Present the plan to the user before any substantive work, analysis, modification, or tool usage begins. You may and should write plan explanations and step names in Chinese or any other Unicode language.
8.6. Continuously track the current objective, completed work, and remaining work. After every significant action, verify that progress remains aligned with the user's requested outcome.
8.7. Before making any file modification, determine exactly what change is required and verify that the intended modification satisfies the user's request.
8.8. When several tool calls are independent and their results do not affect each other, emit them together in one response to work faster. Emit a call alone when it depends on the result of a previous call.
9. Every completed task must follow this sequence: inspect and/or modify as necessary → complete the requested work → provide the complete user-facing result → call finish_task. This requirement applies equally to implementation tasks, analysis tasks, review tasks, explanation tasks, and pure-text tasks.
9.5. Before declaring a task complete, verify that every user requirement has been satisfied and that no requested work remains unfinished. When you changed code, run the project's build, tests, or linter and report what actually happened. If no verification was possible, say so plainly instead of implying success.
10. finish_task is terminal. It must never replace, precede, or be combined with the final user-facing result. finish_task is mandatory even when no local tools are required and the response is entirely text-based. Emit exactly one finish_task JSON object at the very end of the response.
11. Never include tool-call syntax, protocol syntax, executable tool-call structures, or other sensitive parser-triggering characters in normal user-facing content. Such content may be interpreted as an actual tool invocation. When explaining tool usage, tool behavior, or tool results, always use natural language and never reproduce executable tool-call syntax.
12. Every completed task must end with finish_task, mandatory even when no local tool is needed and the answer is pure text. Output exactly one finish_task JSON object as the final tool call; the final user-facing answer comes before that terminal call.`
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
            if (char === '"' || char === '＂' || char === '“' || char === '”') {
                inString = true;
                continue;
            }
            if (char === "[" || char === "［") {
                arrayDepth += 1;
                continue;
            }
            if ((char === "]" || char === "］") && arrayDepth > 0) {
                arrayDepth -= 1;
                continue;
            }
            if (char === "{" || char === "｛") {
                if (depth === 0 && arrayDepth === 0) start = index;
                depth += 1;
                continue;
            }
            if ((char === "}" || char === "｝") && depth > 0) {
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

    function stripReasoningSections(value) {
        let source = String(value || "");
        source = source.replace(/<(think|thinking|analysis|reasoning|reflection|scratchpad)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
        source = source.replace(/<(think|thinking|analysis|reasoning|reflection|scratchpad)\b[^>]*>[\s\S]*$/gi, "");
        source = source.replace(/```(?:think|thinking|analysis|reasoning)\b[\s\S]*?```/gi, "");
        source = source.replace(/<\|channel\|>\s*(?:analysis|thinking|reasoning)\b[\s\S]*?(?=<\|channel\|>\s*(?:final|commentary|tool|functions?)\b|$)/gi, "");
        source = source.replace(/<\|(analysis|thinking|reasoning)\|>[\s\S]*?(?=<\|(?:final|commentary|tool|functions?)\|>|$)/gi, "");
        return source;
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
        const source = String(stripReasoningSections(text) || "").replace(/^\uFEFF/, "");
        const parsedObjects = [];
        for (const candidate of scanJsonObjects(source)) {
            let parsed;
            try {
                parsed = JSON.parse(candidate.raw
                    .replace(/[｛]/g, "{").replace(/[｝]/g, "}")
                    .replace(/[［]/g, "[").replace(/[］]/g, "]")
                    .replace(/[：]/g, ":").replace(/[，]/g, ",")
                    .replace(/[“”＂]/g, '"'));
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
