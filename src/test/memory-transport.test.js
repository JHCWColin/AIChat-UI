const test = require('node:test');
const assert = require('node:assert/strict');
const { declareTool, createCollector, isUnsupportedToolError } = require('../renderer/memory-transport');
const { createStore } = require('../renderer/user-memory');

const tool = createStore({}).getTool();
const name = tool.function.name;
const args = { action: 'add', text: '用户习惯使用四格缩进。' };
const result = { result: { ok: true } };
const call = { name, arguments: args, id: 'call_a' };

test('memory is declared in each provider’s native tool format', () => {
    const examples = {
        '/chat/completions': sent => sent.function.name,
        '/responses': sent => sent.name,
        '/v1/messages': sent => sent.name,
        '/gemini': sent => sent.functionDeclarations[0].name,
        '/ollama': sent => sent.function.name
    };
    for (const [endpoint, readName] of Object.entries(examples)) {
        const original = { model: 'test' };
        assert.equal(readName(declareTool(original, endpoint, tool).tools[0]), name);
        assert.equal(original.tools, undefined);
    }
});

test('Chat Completions only accepts completed fragmented function calls', () => {
    const collector = createCollector('/chat/completions');
    const wire = JSON.stringify(args);
    collector.ingest({ choices: [{ delta: { tool_calls: [{ index: 0, id: call.id, function: { name, arguments: wire.slice(0, 13) } }] } }] });
    collector.ingest({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: wire.slice(13) } }] } }] });
    assert.deepEqual(collector.finish(), []);
    collector.ingest({ choices: [{ finish_reason: 'tool_calls' }] });
    assert.deepEqual(collector.finish(), [call]);
    const replay = collector.continuation({ messages: [] }, [call], [result]);
    assert.deepEqual(replay.messages[1], { role: 'tool', tool_call_id: call.id, content: '{"ok":true}' });
    assert.equal(replay.tool_choice, 'none');
});

test('Responses replays opaque reasoning and the matching function output for tool-only replies', () => {
    const collector = createCollector('/responses');
    const reasoning = { type: 'reasoning', id: 'rs_a', encrypted_content: 'opaque' };
    const item = { type: 'function_call', name, call_id: call.id, arguments: JSON.stringify(args) };
    collector.ingest({ type: 'response.output_item.done', output_index: 1, item });
    collector.ingest({ type: 'response.incomplete', response: { status: 'incomplete', output: [reasoning, item] } });
    assert.deepEqual(collector.finish(), []);
    collector.ingest({ type: 'response.completed', response: { status: 'completed', output: [reasoning, item] } });
    assert.deepEqual(collector.finish(), [call]);
    const replay = collector.continuation({ input: [] }, [call], [result]);
    assert.deepEqual(replay.input, [reasoning, item, { type: 'function_call_output', call_id: call.id, output: '{"ok":true}' }]);
});

test('Anthropic waits for message_stop before accepting a complete tool-use block', () => {
    const collector = createCollector('/v1/messages');
    collector.ingest({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: call.id, name, input: {} } });
    collector.ingest({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } });
    collector.ingest({ type: 'content_block_stop', index: 0 });
    collector.ingest({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
    assert.deepEqual(collector.finish(), []);
    collector.ingest({ type: 'message_stop' });
    assert.deepEqual(collector.finish(), [call]);
    const replay = collector.continuation({ messages: [] }, [call], [result]);
    assert.equal(replay.messages[1].content[0].tool_use_id, call.id);
});

test('Gemini preserves function-call thought signatures in its private continuation', () => {
    const collector = createCollector('/gemini');
    const part = { functionCall: { name, args, id: call.id }, thoughtSignature: 'signed' };
    collector.ingest({ candidates: [{ content: { parts: [part] }, finishReason: 'STOP' }] });
    assert.deepEqual(collector.finish(), [call]);
    const replay = collector.continuation({ contents: [] }, [call], [result]);
    assert.deepEqual(replay.contents[0].parts, [part]);
    assert.equal(replay.contents[1].parts[0].functionResponse.id, call.id);
});

test('Ollama treats separate complete NDJSON tool messages independently', () => {
    const collector = createCollector('/ollama');
    const second = { action: 'add', text: '用户喜欢简短示例。' };
    for (const operation of [args, second]) {
        collector.ingest({ message: { tool_calls: [{ function: { name, arguments: operation } }] }, done: false });
    }
    assert.deepEqual(collector.finish(), []);
    collector.ingest({ message: { content: '' }, done: true, done_reason: 'stop' });
    assert.deepEqual(collector.finish(), [{ name, arguments: args }, { name, arguments: second }]);
});

test('only an explicit provider tool-capability rejection triggers fallback', async () => {
    assert.equal(await isUnsupportedToolError(new Response('this model does not support tools', { status: 400 })), true);
    assert.equal(await isUnsupportedToolError(new Response('unknown model', { status: 400 })), false);
    assert.equal(await isUnsupportedToolError(new Response('this model does not support tools', { status: 500 })), false);
});
