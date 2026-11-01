const test = require("node:test");
const assert = require("node:assert/strict");
const {
    parseSequentialToolCalls,
    buildFixedAgentPrompt,
    formatCurrentTime
} = require("../agent-protocol");

const dsmlPlanReply = [
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="update_plan">',
    '<｜｜DSML｜｜ parameter name="explanation" string="true">node verify.cjs 实际输出 VERIFY_OK，退出码 0，验证通过。</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="plan" string="false">[{"step":"用 list_dir 列出工作区结构","status":"completed"},{"step":"修复 src/计算器.cjs 并验证","status":"completed"}]</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>'
].join("\n");

test("dedicated DSML markers canonicalize without becoming ordinary HTML tags", () => {
    const { canonicalizeDsmlMarkers, stripDsmlProtocol } = require("../agent-protocol");
    const canonical = canonicalizeDsmlMarkers(dsmlPlanReply);
    assert.match(canonical, /<dsml_calls>/);
    assert.match(canonical, /<dsml_invoke name="update_plan">/);
    assert.match(canonical, /<dsml_parameter name="plan" string="false">/);
    assert.doesNotMatch(canonical, /｜|DSML/);
    assert.equal(canonicalizeDsmlMarkers(canonical), canonical);
    assert.equal(stripDsmlProtocol(dsmlPlanReply).trim(), "");
});

test("sequential protocol never exposes a pure DSML invocation as the final answer", () => {
    const { stripToolCallsForDisplay } = require("../agent-protocol");
    const parsed = parseSequentialToolCalls(dsmlPlanReply);
    // Execution is delegated to the normalizer; this display parser must reject
    // its unsupported protocol safely rather than accept it as completed prose.
    assert.equal(parsed.calls.length, 0);
    assert.equal(parsed.hasMalformedToolCall, true);
    assert.equal(parsed.text, "");
    assert.equal(stripToolCallsForDisplay(dsmlPlanReply), "");
});

test("sequential display preserves Chinese prose before and after a DSML block", () => {
    const parsed = parseSequentialToolCalls(`验证已经完成。\n${dsmlPlanReply}\n可以继续下一轮任务。`);
    assert.match(parsed.text, /验证已经完成。/);
    assert.match(parsed.text, /可以继续下一轮任务。/);
    assert(parsed.text.indexOf("验证已经完成。") < parsed.text.indexOf("可以继续下一轮任务。"));
    assert.doesNotMatch(parsed.text, /DSML|dsml_|VERIFY_OK|completed|explanation|parameter/);
});

test("malformed DSML stays hidden while distinguishable surrounding prose survives", () => {
    const malformed = dsmlPlanReply.replace('</｜｜DSML｜｜ invoke>', '');
    const parsed = parseSequentialToolCalls(`前文仍可显示。\n${malformed}\n后文仍可显示。`);
    assert.equal(parsed.hasMalformedToolCall, true);
    assert.equal(parsed.calls.length, 0);
    assert.match(parsed.text, /前文仍可显示。/);
    assert.match(parsed.text, /后文仍可显示。/);
    assert.doesNotMatch(parsed.text, /DSML|dsml_|VERIFY_OK|completed|parameter/);
});

test("unclosed DSML cannot become a visible assistant answer", () => {
    const truncated = dsmlPlanReply.slice(0, dsmlPlanReply.indexOf('</｜｜DSML｜｜ parameter>'));
    const parsed = parseSequentialToolCalls(`可辨认的说明。\n${truncated}`);
    assert.equal(parsed.hasMalformedToolCall, true);
    assert.equal(parsed.calls.length, 0);
    assert.equal(parsed.text, "可辨认的说明。");
});

test("DSML display cleanup leaves ordinary HTML and protocol-looking words intact", () => {
    const { canonicalizeDsmlMarkers, stripDsmlProtocol, stripToolCallsForDisplay } = require("../agent-protocol");
    const html = '<section><h2>工具说明</h2><p>calls invoke parameter</p><code>string="false"</code></section>';
    assert.equal(canonicalizeDsmlMarkers(html), html);
    assert.equal(stripDsmlProtocol(html), html);
    assert.equal(stripToolCallsForDisplay(html), html);
    const parsed = parseSequentialToolCalls(html);
    assert.equal(parsed.hasMalformedToolCall, false);
    assert.equal(parsed.text, html);
});

test("parses consecutive standalone tool call objects in order", () => {
    const response = [
        '{"tool_call":{"name":"read_file_range","arguments":{"path":"a.js","start_line":1,"end_line":20}}}',
        '{"tool_call":{"name":"edit_file","arguments":{"path":"a.js","old_text":"x","new_text":"y"}}}'
    ].join("\n");
    const parsed = parseSequentialToolCalls(response);
    assert.deepEqual(parsed.calls.map(call => call.name), ["read_file_range", "edit_file"]);
    assert.equal(parsed.text, "");
});

test("keeps final prose and removes finish_task JSON", () => {
    const response = '修改完成，构建已通过。\n{"tool_call":{"name":"finish_task","arguments":{}}}';
    const parsed = parseSequentialToolCalls(response);
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.calls[0].name, "finish_task");
    assert.equal(parsed.text, "修改完成，构建已通过。");
});

test("keeps mixed prose and tool calls in their original order", () => {
    const response = [
        "先读取文件。",
        '{"tool_call":{"name":"read_file_range","arguments":{"path":"a.js","start_line":1,"end_line":20}}}',
        "然后修改唯一匹配。",
        '{"tool_call":{"name":"edit_file","arguments":{"path":"a.js","old_text":"x","new_text":"y"}}}',
        "修改完成。",
        '{"tool_call":{"name":"finish_task","arguments":{}}}'
    ].join("\n");
    const parsed = parseSequentialToolCalls(response);
    assert.deepEqual(parsed.segments.map(segment => segment.type === "text" ? segment.text : segment.call.name), [
        "先读取文件。",
        "read_file_range",
        "然后修改唯一匹配。",
        "edit_file",
        "修改完成。",
        "finish_task"
    ]);
    assert.doesNotMatch(parsed.text, /tool_call/);
});

test("removes json tags and empty lines surrounding tool calls", () => {
    const response = [
        "<json>",
        '{"tool_call":{"name":"read_file_range","arguments":{"path":"package.json","start_line":1,"end_line":14}}}',
        "</json>",
        "",
        "<json>",
        '{"tool_call":{"name":"finish_task","arguments":{}}}',
        "</json>"
    ].join("\n");
    const parsed = parseSequentialToolCalls(response);
    assert.deepEqual(parsed.calls.map(call => call.name), ["read_file_range", "finish_task"]);
    assert.equal(parsed.text, "");
    assert.equal(parsed.segments.filter(segment => segment.type === "text").length, 0);
});

test("cleans literal and escaped json wrappers from visible prose", () => {
    assert.equal(parseSequentialToolCalls("<json>任务完成。</json>").text, "任务完成。");
    assert.equal(parseSequentialToolCalls("&lt;json&gt;任务完成。&lt;/json&gt;").text, "任务完成。");
});

test("parses DSML wrapped and flat tool call variants without leaking protocol markers", () => {
    const response = [
        "</>",
        "我来查看项目的主要文件。",
        "<",
        '{"tool_call":{"name":"read_file_range","arguments":{"path":"package.json","start_line":1,"end_line":14}}}',
        "/> <",
        '{"tool_call":"read_file_range","arguments":{"path":"server.js","start_line":1,"end_line":119}}',
        "/>",
        "</｜｜DSML｜｜>"
    ].join("\n");
    const parsed = parseSequentialToolCalls(response);
    assert.deepEqual(parsed.calls.map(call => call.name), ["read_file_range", "read_file_range"]);
    assert.equal(parsed.text, "我来查看项目的主要文件。");
    assert.doesNotMatch(parsed.text, /DSML|<\/?|\/>/);
});

test("drops echoed ToolResult prompts while preserving the following tool call", () => {
    const response = [
        "user:",
        "",
        "ToolResult:read_file_range",
        '{"success":true,"content":"file content\\n</｜｜DSML｜｜>"}',
        '<{"tool_call":"read_file_range","arguments":{"path":"views/index.ejs","start_line":121,"end_line":240}}/>'
    ].join("\n");
    const parsed = parseSequentialToolCalls(response);
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.calls[0].name, "read_file_range");
    assert.equal(parsed.text, "");
});

test("keeps final prose returned after finish_task for compatibility", () => {
    const response = [
        '<{"tool_call":{"name":"finish_task","arguments":{}}}/>',
        "这是一个 Node.js + Express 项目。"
    ].join("\n");
    const parsed = parseSequentialToolCalls(response);
    assert.deepEqual(parsed.segments.map(segment => segment.type === "text" ? segment.text : segment.call.name), [
        "finish_task",
        "这是一个 Node.js + Express 项目。"
    ]);
});

test("does not treat a JSON array as the requested sequential object protocol", () => {
    const parsed = parseSequentialToolCalls('[{"tool_call":{"name":"finish_task","arguments":{}}}]');
    assert.equal(parsed.calls.length, 0);
    assert.equal(parsed.text, '[{"tool_call":{"name":"finish_task","arguments":{}}}]');
});

test("fixed prompt keeps tool definitions before agent rules and environment", () => {
    const prompt = buildFixedAgentPrompt({ systemPrompt: "用户规则", environment: "OS: Windows" });
    assert.ok(prompt.indexOf("Tool Definitions") < prompt.indexOf("Core Agent Rules"));
    assert.ok(prompt.indexOf("Core Agent Rules") < prompt.indexOf("User System Prompt"));
    assert.ok(prompt.indexOf("User System Prompt") < prompt.indexOf("Current Environment"));
    assert.match(prompt, /mandatory even when no local tool is needed and the answer is pure text/i);
    assert.match(prompt, /output exactly one finish_task JSON object/i);
    assert.match(prompt, /严格按照工具定义来调用，你现在不身处于你的官方cli环境！/);
});

test("parses more than thirty calls so the Agent Loop can enforce the per-response limit", () => {
    const response = Array.from({ length: 31 }, () => '{"tool_call":{"name":"read_file_range","arguments":{}}}').join("\n");
    assert.equal(parseSequentialToolCalls(response).calls.length, 31);
});

test("formats current time at the dynamic suffix", () => {
    assert.equal(formatCurrentTime(new Date("2026-08-15T02:00:00.000Z")), "Current Time: 2026-08-15 10:00:00 Asia/Shanghai");
});

test("does not parse tool-call-shaped reasoning as executable protocol output", () => {
    const parsed = parseSequentialToolCalls('<think>{"tool_call":{"name":"read_file_range","arguments":{}}}</think>完成');
    assert.equal(parsed.calls.length, 0);
    assert.equal(parsed.text, "完成");
});

test("preserves a final answer consisting only of a JavaScript code fence", () => {
    const response = '```javascript\nconst total = 3;\n```';
    const parsed = parseSequentialToolCalls(response);
    assert.deepEqual(parsed.calls, []);
    assert.equal(parsed.text, response);
    assert.equal(require("../agent-protocol").stripToolCallsForDisplay(response), response);
});

test("preserves prose and ordinary fenced code in their original Markdown form", () => {
    const response = '计算结果如下：\n\n```javascript\nconst total = 3;\n```\n\n可以继续使用。';
    const parsed = parseSequentialToolCalls(response);
    assert.deepEqual(parsed.calls, []);
    assert.equal(parsed.text, response);
});

test("removes a JSON tool protocol fence without leaving orphan backticks", () => {
    const response = '```json\n{"tool_call":{"name":"read_file_range","arguments":{"path":"a.js","start_line":1,"end_line":3}}}\n```';
    const parsed = parseSequentialToolCalls(response);
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.calls[0].name, "read_file_range");
    assert.deepEqual(parsed.calls[0].arguments, { path: "a.js", start_line: 1, end_line: 3 });
    assert.equal(parsed.text, "");
    assert.doesNotMatch(parsed.text, /```/);
});

test("executes every sequential tool object inside one JSON fence", () => {
    const response = [
        '```json',
        '{"tool_call":{"name":"read_file_range","arguments":{"path":"a.js"}}}',
        '{"tool_call":{"name":"finish_task","arguments":{}}}',
        '```'
    ].join("\n");
    const parsed = parseSequentialToolCalls(response);
    assert.deepEqual(parsed.calls.map(call => call.name), ["read_file_range", "finish_task"]);
    assert.equal(parsed.text, "");
    assert.equal(parsed.hasMalformedToolCall, false);
});

test("removes only the protocol fence when ordinary code appears beside it", () => {
    const answer = '下面是结果：\n\n```javascript\nconst total = 3;\n```';
    const response = `${answer}\n\n\`\`\`json\n{"tool_call":{"name":"finish_task","arguments":{}}}\n\`\`\``;
    const parsed = parseSequentialToolCalls(response);
    assert.deepEqual(parsed.calls.map(call => call.name), ["finish_task"]);
    assert.equal(parsed.text, answer);
});

test("preserves JSON data fences that contain no tool protocol", () => {
    const response = '```json\n{"total":3,"label":"中文结果"}\n```';
    const parsed = parseSequentialToolCalls(response);
    assert.deepEqual(parsed.calls, []);
    assert.equal(parsed.text, response);
});

test("parses the live web-summary finish after Chinese and English quotation marks", () => {
    const answer = '联网工具测试结果：web_search 搜索“Electron BrowserWindow docs”成功，返回 5 条结果；browse_web 读取 https://example.com 成功，页面文本为“Example Domain — This domain is for use in documentation examples without needing permission. This is not a service; avoid relying on it for testing and monitoring purposes.” 两个工具都没有失败、超时或空结果，以上内容均为真实返回。';
    const parsed = parseSequentialToolCalls([answer, '{"tool_call":{"name":"finish_task","arguments":{}}}'].join(String.fromCharCode(10, 10)));
    assert.deepEqual(parsed.calls.map(call => call.name), ["finish_task"]);
    assert.equal(parsed.hasMalformedToolCall, false);
    assert.equal(parsed.text, answer);
});

test("ordinary prose punctuation does not conceal a fenced finish call", () => {
    const answer = '搜索词 “Electron” 与页面引文 "Example Domain" 均已核实。';
    const fence = String.fromCharCode(96).repeat(3);
    const response = [answer, fence + 'json', '{"tool_call":{"name":"finish_task","arguments":{}}}', fence].join(String.fromCharCode(10));
    const parsed = parseSequentialToolCalls(response);
    assert.deepEqual(parsed.calls.map(call => call.name), ["finish_task"]);
    assert.equal(parsed.text, answer);
});
