const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeToolCalls, parseAgentResponse, stripReasoningSections, extractToolCallEvidence, diagnoseToolCallResponse } = require("../tool-call-normalizer");

const expected = { name: "read_file", arguments: { path: "test.txt" } };

// Exact protocol shape captured from the live Agent's final update_plan reply.
const liveDsmlPlan = [
    { step: "用 list_dir 列出工作区结构", status: "completed" },
    { step: "用 glob_files/grep_files/read_file_range 探索 src/计算器.cjs 与 verify.cjs", status: "completed" },
    { step: "用 edit_file 修复 add 加法错误", status: "completed" },
    { step: "用 multi_edit_file 同时改 label 与 version", status: "completed" },
    { step: "新建 docs/补丁记录.md（PATCH_OK）", status: "completed" },
    { step: "用 write_file 新建 docs/结果.md（验证通过）", status: "completed" },
    { step: "run_shell 执行 node verify.cjs，确认 VERIFY_OK 且 exitCode 0", status: "completed" },
    { step: "给出中文总结并 finish_task", status: "completed" }
];
const liveDsmlExplanation = "node verify.cjs 实际输出 VERIFY_OK，退出码 0，验证通过。";
const liveDsmlReply = [
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="update_plan">',
    `<｜｜DSML｜｜ parameter name="explanation" string="true">${liveDsmlExplanation}</｜｜DSML｜｜ parameter>`,
    `<｜｜DSML｜｜ parameter name="plan" string="false">${JSON.stringify(liveDsmlPlan)}</｜｜DSML｜｜ parameter>`,
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>'
].join("\n");

test("normalizes the captured DSML update_plan with typed Chinese parameters", () => {
    const parsed = parseAgentResponse(liveDsmlReply);
    assert.deepEqual(parsed.calls, [{ name: "update_plan", arguments: { explanation: liveDsmlExplanation, plan: liveDsmlPlan } }]);
    assert.deepEqual(normalizeToolCalls(liveDsmlReply), parsed.calls);
    assert.equal(parsed.hasMalformedToolCall, false);
    assert.equal(parsed.text, "");
    assert.deepEqual(parsed.segments.map(segment => segment.type), ["tool_call"]);
});

test("preserves Chinese prose around DSML without displaying invocation parameters", () => {
    const parsed = parseAgentResponse(`检查已经完成。\n${liveDsmlReply}\n下面给出最终总结。`);
    assert.deepEqual(parsed.segments.map(segment => segment.type === "text" ? segment.text : segment.call.name), [
        "检查已经完成。", "update_plan", "下面给出最终总结。"
    ]);
    assert.match(parsed.text, /检查已经完成。/);
    assert.match(parsed.text, /下面给出最终总结。/);
    assert.doesNotMatch(parsed.text, /DSML|dsml_|explanation|VERIFY_OK|completed|parameter/);
});

test("DSML string=true parameters remain strings even when they look like JSON", () => {
    const response = [
        '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="inspect_value">',
        '<｜｜DSML｜｜ parameter name="literal" string="true">[1,2]</｜｜DSML｜｜ parameter>',
        '<｜｜DSML｜｜ parameter name="structured" string="false">{"count":2,"enabled":true}</｜｜DSML｜｜ parameter>',
        '</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>'
    ].join("\n");
    assert.deepEqual(parseAgentResponse(response).calls, [{ name: "inspect_value", arguments: {
        literal: "[1,2]", structured: { count: 2, enabled: true }
    } }]);
});

test("recovers the captured typed process-output call with an unnamed parameter close", () => {
    const response = [
        '<｜｜DSML｜｜ calls>',
        '<｜｜DSML｜｜ invoke name="read_process_output">',
        '<｜｜DSML｜｜ parameter name="process_id" string="true">live-worker</｜｜DSML｜｜ parameter>',
        '<｜｜DSML｜｜ parameter name="tail_bytes" string="false">4096</｜｜DSML｜｜>',
        '</｜｜DSML｜｜ invoke>',
        '<｜｜DSML｜｜ invoke name="list_processes">',
        '</｜｜DSML｜｜ invoke>',
        '</｜｜DSML｜｜ calls>'
    ].join("\n");
    const parsed = parseAgentResponse(response);
    assert.deepEqual(parsed.calls, [
        { name: "read_process_output", arguments: { process_id: "live-worker", tail_bytes: 4096 } },
        { name: "list_processes", arguments: {} }
    ]);
    assert.equal(parsed.hasMalformedToolCall, false);
    assert.equal(parsed.text, "");
    assert.deepEqual(parseAgentResponse(response.replace(/<｜｜DSML｜｜ invoke name="list_processes">[\s\S]*?<\/｜｜DSML｜｜ invoke>\n/, "")).calls,
        [{ name: "read_process_output", arguments: { process_id: "live-worker", tail_bytes: 4096 } }]);
});

test("does not repair unnamed closes with invalid typed values or extra structural closes", () => {
    const valid = [
        '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read_process_output">',
        '<｜｜DSML｜｜ parameter name="tail_bytes" string="false">4096</｜｜DSML｜｜>',
        '</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>'
    ].join("\n");
    for (const response of [
        valid.replace('4096', '{"not":"complete"'),
        valid.replace('string="false"', 'string="true"'),
        valid.replace('</｜｜DSML｜｜ invoke>', '</｜｜DSML｜｜></｜｜DSML｜｜ invoke>')
    ]) {
        const parsed = parseAgentResponse(response);
        assert.equal(parsed.hasMalformedToolCall, true);
        assert.equal(parsed.text, "");
    }
});

test("malformed DSML parameters are flagged and never treated as visible answers", () => {
    const response = liveDsmlReply.replace(JSON.stringify(liveDsmlPlan), '[{"step":"BROKEN_PLAN_SECRET",}]');
    const parsed = parseAgentResponse(`可辨认的前文。\n${response}\n可辨认的后文。`);
    assert.deepEqual(parsed.calls, []);
    assert.equal(parsed.hasMalformedToolCall, true);
    assert.match(parsed.text, /可辨认的前文。/);
    assert.match(parsed.text, /可辨认的后文。/);
    assert.doesNotMatch(parsed.text, /DSML|dsml_|BROKEN_PLAN_SECRET|explanation|parameter|VERIFY_OK/);
});

test("truncated DSML invocations cannot leak protocol fragments into final prose", () => {
    const response = liveDsmlReply.replace('</｜｜DSML｜｜ invoke>', '');
    const parsed = parseAgentResponse(`任务前文。\n${response}\n任务后文。`);
    assert.deepEqual(parsed.calls, []);
    assert.equal(parsed.hasMalformedToolCall, true);
    assert.match(parsed.text, /任务前文。/);
    assert.match(parsed.text, /任务后文。/);
    assert.doesNotMatch(parsed.text, /DSML|dsml_|VERIFY_OK|completed|parameter/);
});

test("ordinary HTML calls and parameter words are not mistaken for DSML", () => {
    const html = '<section><h2>调用说明</h2><p>calls invoke parameter</p><code>string="false"</code></section>';
    const parsed = parseAgentResponse(html);
    assert.deepEqual(parsed.calls, []);
    assert.equal(parsed.hasMalformedToolCall, false);
    assert.equal(parsed.text, html);
    const { canonicalizeDsmlMarkers, stripDsmlProtocol } = require("../tool-call-normalizer");
    assert.equal(canonicalizeDsmlMarkers(html), html);
    assert.equal(stripDsmlProtocol(html), html);
});

test("normalizes OpenAI Chat Completions tool_calls", () => {
    assert.deepEqual(normalizeToolCalls({
        tool_calls: [{ id: "call_xxx", type: "function", function: { name: "read_file", arguments: '{"path":"test.txt"}' } }]
    }), [{ id: "call_xxx", ...expected }]);
});

test("normalizes Chat Completions response envelopes and streamed argument fragments", () => {
    const events = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_xxx", function: { name: "read_file", arguments: '{"path":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"test.txt"}' } }] } }] }
    ];
    assert.deepEqual(normalizeToolCalls(events), [{ id: "call_xxx", ...expected }]);
});

test("normalizes OpenAI Responses function_call", () => {
    assert.deepEqual(normalizeToolCalls({ output: [{ type: "function_call", call_id: "fc_xxx", name: "read_file", arguments: '{"path":"test.txt"}' }] }), [
        { id: "fc_xxx", ...expected }
    ]);
});

test("merges OpenAI Responses function argument events", () => {
    const events = [
        { type: "response.output_item.added", item: { type: "function_call", id: "item_xxx", call_id: "fc_xxx", name: "read_file", arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: "item_xxx", delta: '{"path":' },
        { type: "response.function_call_arguments.done", item_id: "item_xxx", arguments: '{"path":"test.txt"}' }
    ];
    assert.deepEqual(normalizeToolCalls(events), [{ id: "fc_xxx", ...expected }]);
});

test("normalizes Claude tool_use at top level and in content", () => {
    assert.deepEqual(normalizeToolCalls({ type: "tool_use", id: "toolu_xxx", name: "read_file", input: { path: "test.txt" } }), [
        { id: "toolu_xxx", ...expected }
    ]);
    assert.deepEqual(normalizeToolCalls({ content: [{ type: "text", text: "reading" }, { type: "tool_use", name: "read_file", input: { path: "test.txt" } }] }), [expected]);
});

test("normalizes Gemini functionCall including candidates content parts", () => {
    assert.deepEqual(normalizeToolCalls({ functionCall: { name: "read_file", args: { path: "test.txt" } } }), [expected]);
    assert.deepEqual(normalizeToolCalls({ candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: { path: "test.txt" } } }] } }] }), [expected]);
});

test("normalizes generic JSON variants and string arguments", () => {
    assert.deepEqual(normalizeToolCalls({ tool: "read_file", args: { path: "test.txt" } }), [expected]);
    assert.deepEqual(normalizeToolCalls({ name: "read_file", arguments: '{"path":"test.txt"}' }), [expected]);
    assert.deepEqual(normalizeToolCalls({ name: "read_file", arguments: JSON.stringify({ path: "test.txt" }) }), [expected]);
});

test("extracts JSON tool calls from prose and Markdown fences", () => {
    const parsed = parseAgentResponse('I will read it.\n```json\n{"name":"read_file","arguments":{"path":"test.txt"}}\n```');
    assert.deepEqual(parsed.calls, [expected]);
    assert.equal(parsed.text, "I will read it.");
});

test("decodes a JSON tool call returned as a JSON string", () => {
    const encoded = JSON.stringify(JSON.stringify({ tool_call: { name: "read_file", arguments: { path: "test.txt" } } }));
    assert.deepEqual(parseAgentResponse(encoded).calls, [expected]);
});

test("normalizes XML and Action style agent output", () => {
    assert.deepEqual(parseAgentResponse('<tool_call>{"name":"read_file","arguments":{"path":"test.txt"}}</tool_call>').calls, [expected]);
    assert.deepEqual(parseAgentResponse('Action: read_file\nAction Input: {"path":"test.txt"}').calls, [expected]);
});

test("preserves multiple calls in execution order", () => {
    const parsed = parseAgentResponse([
        '{"tool":"read_file","args":{"path":"a.txt"}}',
        '{"name":"read_file","arguments":{"path":"b.txt"}}'
    ].join("\n"));
    assert.deepEqual(parsed.calls.map(call => call.arguments.path), ["a.txt", "b.txt"]);
});

test("structured tool calls take priority over text agent formats", () => {
    const structured = [{ name: "structured_call", arguments: {} }];
    const parsed = parseAgentResponse('Action: text_call\nAction Input: {}', structured);
    assert.deepEqual(parsed.calls, structured);
});

test("text detection follows the declared format priority", () => {
    const parsed = parseAgentResponse([
        '{"tool":"generic_call","args":{}}',
        '{"tool_calls":[{"function":{"name":"openai_call","arguments":"{}"}}]}'
    ].join("\n"));
    assert.deepEqual(parsed.calls.map(call => call.name), ["openai_call"]);
});

test("normalizes Responses custom_tool_call and streamed custom input", () => {
    const events = [
        { type: "response.output_item.added", item: { type: "custom_tool_call", id: "item_1", call_id: "call_1", name: "apply_patch", input: "" } },
        { type: "response.custom_tool_call_input.delta", item_id: "item_1", delta: "*** Begin Patch\\n" },
        { type: "response.custom_tool_call_input.done", item_id: "item_1", input: "*** Begin Patch\\n*** End Patch" }
    ];
    assert.deepEqual(normalizeToolCalls(events), [{ id: "call_1", name: "apply_patch", arguments: { input: "*** Begin Patch\\n*** End Patch" } }]);
});

test("parses XML function and parameter tool calls", () => {
    const parsed = parseAgentResponse('<tool_call><function=read_file><parameter=path>test.txt</parameter><parameter=offset>3</parameter></function></tool_call>');
    assert.deepEqual(parsed.calls, [{ name: "read_file", arguments: { path: "test.txt", offset: 3 } }]);
});

test("translates Codex and OpenAI relay tool names to local tools", () => {
    assert.deepEqual(require("../tool-call-normalizer").canonicalizeToolCall({ name: "container.exec", arguments: { cmd: "Get-ChildItem" } }), {
        name: "run_shell", arguments: { command: "Get-ChildItem" }
    });
    assert.deepEqual(require("../tool-call-normalizer").canonicalizeToolCall({ name: "read_file", arguments: { path: "a.txt" } }), {
        name: "read_file_range", arguments: { path: "a.txt", start_line: 1, end_line: 1000000 }
    });
});

test("never parses tool-call-shaped content inside reasoning sections", () => {
    const response = '<think>尝试调用 {"tool_call":{"name":"read_file","arguments":{"path":"secret.txt"}}}</think>最终答案。';
    assert.deepEqual(parseAgentResponse(response).calls, []);
    assert.equal(parseAgentResponse(response).text, "最终答案。");
    const harmony = '<|channel|>analysis\n{"tool_call":{"name":"read_file","arguments":{}}}<|channel|>final\n完成';
    assert.deepEqual(parseAgentResponse(harmony).calls, []);
    assert.equal(stripReasoningSections(harmony), '<|channel|>final\n完成');
});

test("extracts concrete malformed tool-call content for protocol errors", () => {
    const evidence = extractToolCallEvidence('<think>{"tool_call":{"name":"ignored","arguments":{}}}</think>\n<tool_call>{"name":"read_file"}</tool_call>');
    assert.match(evidence, /read_file/);
    assert.doesNotMatch(evidence, /ignored/);
});

test("does not expose malformed tool-call JSON as正文", () => {
    const parsed = parseAgentResponse('{"tool_call":{"name":"run_shell","arguments":{"command":"Get-ChildItem"}}');
    assert.deepEqual(parsed.calls, []);
    assert.equal(parsed.hasMalformedToolCall, true);
    assert.equal(parsed.text, '{"tool_call":{"name":"run_shell","arguments":{"command":"Get-ChildItem"}}');
});

test("preserves Unicode arguments including Chinese plan text", () => {
    const parsed = parseAgentResponse('{"tool_call":{"name":"update_plan","arguments":{"explanation":"修复中文工具调用","plan":[{"step":"读取配置文件","status":"in_progress"}]}}}');
    assert.deepEqual(parsed.calls[0].arguments, {
        explanation: "修复中文工具调用",
        plan: [{ step: "读取配置文件", status: "in_progress" }]
    });
});

test("accepts full-width JSON punctuation around Unicode arguments", () => {
    const parsed = parseAgentResponse('前缀\n｛"tool_call"：｛"name"："update_plan"，"arguments"：｛"explanation"："中文计划"｝｝｝');
    assert.equal(parsed.calls[0].name, "update_plan");
    assert.equal(parsed.calls[0].arguments.explanation, "中文计划");
});

test("returns actionable diagnostics for malformed tool calls", () => {
    const diagnostics = diagnoseToolCallResponse('{"tool_call":{"name":"update_plan","arguments":{"explanation":"中文"}');
    assert.equal(diagnostics.issue, "unbalanced_json_braces");
    assert.match(diagnostics.location, /tool-call/);
    assert.match(diagnostics.suggestion, /Close|complete/i);
    assert.match(diagnostics.evidence, /中文/);
});

test("does not strip Markdown fences from a code-only final response", () => {
    const response = '```javascript\nconst total = 3;\n```';
    const parsed = parseAgentResponse(response);
    assert.deepEqual(parsed.calls, []);
    assert.equal(parsed.text, response);
    assert.equal(parsed.hasMalformedToolCall, false);
});

test("retains ordinary fenced code together with its surrounding prose", () => {
    const response = '计算结果如下：\n\n```javascript\nconst total = 3;\n```\n\n可以继续使用。';
    const parsed = parseAgentResponse(response);
    assert.deepEqual(parsed.calls, []);
    assert.equal(parsed.text, response);
});

test("strips a complete JSON tool fence while retaining its executable call", () => {
    const response = '```json\n{"tool_call":{"name":"read_file_range","arguments":{"path":"a.js","start_line":1,"end_line":3}}}\n```';
    const parsed = parseAgentResponse(response);
    assert.deepEqual(parsed.calls, [{ name: "read_file_range", arguments: { path: "a.js", start_line: 1, end_line: 3 } }]);
    assert.equal(parsed.text, "");
    assert.doesNotMatch(parsed.text, /```/);
});

test("extracts all tool calls from a shared JSON fence without visible remnants", () => {
    const response = [
        '```json',
        '{"tool_call":{"name":"read_file_range","arguments":{"path":"a.js"}}}',
        '{"tool_call":{"name":"finish_task","arguments":{}}}',
        '```'
    ].join("\n");
    const parsed = parseAgentResponse(response);
    assert.deepEqual(parsed.calls.map(call => call.name), ["read_file_range", "finish_task"]);
    assert.equal(parsed.text, "");
    assert.equal(parsed.hasMalformedToolCall, false);
});

test("keeps a normal code fence when a separate tool fence is consumed", () => {
    const answer = '下面是结果：\n\n```javascript\nconst total = 3;\n```';
    const response = `${answer}\n\n\`\`\`json\n{"tool_call":{"name":"finish_task","arguments":{}}}\n\`\`\``;
    const parsed = parseAgentResponse(response);
    assert.deepEqual(parsed.calls.map(call => call.name), ["finish_task"]);
    assert.equal(parsed.text, answer);
});

test("retains non-tool JSON examples inside Markdown fences", () => {
    const response = '```json\n{"total":3,"label":"中文结果"}\n```';
    const parsed = parseAgentResponse(response);
    assert.deepEqual(parsed.calls, []);
    assert.equal(parsed.text, response);
});

test("parses the live web-summary finish after Chinese and English quotation marks", () => {
    const answer = '联网工具测试结果：web_search 搜索“Electron BrowserWindow docs”成功，返回 5 条结果；browse_web 读取 https://example.com 成功，页面文本为“Example Domain — This domain is for use in documentation examples without needing permission. This is not a service; avoid relying on it for testing and monitoring purposes.” 两个工具都没有失败、超时或空结果，以上内容均为真实返回。';
    const parsed = parseAgentResponse([answer, '{"tool_call":{"name":"finish_task","arguments":{}}}'].join(String.fromCharCode(10, 10)));
    assert.deepEqual(parsed.calls.map(call => call.name), ["finish_task"]);
    assert.equal(parsed.hasMalformedToolCall, false);
    assert.deepEqual(parsed.segments.map(segment => segment.type), ["text", "tool_call"]);
    assert.equal(parsed.text, answer);
});

test("ordinary prose punctuation does not conceal a fenced finish call", () => {
    const answer = '搜索词 “Electron” 与页面引文 "Example Domain" 均已核实。';
    const fence = String.fromCharCode(96).repeat(3);
    const response = [answer, fence + 'json', '{"tool_call":{"name":"finish_task","arguments":{}}}', fence].join(String.fromCharCode(10));
    const parsed = parseAgentResponse(response);
    assert.deepEqual(parsed.calls.map(call => call.name), ["finish_task"]);
    assert.equal(parsed.hasMalformedToolCall, false);
    assert.equal(parsed.text, answer);
});
