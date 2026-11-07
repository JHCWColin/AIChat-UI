const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { gunzipSync } = require("node:zlib");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const localTokenizer = require("../tokenizer-runtime.cjs");

const root = path.resolve(__dirname, "..");

test("vendored DeepSeek vocabularies have pinned hashes and separate special tokens", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "tokenizer-assets/manifest.json"), "utf8"));
    const vocabularies = {};
    for (const family of ["deepseek-v4", "deepseek-v41"]) {
        const data = gunzipSync(fs.readFileSync(path.join(root, "tokenizer-assets", `${family}.json.gz`)));
        assert.equal(createHash("sha256").update(data).digest("hex"), manifest[family].sha256);
        vocabularies[family] = JSON.parse(data);
        assert.equal(Object.keys(vocabularies[family].model.vocab).length, 128000);
    }
    assert.equal(vocabularies["deepseek-v4"].added_tokens.find(token => token.id === 129279).content, "<｜image｜>");
    assert.equal(vocabularies["deepseek-v41"].added_tokens.find(token => token.id === 129264).content, "<｜deepseek_image｜>");
    assert.notEqual(manifest["deepseek-v4"].sha256, manifest["deepseek-v41"].sha256);
});

test("DeepSeek official vocabulary counts text, CJK, code and emoji locally", () => {
    const fixtures = [
        ["Hello!", 2],
        ["你好，世界！", 4],
        ["const total = items.reduce((sum, item) => sum + item.value, 0);", 19],
        ["", 0]
    ];
    for (const model of ["deepseek-v4-pro-0813", "deepseek-v4.1-flash-1017"]) {
        for (const [text, expected] of fixtures) assert.equal(localTokenizer.count(text, model), expected);
        assert(localTokenizer.count("家族👨‍👩‍👧‍👦与标点…", model) > 0);
    }
    assert.equal(localTokenizer.count("<｜image｜>", "deepseek-v4-pro"), 1);
    assert.equal(localTokenizer.count("<｜image｜>", "deepseek-v4.1-flash"), 5);
    assert.equal(localTokenizer.count("<｜deepseek_image｜>", "deepseek-v4.1-flash"), 1);
});

test("known DeepSeek model families select matching labels and unknown aliases stay estimates", () => {
    assert.equal(localTokenizer.describe("deepseek-v4-pro-0813"), "DeepSeek V4 官方词表（本地）");
    assert.equal(localTokenizer.describe("openrouter/deepseek-v4.1-flash"), "DeepSeek V4.1 官方词表（本地）");
    assert.equal(localTokenizer.describe("deepseek-flash"), "DeepSeek Flash → V4.1 官方词表（本地）");
    for (const model of ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash", "deepseek-v5-pro"]) {
        assert.match(localTokenizer.describe(model), /版本未知.*参考估算/);
        assert.equal(localTokenizer.count("你好，世界！", model), localTokenizer.count("你好，世界！", "unknown-model"));
    }
    for (const model of ['claude-sonnet-5','claude-sonnet-4-6','claude-3-7-sonnet-20250219','claude-opus-4-8','anthropic/claude-opus-5','claude-fable-5-1','claude_fable_5']) {
        assert.match(localTokenizer.describe(model),/Claude (Sonnet|Opus|Fable).*参考估算/);
        assert.equal(localTokenizer.count('你好，世界！',model),localTokenizer.count('你好，世界！','unknown-model'));
    }
});

test("tokenizer runtime works outside the project cwd without network or installed model packages", () => {
    const runtime = path.join(root, "tokenizer-runtime.cjs");
    const script = `
        const Module = require('node:module');
        const originalRequire = Module.prototype.require;
        Module.prototype.require = function(name) {
            if (['http', 'https', 'node:http', 'node:https', '@huggingface/tokenizers', 'gpt-tokenizer'].includes(name))
                throw new Error('Forbidden runtime dependency: ' + name);
            return originalRequire.apply(this, arguments);
        };
        global.fetch = () => { throw new Error('Network must stay disabled'); };
        const tokenizer = require(${JSON.stringify(runtime)});
        console.log(JSON.stringify([tokenizer.count('你好，世界！', 'deepseek-v4-pro'), tokenizer.count('<｜deepseek_image｜>', 'deepseek-v4.1-flash')]));
    `;
    const result = spawnSync(process.execPath, ["-e", script], { cwd: require("node:os").tmpdir(), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [4, 1]);
});
