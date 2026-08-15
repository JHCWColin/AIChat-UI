const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeToolCalls, parseAgentResponse } = require("../tool-call-normalizer");

const expected = { name: "read_file", arguments: { path: "test.txt" } };

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
});

test("extracts JSON tool calls from prose and Markdown fences", () => {
    const parsed = parseAgentResponse('I will read it.\n```json\n{"name":"read_file","arguments":{"path":"test.txt"}}\n```');
    assert.deepEqual(parsed.calls, [expected]);
    assert.equal(parsed.text, "I will read it.");
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
