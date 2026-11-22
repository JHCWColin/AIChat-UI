const test = require('node:test');
const assert = require('node:assert/strict');
const { declareTool, createCollector, isUnsupportedToolError, visibleText } = require('../renderer/memory-transport');
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

test('legacy OpenAI function_call deltas keep their original continuation format', () => {
    const collector = createCollector('/chat/completions');
    const wire = JSON.stringify(args);
    collector.ingest({ choices: [{ delta: { function_call: { name, arguments: wire.slice(0, 13) } } }] });
    collector.ingest({ choices: [{ delta: { function_call: { arguments: wire.slice(13) } }, finish_reason: 'function_call' }] });
    const calls = collector.finish();
    assert.deepEqual(calls, [{ name, arguments: args }]);
    const replay = collector.continuation({ messages: [] }, calls, [result]);
    assert.deepEqual(replay.messages, [
        { role: 'assistant', content: null, function_call: { name, arguments: wire } },
        { role: 'function', name, content: '{"ok":true}' }
    ]);
});

const dsmlArgs = { action: 'update', id: 'm42', text: '【测试记录·已修改】内容被成功更新，用于验证记忆修改功能。' };
const closeDsml = tag => '\\</｜｜DSML｜｜ ' + tag + '>';
const dsml = [
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="manage_memory">',
    ...Object.entries(dsmlArgs).map(([key, value]) =>
        '<｜｜DSML｜｜ parameter name="' + key + '" string="true">' + value + closeDsml('parameter')),
    closeDsml('invoke'),
    closeDsml('calls')
].join(' ');

test('a completed DeepSeek DSML reply repairs escaped closing tags and keeps memory private', () => {
    const collector = createCollector('/chat/completions');
    const reply = '已收到。\n\n' + dsml;
    collector.ingest({ choices: [{ delta: { content: reply } }] });
    assert.deepEqual(collector.finish(reply), []);
    collector.ingest({ choices: [{ finish_reason: 'stop' }] });
    const calls = collector.finish(reply);
    assert.deepEqual(calls, [{ name, arguments: dsmlArgs }]);
    assert.equal(collector.continuation({ messages: [] }, calls, [result]), null);
    assert.equal(visibleText(reply).trim(), '已收到。');
    assert.deepEqual(collector.finish(reply.slice(0, -closeDsml('calls').length)), []);
});

test('Chat SSE DONE can complete a text call unless a finish reason already rejected it', () => {
    const done = createCollector('/chat/completions');
    done.endStream();
    assert.deepEqual(done.finish(dsml), [{ name, arguments: dsmlArgs }]);

    const truncated = createCollector('/chat/completions');
    truncated.ingest({ choices: [{ finish_reason: 'length' }] });
    truncated.endStream();
    assert.deepEqual(truncated.finish(dsml), []);
});

test('serialized OpenAI, Gemini and Anthropic frames can accompany normal prose', () => {
    const frames = [
        { tool_calls: [{ id: call.id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
        { type: 'function_call', call_id: call.id, name, arguments: JSON.stringify(args) },
        { functionCall: { id: call.id, name, args } },
        { type: 'tool_use', id: call.id, name, input: args }
    ];
    for (const frame of frames) {
        const collector = createCollector('/chat/completions');
        collector.ingest({ choices: [{ finish_reason: 'stop' }] });
        const reply = '**已收到。**\n\n' + JSON.stringify(frame);
        assert.deepEqual(collector.finish(reply), [call]);
        assert.equal(visibleText(reply).trim(), '**已收到。**');
    }
});

test('native and text copies of a call are applied once', () => {
    const collector = createCollector('/chat/completions');
    collector.ingest({
        choices: [{ message: { tool_calls: [{ id: call.id, function: { name, arguments: args } }] }, finish_reason: 'tool_calls' }]
    });
    assert.deepEqual(collector.finish(dsml), [call]);
});

test('streaming visible prose never includes prefixes or arguments of private envelopes', () => {
    const answer = '第一句。第二句。';
    const examples = [
        dsml,
        JSON.stringify({ functionCall: { name, args } }),
        JSON.stringify({ type: 'tool_result', tool_use_id: 'secret', content: '私人结果。' }),
        '<tool_result>私人结果。</tool_result>',
        '<think>这个是思考内容。</think>'
    ];
    for (const wire of examples) {
        for (let end = 1; end <= wire.length; end += 1) {
            assert.equal(visibleText(answer + '\n' + wire.slice(0, end), { streaming: true }).trim(), answer);
        }
    }
    const ordinary = '\n  **Markdown**\n\n\x60\x60\x60json\n{"example":1}\n\x60\x60\x60\n';
    assert.equal(visibleText(ordinary), ordinary);
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
