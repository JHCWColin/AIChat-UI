const test = require("node:test");
const assert = require("node:assert/strict");
const { estimate, splitAgentPrompt } = require("../context-estimator");

const tokenizer = {
    count: text => String(text).trim().split(/\s+/).filter(Boolean).length,
    describe: model => `local:${model}`
};

test("estimates the submitted messages and excludes detached model reasoning text", async () => {
    const result = await estimate([
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "visible answer", reasoning: "private chain of thought" }
    ], { model: "gpt-5.6-sol", contextWindow: 100, tokenizer });

    assert.equal(result.categories.systemPrompt, 2);
    assert.equal(result.categories.messages, 2);
    assert.equal(result.usedTokens, 12);
    assert.equal(result.tokenizerLabel, "local:gpt-5.6-sol");
});

test("separates Agent tool instructions, tool results, attachments and explicit reasoning items", async () => {
    const prompt = "Tool Definitions\n\nread_file\n\nCore Agent Rules\n\nRules\n\nUser System Prompt\n\nBe concise";
    const split = splitAgentPrompt(prompt);
    assert.match(split.systemTools, /Tool Definitions/);
    assert.match(split.systemTools, /Core Agent Rules/);
    assert.equal(split.systemPrompt, "User System Prompt\n\nBe concise");

    const result = await estimate([
        { role: "system", content: prompt },
        { role: "user", content: "[Tool Result: read_file]\nline one" },
        { role: "user", content: [{ type: "text", text: "See attached" }, { type: "input_image" }] },
        { role: "assistant", content: [{ type: "reasoning", text: "retained summary" }] }
    ], { model: "claude-sonnet-5", contextWindow: 1000, tokenizer, agent: true });

    assert(result.categories.systemTools > 0);
    assert.equal(result.categories.systemPrompt, 5);
    assert(result.categories.toolResults > 0);
    assert.equal(result.categories.images, 768);
    assert.equal(result.categories.reasoningItems, 2);
    assert.equal(result.reserveTokens, 80);
});

test("counts file labels in the attachment category and reserves compaction space only for Agent chats", async () => {
    const text = "Please inspect this\n\n[文件: notes.txt]\nalpha beta\n[/文件: notes.txt]";
    const result = await estimate([{ role: "user", content: text }], { contextWindow: 100, tokenizer });

    assert.equal(result.categories.messages, 3);
    assert(result.categories.attachments > 0);
    assert.equal(result.reserveTokens, 0);
    assert.equal(result.freeTokens + result.usedTokens, 100);
});

test("uses known local GPT vocabularies and labels unpublished vendor vocabularies as generic", () => {
    const localTokenizer = require("../tokenizer-runtime.cjs");

    assert.equal(localTokenizer.describe("gpt-4"), "cl100k_base");
    assert.equal(localTokenizer.describe("gpt-5.6-sol"), "o200k_base");
    assert.equal(localTokenizer.describe("claude-sonnet-5"), "Claude Sonnet · 通用 o200k_base 参考估算");
    assert.equal(localTokenizer.describe("deepseek-v4-pro-0813"), "DeepSeek V4 官方词表（本地）");
    assert.match(localTokenizer.describe("deepseek-v5"), /参考估算/);
    assert(localTokenizer.count("中文 and code: const answer = 42;", "gpt-5.6-sol") > 0);
    assert(localTokenizer.count("中文 and code: const answer = 42;", "claude-sonnet-5") > 0);
});

test("counts top-level Responses reasoning summaries while treating encrypted state as opaque", async () => {
    const observed = [];
    const result = await estimate([
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "retained summary" }],
            encrypted_content: "DO_NOT_TOKENIZE_ENCRYPTED_STATE".repeat(500) },
        { role: "assistant", content: [{ type: "output_text", text: "visible answer" }], reasoning: "PRIVATE_THOUGHT" }
    ], { contextWindow: 100, tokenizer: { count: text => { observed.push(text); return tokenizer.count(text); } } });
    assert.equal(result.categories.reasoningItems, 2);
    assert.equal(result.categories.messages, 2);
    assert.equal(result.usedTokens, 8);
    assert.equal(result.opaqueReasoningItems, 1);
    assert.equal(result.hasOpaqueReasoningItems, true);
    assert.ok(observed.every(text => !/ENCRYPTED_STATE|PRIVATE_THOUGHT/.test(text)));
});

test("counts summary and reasoning_text content arrays without counting opaque-only items as message text", async () => {
    const result = await estimate([
        { type: "reasoning", summary: [], encrypted_content: "abc" },
        { role: "assistant", content: [{ type: "reasoning",
            summary: [{ type: "summary_text", text: "summary one" }],
            content: [{ type: "reasoning_text", text: "retained content" }], encrypted_content: "def" }] }
    ], { contextWindow: 100, tokenizer });
    assert.equal(result.categories.reasoningItems, 4);
    assert.equal(result.usedTokens, 8);
    assert.equal(result.opaqueReasoningItems, 2);
});
