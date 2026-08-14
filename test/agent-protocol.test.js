const test = require("node:test");
const assert = require("node:assert/strict");
const {
    parseSequentialToolCalls,
    buildFixedAgentPrompt,
    formatCurrentTime
} = require("../agent-protocol");

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
});

test("parses more than thirty calls so the Agent Loop can enforce the per-response limit", () => {
    const response = Array.from({ length: 31 }, () => '{"tool_call":{"name":"read_file_range","arguments":{}}}').join("\n");
    assert.equal(parseSequentialToolCalls(response).calls.length, 31);
});

test("formats current time at the dynamic suffix", () => {
    assert.equal(formatCurrentTime(new Date("2026-08-15T02:00:00.000Z")), "Current Time: 2026-08-15 10:00:00 Asia/Shanghai");
});
