const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Rules = require('../shared/tokenizer-rules.js');
const { createTokenizerConfig } = require('../main/tokenizer-config.js');

const root = path.resolve(__dirname, '..');

const WORD_LEVEL_TOKENIZER = {
    version: '1.0',
    truncation: null,
    padding: null,
    added_tokens: [],
    normalizer: null,
    pre_tokenizer: { type: 'Whitespace' },
    post_processor: null,
    decoder: null,
    model: {
        type: 'WordLevel',
        vocab: { '[UNK]': 0, hello: 1, '你好': 2, world: 3 },
        unk_token: '[UNK]'
    }
};

function countWithWorker(payload) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(root, 'main/tokenizer-worker.cjs'));
        const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker timeout')); }, 30000);
        worker.once('message', result => { clearTimeout(timer); worker.terminate(); resolve(result); });
        worker.once('error', error => { clearTimeout(timer); worker.terminate(); reject(error); });
        worker.postMessage({ id: 1, ...payload });
    });
}

test('prefix rules match the first enabled rule and ignore provider prefixes', () => {
    const rules = Rules.normalizeConfig(null).tokenizerRules;
    assert.equal(Rules.resolveRule(rules, 'openrouter/deepseek-v4.1-flash').engine, 'builtin:deepseek-v41');
    assert.equal(Rules.resolveRule(rules, 'deepseek-flash').engine, 'builtin:deepseek-v41');
    assert.equal(Rules.resolveRule(rules, 'gpt-6.1-sol').engine, 'builtin:openai-auto');
    assert.equal(Rules.resolveRule(rules, 'Claude-Sonnet-4-6').engine, 'builtin:anthropic');
    assert.equal(Rules.resolveRule(rules, 'qwen3-32b').engine, 'builtin:qwen');
    assert.equal(Rules.resolveRule(rules, 'glm-4.6').engine, 'builtin:glm');
    assert.equal(Rules.resolveRule(rules, 'llama-3.1-8b').engine, 'builtin:llama');
    assert.equal(Rules.resolveRule(rules, 'mistral-7b').engine, 'builtin:mistral');
    assert.equal(Rules.resolveRule(rules, 'yi-1.5').engine, 'builtin:yi');
    assert.equal(Rules.resolveRule(rules, 'internlm2.5-7b').engine, 'builtin:internlm');
    assert.equal(Rules.resolveRule(rules, 'gemma-3-27b').engine, 'builtin:gemma');
    assert.equal(Rules.resolveRule(rules, 'grok-4.1').engine, 'builtin:fallback');
    assert.equal(Rules.resolveRule(rules, 'doubao-seed-1.6').engine, 'builtin:fallback');
    assert.equal(Rules.resolveRule(rules, 'hunyuan-t1').engine, 'builtin:fallback');
    assert.equal(Rules.resolveRule(rules, 'step-3').engine, 'builtin:fallback');
    assert.equal(Rules.resolveRule(rules, 'moonshot-v1-128k').engine, 'builtin:fallback');
    assert.equal(Rules.resolveRule(rules, 'totally-unknown'), null);
    const disabled = rules.map(rule => ({ ...rule, enabled: rule.id !== 'tok-gpt' }));
    assert.equal(Rules.resolveRule(disabled, 'gpt-6.1-sol'), null);
});

test('regex rules are opt-in, case-insensitive and fall back when invalid', () => {
    const rules = Rules.normalizeConfig({
        tokenizerRules: [
            { id: 'a', pattern: '^gemini-(4|3\\.\\d)', regex: true, engine: 'builtin:fallback' },
            { id: 'b', pattern: 'broken([', regex: true, engine: 'builtin:fallback' }
        ],
        contextRules: []
    }).tokenizerRules;
    assert.equal(Rules.ruleMatches(rules[0], 'gemini-4-argon'), true);
    assert.equal(Rules.ruleMatches(rules[0], 'gemini-2.5-pro'), false);
    assert.equal(Rules.ruleMatches(rules[0], 'openrouter/Gemini-3.8-flash'), true);
    assert.equal(Rules.ruleMatches(rules[1], 'anything'), false);
    assert.equal(Rules.regexError(rules[1]), '正则表达式无效');
    assert.equal(Rules.regexError(rules[0]), null);
});

test('context capacity accepts K/k, M/m, 万 and plain numbers', () => {
    const cases = [
        ['512K', 512000], ['512k', 512000], ['1M', 1000000], ['1m', 1000000],
        ['256000', 256000], ['128 K', 128000], ['1.5M', 1500000], ['64万', 640000],
        ['64W', 640000], ['8千', 8000], ['1,000,000', 1000000], ['512000 tokens', 512000]
    ];
    for (const [input, expected] of cases) assert.equal(Rules.parseTokenValue(input), expected, input);
    for (const input of ['', '0', '-5', 'abc', 'K', '12.5.5']) assert.equal(Rules.parseTokenValue(input), null, input);
    assert.equal(Rules.formatTokenValue(512000), '512K');
    assert.equal(Rules.formatTokenValue(1000000), '1M');
    assert.equal(Rules.formatTokenValue(1500000), '1.5M');
    assert.equal(Rules.formatTokenValue(128000), '128K');
});

test('conflicts cover prefix shadowing, duplicates and regex overlap', () => {
    const shadowed = Rules.detectConflicts([
        { id: 'a', pattern: 'gpt-', enabled: true },
        { id: 'b', pattern: 'gpt-5', enabled: true }
    ]);
    assert.equal(shadowed.length, 1);
    assert.equal(shadowed[0].ruleId, 'b');
    assert.equal(Rules.detectConflicts([
        { id: 'a', pattern: 'gpt-5', enabled: true },
        { id: 'b', pattern: 'gpt-', enabled: true }
    ]).length, 0);
    const duplicate = Rules.detectConflicts([
        { id: 'a', pattern: 'qwen', enabled: true },
        { id: 'b', pattern: 'Qwen', enabled: true }
    ]);
    assert.equal(duplicate.length, 1);
    assert.equal(Rules.detectConflicts([
        { id: 'a', pattern: 'gpt-', enabled: false },
        { id: 'b', pattern: 'gpt-5', enabled: true }
    ]).length, 0);
    const regexOverlap = Rules.detectConflicts([
        { id: 'a', pattern: '^claude-.*', regex: true, enabled: true },
        { id: 'b', pattern: 'claude-opus-5', enabled: true }
    ]);
    assert.equal(regexOverlap.length, 1);
    assert.match(regexOverlap[0].message, /正则规则/);
    // Same source but regex mode matches more names than a prefix, so it is
    // reported as a possible overlap rather than an exact duplicate.
    const mixed = Rules.detectConflicts([
        { id: 'a', pattern: 'qwen', enabled: true },
        { id: 'b', pattern: 'qwen', regex: true, enabled: true }
    ]);
    assert.equal(mixed.length, 1);
    assert.match(mixed[0].message, /重叠/);
});

test('default capacity covers the major text vendors', () => {
    const config = Rules.normalizeConfig(null);
    const window = model => Rules.resolveContextWindow(config.contextRules, model, config.contextDefault.value);
    assert.equal(window('qwen-long'), 10000000);
    assert.equal(window('qwen3-max'), 256000);
    assert.equal(window('glm-4.6'), 200000);
    assert.equal(window('glm-5'), 256000);
    assert.equal(window('kimi-k2'), 256000);
    assert.equal(window('moonshot-v1-128k'), 128000);
    assert.equal(window('grok-4.1-fast'), 2000000);
    assert.equal(window('grok-4'), 256000);
    assert.equal(window('doubao-seed-1.6'), 256000);
    assert.equal(window('hunyuan-t1'), 256000);
    assert.equal(window('step-3'), 64000);
    assert.equal(window('step-2'), 32000);
    assert.equal(window('gemini-3-pro'), 1000000);
});

test('saving rejects empty patterns but keeps user deletions and ordering', () => {
    const validation = Rules.validateConfig({ tokenizerRules: [{ id: 'x', pattern: '  ', engine: 'builtin:fallback' }], contextRules: [] });
    assert.equal(validation.ok, false);
    assert.equal(validation.errors[0].group, 'tokenizer');
    const config = Rules.normalizeConfig({ tokenizerRules: [{ id: 'only', pattern: 'Qwen*', engine: 'builtin:openai-o200k' }], contextRules: [] });
    assert.equal(config.tokenizerRules.length, 1);
    assert.equal(config.tokenizerRules[0].pattern, 'Qwen');
    assert.deepEqual(config.contextRules, []);
});

test('the default rows are editable rules, not fixed constants', () => {
    const config = Rules.normalizeConfig({
        tokenizerRules: [],
        contextRules: [],
        tokenizerDefault: { engine: 'builtin:anthropic' },
        contextDefault: { value: '256K' }
    });
    assert.equal(config.tokenizerDefault.engine, 'builtin:anthropic');
    assert.equal(config.contextDefault.value, 256000);
    assert.equal(Rules.resolveContextWindow(config.contextRules, 'unknown-model', config.contextDefault.value), 256000);
    const fallback = Rules.normalizeConfig({ contextRules: [], contextDefault: { value: 'nonsense' } });
    assert.equal(fallback.contextDefault.value, Rules.DEFAULT_CONTEXT_WINDOW);
});

test('uploaded tokenizer.json files are validated, copied into app storage and drive the worker', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiui-tokenizer-'));
    const config = createTokenizerConfig({ getPath: () => dir });
    const content = JSON.stringify(WORD_LEVEL_TOKENIZER);
    const imported = config.importFile({ name: 'qwen-tokenizer.json', content });
    assert.equal(imported.ok, true, imported.error);
    assert.match(imported.file.id, /^qwen-tokenizer-[0-9a-f]{8}\.json$/);
    assert.equal(imported.file.vocabulary, 4);
    assert.equal(fs.existsSync(path.join(config.filesDir(), imported.file.id)), true);
    assert.equal(path.dirname(path.join(config.filesDir(), imported.file.id)), path.join(dir, 'tokenizers', 'files'));

    const rules = [{ id: 'tok-qwen', pattern: 'qwen', engine: `file:${imported.file.id}`, enabled: true }];
    config.writeConfig({ tokenizerRules: rules, contextRules: [] });
    const result = await countWithWorker({ texts: ['hello 你好 world'], model: 'Qwen3-32B', rules, storageDir: config.filesDir() });
    assert.equal(result.counts[0], 3);
    assert.equal(result.generic, false);
    assert.match(result.label, /自定义词表/);

    const deleted = config.deleteFile(imported.file.id);
    assert.equal(deleted.tokenizerRules.length, 0);
    assert.equal(fs.existsSync(path.join(config.filesDir(), imported.file.id)), false);
});

test('broken or non-HuggingFace uploads are rejected before storage', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiui-tokenizer-bad-'));
    const config = createTokenizerConfig({ getPath: () => dir });
    assert.equal(config.importFile({ name: 'notes.txt', content: 'x' }).ok, false);
    assert.equal(config.importFile({ name: 'empty.json', content: '   ' }).ok, false);
    assert.match(config.importFile({ name: 'broken.json', content: '{oops' }).error, /JSON 解析失败/);
    assert.match(config.importFile({ name: 'plain.json', content: '{"hello":1}' }).error, /缺少 model/);
    assert.match(config.importFile({ name: 'bad-model.json', content: '{"model":{"type":"Nope"}}' }).error, /无法加载|无法编码/);
    assert.equal(config.listFiles().length, 0);
});

test('worker falls back when a stored vocabulary disappears', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiui-tokenizer-missing-'));
    const config = createTokenizerConfig({ getPath: () => dir });
    const result = await countWithWorker({
        texts: ['你好，世界！'],
        model: 'Qwen3-32B',
        rules: [{ id: 'x', pattern: 'qwen', engine: 'file:gone-12345678.json', enabled: true }],
        storageDir: config.filesDir()
    });
    assert.equal(result.generic, true);
    assert.ok(result.counts[0] > 0);
});
