const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const AgentProtocol = require("../renderer/agent-protocol");
const AIUIMemoryTransport = require("../renderer/memory-transport");

const source = fs.readFileSync(path.join(__dirname, "../renderer/voicechat-api.js"), "utf8");
const baseUrl = "https://relay.example/proxy/v1/";
const messagesUrl = "https://relay.example/proxy/v1/messages";

function fixture(fetch, options = {}) {
    const context = { AgentProtocol, AIUIMemoryTransport, TextDecoder, fetch };
    context.window = context;
    vm.runInNewContext(source, context);
    return context.VoiceChatAPI.streamText({
        endpoint: "/responses",
        apiKey: "test-key",
        baseUrl,
        payload: { model: "claude-haiku-5-5", stream: true, messages: [{ role: "user", content: "Describe the workspace" }] },
        ...options
    });
}

function eventStream(...events) {
    const stream = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

test("voice Claude prioritizes Messages and reads only native text", async () => {
    const urls = [];
    const displayed = [];
    const result = await fixture(async (url, request) => {
        urls.push(url);
        assert.equal(request.headers["x-api-key"], "test-key");
        const body = JSON.parse(request.body);
        assert.deepEqual(body.cache_control, { type: "ephemeral" });
        assert.deepEqual(body.messages[0].content, [{ type: "text", text: "Describe the workspace" }]);
        return eventStream(
            { type: "message_start", message: { content: [] } },
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "internal context" } },
            { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Visible answer" } },
            { type: "message_stop" }
        );
    }, { onText: text => displayed.push(text) });

    assert.equal(result.endpoint, "/v1/messages");
    assert.deepEqual(urls, [messagesUrl]);
    assert.deepEqual(displayed, ["Visible answer"]);
});

test("voice Claude falls back only to the configured endpoint", async () => {
    const urls = [];
    const fallback = [];
    await assert.rejects(fixture(async url => {
        urls.push(url);
        return new Response("Unavailable", { status: url === messagesUrl ? 404 : 501 });
    }, { endpoint: "/chat/completions", onFallback: endpoint => fallback.push(endpoint) }), /501/);

    assert.deepEqual(urls, [messagesUrl, "https://relay.example/proxy/v1/chat/completions"]);
    assert.deepEqual(fallback, ["/chat/completions"]);
});

test("voice Claude aborts a native request without falling back", async () => {
    const controller = new AbortController();
    const urls = [];
    await assert.rejects(fixture(async (url, request) => {
        urls.push(url);
        controller.abort();
        request.signal.throwIfAborted();
    }, { signal: controller.signal }), { name: "AbortError" });

    assert.deepEqual(urls, [messagesUrl]);
});

test("explicit native voice endpoint handles a full Messages response", async () => {
    const urls = [];
    const result = await fixture(async url => {
        urls.push(url);
        return Response.json({ type: "message", content: [{ type: "text", text: "Visible answer" }] });
    }, { endpoint: "/v1/messages" });

    assert.deepEqual(urls, [messagesUrl]);
    assert.equal(result.text, "Visible answer");
});
