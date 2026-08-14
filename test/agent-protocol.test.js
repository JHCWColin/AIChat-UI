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
});

test("parses more than thirty calls so the Agent Loop can enforce the per-response limit", () => {
    const response = Array.from({ length: 31 }, () => '{"tool_call":{"name":"read_file_range","arguments":{}}}').join("\n");
    assert.equal(parseSequentialToolCalls(response).calls.length, 31);
});

test("formats current time at the dynamic suffix", () => {
    assert.equal(formatCurrentTime(new Date("2026-08-15T02:00:00.000Z")), "Current Time: 2026-08-15 10:00:00 Asia/Shanghai");
});
