/**
 * Protocol-adapter tests for the /v1/messages (Anthropic Messages API) support.
 *
 * index.html and voicechat-api.js are not loadable as modules, so the adapter
 * functions are extracted from the source text and exercised directly. This keeps
 * the assertions honest about the shipped implementation instead of a copy.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function loadInlineAdapter() {
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const names = [
        "ANTHROPIC_API_VERSION",
        "getRequestEndpoint",
        "buildMessagesPayloadFromBase",
        "buildMessagesContentBlocks",
        "toAnthropicImageBlock",
        "extractMessagesOutputText",
        "extractMessagesReasoningText",
        "extractMessagesStreamUpdate",
        "extractResponsesTextContent",
        "cacheControlEnabled",
        "extractStreamingUpdate",
        "getStreamingErrorMessage",
        "extractNonStreamingResponseText",
        "buildRequestPayloadForEndpoint"
    ];
    const context = {
        localStorage: { getItem: () => null },
        document: { querySelectorAll: () => [], querySelector: () => null },
        console
    };
    // Const declarations are not properties of the context object, so re-declare the
    // extracted consts as var to expose them to the assertions below.
    const sources = names.map(name => {
        const pattern = new RegExp(`^\\s*(?:const|function)\\s+${name}\\b[\\s\\S]*?\\n        \\}`, "m");
        const match = html.match(pattern);
        if (!match) throw new Error(`Could not extract ${name} from index.html`);
        return match[0].replace(/^\s*const\s+/, "var ");
    });
    vm.createContext(context);
    vm.runInContext(`${sources.join("\n")}\nthis.api = { ${names.join(", ")} };`, context);
    return context.api;
}

const api = loadInlineAdapter();

// Objects built inside the vm realm carry that realm's prototypes, which
// deepStrictEqual rejects even when the values are identical. Compare structures
// through JSON instead so the assertions test the adapter, not the realm.
const same = (actual, expected) => assert.deepEqual(
    JSON.parse(JSON.stringify(actual)),
    JSON.parse(JSON.stringify(expected))
);

test("recognizes the messages endpoint from storage in both spellings", () => {
    const context = {
        localStorage: { getItem: key => (key === "request_endpoint" ? "/v1/messages" : null) },
        document: { querySelectorAll: () => [], querySelector: () => null },
        console
    };
    vm.createContext(context);
    vm.runInContext(`function getRequestEndpoint() {
        const stored = String(localStorage.getItem('request_endpoint') || '').trim();
        if (stored === '/chat/completions') return '/chat/completions';
        if (stored === '/v1/messages' || stored === '/messages') return '/v1/messages';
        return '/responses';
    } this.getRequestEndpoint = getRequestEndpoint;`, context);
    assert.equal(context.getRequestEndpoint(), "/v1/messages");
});

test("moves system messages into the top-level system field", () => {
    const payload = api.buildMessagesPayloadFromBase({
        model: "claude-opus-5-5",
        max_tokens: 8000,
        messages: [
            { role: "system", content: "You are a coding agent." },
            { role: "user", content: "hello" }
        ]
    });
    assert.equal(payload.system, "You are a coding agent.");
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.messages[0].role, "user");
    same(payload.messages[0].content, [{ type: "text", text: "hello" }]);
    // The system turn must not remain in messages - Anthropic rejects that role there.
    assert.ok(!payload.messages.some(message => message.role === "system"));
});

test("combines several system messages into one system field", () => {
    const payload = api.buildMessagesPayloadFromBase({
        messages: [
            { role: "system", content: "first" },
            { role: "system", content: "second" },
            { role: "user", content: "go" }
        ]
    });
    assert.equal(payload.system, "first\n\nsecond");
});

test("drops sampling parameters that current Claude models reject", () => {
    const payload = api.buildMessagesPayloadFromBase({
        model: "claude-opus-5-5",
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
        messages: [{ role: "user", content: "hi" }]
    });
    assert.equal("temperature" in payload, false);
    assert.equal("top_p" in payload, false);
    assert.equal("top_k" in payload, false);
});

test("keeps max_tokens and does not leak OpenAI-only fields", () => {
    const payload = api.buildMessagesPayloadFromBase({
        model: "claude-opus-5-5",
        max_tokens: 4096,
        prompt_cache_key: "cache-key",
        cache_control: "ephemeral",
        stream: true,
        messages: [{ role: "user", content: "hi" }]
    });
    assert.equal(payload.max_tokens, 4096);
    assert.equal("prompt_cache_key" in payload, false);
    assert.equal("cache_control" in payload, false);
    assert.equal(payload.stream, true);
});

test("converts base64 and remote images into Anthropic image blocks", () => {
    const base64 = api.toAnthropicImageBlock("data:image/png;base64,AAAA");
    same(base64, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
    const remote = api.toAnthropicImageBlock("https://example.com/a.png");
    same(remote, { type: "image", source: { type: "url", url: "https://example.com/a.png" } });
    assert.equal(api.toAnthropicImageBlock(""), null);
});

test("converts OpenAI-style content parts into Anthropic blocks", () => {
    const blocks = api.buildMessagesContentBlocks([
        { type: "text", text: "look at this" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } }
    ]);
    assert.equal(blocks.length, 2);
    same(blocks[0], { type: "text", text: "look at this" });
    assert.equal(blocks[1].type, "image");
    assert.equal(blocks[1].source.media_type, "image/jpeg");
});

test("extracts text and reasoning from a non-streaming message response", () => {
    const payload = {
        content: [
            { type: "thinking", thinking: "let me think" },
            { type: "text", text: "the answer" },
            { type: "text", text: " is 42" }
        ]
    };
    assert.equal(api.extractMessagesOutputText(payload), "the answer is 42");
    assert.equal(api.extractMessagesReasoningText(payload), "let me think");
});

test("routes streaming events to deltas by block type", () => {
    same(
        api.extractMessagesStreamUpdate({ type: "content_block_delta", delta: { type: "text_delta", text: "abc" } }),
        { contentDelta: "abc" }
    );
    same(
        api.extractMessagesStreamUpdate({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } }),
        { reasoningDelta: "hmm" }
    );
    same(
        api.extractMessagesStreamUpdate({ type: "content_block_start", content_block: { type: "text", text: "start" } }),
        { contentSnapshot: "start" }
    );
    // message_delta carries only stop_reason/usage - it must never contribute text.
    same(api.extractMessagesStreamUpdate({ type: "message_delta", delta: { stop_reason: "end_turn" } }), {});
    same(api.extractMessagesStreamUpdate({ type: "message_start" }), {});
});

test("surfaces Anthropic top-level error events as stream errors", () => {
    assert.equal(
        api.getStreamingErrorMessage({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
        "Overloaded"
    );
    assert.equal(api.getStreamingErrorMessage({ type: "content_block_delta" }), "");
});

test("dispatches parsing by endpoint", () => {
    const payload = { content: [{ type: "text", text: "native" }] };
    assert.equal(api.extractNonStreamingResponseText(payload, "/v1/messages"), "native");
    same(api.extractStreamingUpdate({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } }, "/v1/messages"), { contentDelta: "x" });
});

test("builds a messages payload through the endpoint dispatcher", () => {
    const payload = api.buildRequestPayloadForEndpoint({
        model: "claude-opus-5-5",
        max_tokens: 1000,
        messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "hi" }
        ]
    }, "/v1/messages");
    assert.equal(payload.system, "sys");
    assert.equal(payload.max_tokens, 1000);
    assert.equal(payload.messages.length, 1);
    assert.equal("input" in payload, false);
});

test("attach cache_control to the system block when ephemeral caching is on", () => {
    const payload = api.buildMessagesPayloadFromBase({
        cache_control: "ephemeral",
        messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "hi" }
        ]
    });
    same(payload.system, [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]);
});