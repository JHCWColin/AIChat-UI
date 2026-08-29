const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeToolCalls, parseAgentResponse, stripReasoningSections, extractToolCallEvidence } = require("../tool-call-normalizer");

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
