const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const AgentProtocol = require("../agent-protocol");
const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const item = (id = "rs_1", encrypted = "OPAQUE_COMPLETE") => ({ type: "reasoning", id,
    summary: [{ type: "summary_text", text: "safe summary" }], encrypted_content: encrypted });
const output = { type: "message", role: "assistant", content: [{ type: "output_text", text: "实际回答" }] };
const options = { model: "gpt-test", endpoint: "/responses", baseURL: "https://model.test/v1" };
const same = value => JSON.parse(JSON.stringify(value));

function extract(name) {
    const match = html.match(new RegExp(`^        (?:async )?function ${name}\\b[\\s\\S]*?\\n        \}`, "m"));
    if (!match) throw new Error(`Missing shipped function ${name}`);
    return match[0];
}

function fixture(response) {
    const nodes = new Map();
    const node = () => ({ innerHTML: "", style: {}, textContent: "", scrollTop: 0, scrollHeight: 0,
        classList: { add() {}, remove() {} }, querySelector: () => node(), querySelectorAll: () => [] });
    const chat = { id: "chat", messages: [{ role: "user", content: "问题" }] };
    const requests = [];
    const context = { AgentProtocol, TextEncoder, TextDecoder, AbortController, console,
        chats: [chat], activeChatId: chat.id, isGenerating: false, abortController: null, systemPrompt: "system",
        processedReplaceCount: 0, sessionReplaceBlocks: [], streamBytesReceived: 0, currentTemp: 0.7, maxTokensLimit: 0,
        developerModeEnabled: false, logLevel: "info", lastPromptCacheDebug: null,
        document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); } },
        localStorage: { getItem: () => null, setItem() {} },
        getBaseURL: () => options.baseURL, getRequestEndpoint: () => options.endpoint,
        buildCompactedChatMessages: value => value.messages, getPromptCacheKeyForChat: () => "",
        appendMessageToUI: node, setCanvasEditable() {}, logPromptCacheDebug() {}, appendLog() {},
        renderAssistantMarkdown: value => value, renderMathFormulas() {}, renderThinkingText() {}, setThinkingStatus() {},
        hideVoiceNotification() {}, showVoiceNotification() {}, renderChatHistory() {}, lucide: { createIcons() {} },
        sanitizeHtml: String,
        fetchEndpointWithFallback: async base => { requests.push(same(base)); return { response, endpoint: options.endpoint,
            requestBody: context.buildRequestPayloadForEndpoint(base, options.endpoint) }; } };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(["extractResponsesTextContent", "extractResponsesOutputText", "extractResponsesReasoningText",
        "extractChatCompletionUpdate", "extractStreamingUpdate", "mergeStreamingText", "parseSSEEventBlock",
        "getStreamingErrorMessage", "extractNonStreamingResponseText", "buildSingleApiMessage",
        "buildAPIMessagesWithTemp", "buildAPIMessagesWithContext", "buildResponsesInputFromMessages",
        "buildMessagesPayloadFromBase", "buildMessagesContentBlocks", "toAnthropicImageBlock", "cacheControlEnabled",
        "buildRequestPayloadForEndpoint", "requestAI"].map(extract).join("\n"), context);
    return { context, chat, requests };
}

test("completed reasoning items replace incomplete stream events and keep opaque protocol fields", () => {
    const state = AgentProtocol.createResponsesReasoningState([
        { type: "response.output_item.added", item: item("rs_1", "INCOMPLETE") },
        { type: "response.output_item.done", item: item() },
        { type: "response.completed", response: { output: [item()] } }
    ], options);
    assert.deepEqual(state.items, [item()]);
    assert.equal(AgentProtocol.collectResponsesReasoningItems({ type: "response.output_item.added", item: item() }).length, 0);
    assert.deepEqual(AgentProtocol.getResponsesReasoningItems({ responsesReasoning: state }, options), [item()]);
    for (const change of [{ model: "other" }, { endpoint: "/chat/completions" }, { baseURL: "https://elsewhere.test" }]) {
        assert.equal(AgentProtocol.getResponsesReasoningItems({ responsesReasoning: state }, { ...options, ...change }).length, 0);
    }
});

test("request adapters replay protocol reasoning only in matching Responses requests", async () => {
    const { context } = fixture();
    const state = AgentProtocol.createResponsesReasoningState({ output: [item()] }, options);
    const built = await context.buildSingleApiMessage({ role: "assistant", content: "<think>SECRET</think>Visible",
        reasoning: "PRIVATE_THOUGHT", responsesReasoning: state }, null);
    const base = { model: options.model, messages: [built], __aiuiStructuredResponsesInput: true };
    const payload = context.buildRequestPayloadForEndpoint(base, "/responses");
    assert.deepEqual(same(payload.input), [item(), { role: "assistant", content: [{ type: "output_text", text: "Visible" }] }]);
    assert.equal(payload.store, false);
    assert.ok(payload.include.includes("reasoning.encrypted_content"));
    assert.ok(!JSON.stringify(payload).includes("SECRET"));
    assert.ok(!JSON.stringify(payload).includes("PRIVATE_THOUGHT"));
    for (const endpoint of ["/chat/completions", "/v1/messages"]) {
        const other = context.buildRequestPayloadForEndpoint(base, endpoint);
        assert.ok(!/OPAQUE_COMPLETE|responsesReasoning|__aiuiResponsesReasoning|PRIVATE_THOUGHT/.test(JSON.stringify(other)));
    }
    assert.ok(!JSON.stringify(context.buildRequestPayloadForEndpoint({ ...base, model: "other" }, "/responses")).includes("OPAQUE_COMPLETE"));
});

test("switching models suppresses stored reasoning and switching back restores it for its source model", () => {
    const { context } = fixture();
    const state = AgentProtocol.createResponsesReasoningState({ output: [item()] }, options);
    const base = { messages: [{ role: "assistant", content: "answer", __aiuiResponsesReasoning: state }],
        __aiuiStructuredResponsesInput: true };
    const other = context.buildRequestPayloadForEndpoint({ ...base, model: "gpt-other" }, "/responses");
    assert.ok(!JSON.stringify(other).includes("OPAQUE_COMPLETE"));
    const restored = context.buildRequestPayloadForEndpoint({ ...base, model: options.model }, "/responses");
    assert.ok(JSON.stringify(restored).includes("OPAQUE_COMPLETE"));
});

test("ordinary nonstreaming Responses persist reasoning state and use structured input on the next turn", async () => {
    const f = fixture({ ok: true, body: null, json: async () => ({ output: [item(), output] }) });
    await f.context.requestAI("问题", options.model, f.chat);
    const saved = f.chat.messages.at(-1);
    assert.equal(saved.content, "实际回答");
    assert.deepEqual(same(saved.responsesReasoning.items), [item()]);
    assert.equal(f.requests[0].__aiuiStructuredResponsesInput, true);
    const messages = await f.context.buildAPIMessagesWithContext(f.chat);
    const payload = f.context.buildRequestPayloadForEndpoint({ model: options.model, messages }, "/responses");
    assert.ok(payload.input.some(entry => entry.type === "reasoning" && entry.encrypted_content === "OPAQUE_COMPLETE"));
});

test("ordinary streamed Responses retain completed reasoning even when the relay reuses SSE ids", async () => {
    const events = [
        { type: "response.reasoning_summary_text.delta", delta: "safe summary" },
        { type: "response.output_item.added", item: item("rs_1", "INCOMPLETE") },
        { type: "response.output_item.done", item: item() },
        { type: "response.completed", response: { output: [item(), output] } }
    ];
    const bytes = events.map(event => new TextEncoder().encode(`id: reused\ndata: ${JSON.stringify(event)}\n\n`));
    let index = 0;
    const f = fixture({ ok: true, body: { getReader: () => ({ read: async () => index < bytes.length
        ? { done: false, value: bytes[index++] } : { done: true } }) } });
    await f.context.requestAI("问题", options.model, f.chat);
    assert.equal(f.chat.messages.at(-1).content, "实际回答");
    assert.deepEqual(same(f.chat.messages.at(-1).responsesReasoning.items), [item()]);
});
