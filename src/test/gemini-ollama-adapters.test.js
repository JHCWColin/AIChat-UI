const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

const names = [
    "isGeminiEndpoint", "isOllamaEndpoint", "toGeminiParts", "extractGeminiCandidateParts", "buildGeminiPayloadFromBase",
    "buildOllamaPayloadFromBase", "extractGeminiStreamUpdate", "extractGeminiOutputText",
    "extractOllamaStreamUpdate", "extractOllamaOutputText", "buildGeminiRequestUrl", "buildOllamaRequestUrl"
];

function loadAdapters(baseUrl = "https://generativelanguage.googleapis.com/v1beta") {
    const sources = names.map(name => {
        const match = html.match(new RegExp(`^        function ${name}\\b[\\s\\S]*?\\n        \\}`, "m"));
        if (!match) throw new Error(`Cannot extract ${name} from index.html`);
        return match[0];
    }).join("\n");
    const context = { getBaseURL: () => baseUrl, encodeURIComponent, console };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(sources, context, { filename: "gemini-ollama-adapters.js" });
    return context;
}

const imageDataUrl = "data:image/png;base64,iVBORw0KGgo=";

test("Gemini payload maps system, turns, images and generation config", () => {
    const api = loadAdapters();
    const payload = api.buildGeminiPayloadFromBase({
        model: "gemini-4-neon",
        max_tokens: 2048,
        temperature: 0.4,
        messages: [
            { role: "system", content: "你是严谨的助手。" },
            { role: "user", content: "看图说明" },
            { role: "user", content: [{ type: "text", text: "补充一句" }, { type: "image_url", image_url: { url: imageDataUrl } }] },
            { role: "assistant", content: "好的。" },
            { role: "user", content: "继续" }
        ]
    });
    assert.equal(payload.systemInstruction.parts[0].text, "你是严谨的助手。");
    assert.equal(payload.contents.length, 3);
    assert.equal(payload.contents[0].role, "user");
    // 连续两条 user 合并为一个 content，保证 user/model 交替。
    assert.equal(payload.contents[0].parts.length, 3);
    assert.equal(payload.contents[0].parts[0].text, "看图说明");
    assert.deepEqual(JSON.parse(JSON.stringify(payload.contents[0].parts[2].inline_data)), { mime_type: "image/png", data: "iVBORw0KGgo=" });
    assert.equal(payload.contents[1].role, "model");
    assert.equal(payload.contents[1].parts[0].text, "好的。");
    assert.equal(payload.generationConfig.maxOutputTokens, 2048);
    assert.equal(payload.generationConfig.temperature, 0.4);
    // 原生协议不使用 OpenAI 的 messages / stream 字段。
    assert.equal(payload.messages, undefined);
});

test("Gemini stream parsing separates thought parts from answer parts", () => {
    const api = loadAdapters();
    const update = api.extractGeminiStreamUpdate({
        candidates: [{ content: { parts: [{ text: "先想一想", thought: true }, { text: "答案" }] } }]
    });
    assert.equal(update.reasoningDelta, "先想一想");
    assert.equal(update.contentDelta, "答案");
    assert.equal(api.extractGeminiOutputText({ candidates: [{ content: { parts: [{ text: "想", thought: true }, { text: "答案" }] } }] }), "答案");
});

test("Gemini request URL targets the native action and never duplicates the models prefix", () => {
    const api = loadAdapters("https://generativelanguage.googleapis.com/v1beta/");
    assert.equal(api.buildGeminiRequestUrl("gemini-4-neon", true),
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse");
    assert.equal(api.buildGeminiRequestUrl("models/gemini-4-neon", false),
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:generateContent");
});

test("Ollama payload maps options and strips image data URL prefixes", () => {
    const api = loadAdapters("http://127.0.0.1:11434");
    const payload = api.buildOllamaPayloadFromBase({
        model: "llama4:70b",
        max_tokens: 512,
        temperature: 0.2,
        messages: [
            { role: "system", content: "系统提示" },
            { role: "user", content: [{ type: "text", text: "描述这张图" }, { type: "image_url", image_url: { url: imageDataUrl } }] },
            { role: "assistant", content: "已收到。" }
        ]
    });
    assert.equal(payload.model, "llama4:70b");
    assert.equal(payload.stream, true);
    assert.equal(payload.messages.length, 3);
    assert.equal(payload.messages[1].content, "描述这张图");
    assert.deepEqual(JSON.parse(JSON.stringify(payload.messages[1].images)), ["iVBORw0KGgo="]);
    assert.equal(payload.options.num_predict, 512);
    assert.equal(payload.options.temperature, 0.2);
    assert.equal(api.buildOllamaRequestUrl(), "http://127.0.0.1:11434/api/chat");
});

test("Ollama stream parsing reads content and thinking from NDJSON messages", () => {
    const api = loadAdapters();
    assert.deepEqual(JSON.parse(JSON.stringify(api.extractOllamaStreamUpdate({ message: { content: "片段" }, done: false }))), { contentDelta: "片段" });
    assert.deepEqual(JSON.parse(JSON.stringify(api.extractOllamaStreamUpdate({ message: { content: "", thinking: "推理" } }))), { reasoningDelta: "推理" });
    assert.equal(api.extractOllamaOutputText({ message: { content: "完整回答" } }), "完整回答");
});

test("endpoint guards only match the native protocols", () => {
    const api = loadAdapters();
    assert.equal(api.isGeminiEndpoint("/gemini"), true);
    assert.equal(api.isOllamaEndpoint("/ollama"), true);
    for (const endpoint of ["/responses", "/chat/completions", "/v1/messages"]) {
        assert.equal(api.isGeminiEndpoint(endpoint), false);
        assert.equal(api.isOllamaEndpoint(endpoint), false);
    }
});
