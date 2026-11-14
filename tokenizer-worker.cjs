const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const tokenizer = require('./tokenizer-runtime.cjs');

const FALLBACK_LABEL = '通用 o200k_base 参考估算';
const fileEngines = new Map();
const regexCache = new Map();
let storageDir = '';

function normalizePattern(value) {
    return String(value == null ? '' : value).trim();
}

function compileRegex(source) {
    const key = String(source || '');
    if (regexCache.has(key)) return regexCache.get(key);
    let compiled = null;
    try { compiled = new RegExp(key, 'i'); } catch (_) { compiled = null; }
    if (regexCache.size > 200) regexCache.clear();
    regexCache.set(key, compiled);
    return compiled;
}

function ruleMatches(rule, model) {
    const isRegex = Boolean(rule && rule.regex === true);
    const pattern = normalizePattern(rule && rule.pattern);
    if (!pattern) return false;
    const name = String(model || '').trim().toLowerCase();
    if (!name) return false;
    const base = name.split('/').pop();
    const names = base && base !== name ? [base, name] : [name];
    if (isRegex) {
        const compiled = compileRegex(pattern);
        if (!compiled) return false;
        return names.some(candidate => { compiled.lastIndex = 0; return compiled.test(candidate); });
    }
    const needle = pattern.toLowerCase();
    return names.some(candidate => candidate.startsWith(needle));
}

function selectRule(rules, model) {
    for (const rule of Array.isArray(rules) ? rules : []) {
        if (!rule || rule.enabled === false) continue;
        if (ruleMatches(rule, model)) return rule;
    }
    return null;
}

async function loadFileEngine(engine) {
    const name = path.basename(String(engine || '').slice(5));
    const fullPath = path.join(storageDir, name);
    const stat = fs.statSync(fullPath);
    const cached = fileEngines.get(name);
    if (cached && cached.mtime === stat.mtimeMs) return cached;
    tokenizer.forgetJsonTokenizer(fullPath);
    const count = tokenizer.loadJsonTokenizer(fullPath);
    const entry = {
        mtime: stat.mtimeMs,
        count: text => count(text),
        label: `自定义词表：${name.replace(/-[0-9a-f]{8}\.json$/i, '.json')}`
    };
    fileEngines.set(name, entry);
    return entry;
}

function pruneFileCache(knownFiles) {
    for (const key of [...fileEngines.keys()]) if (!knownFiles.has(key)) fileEngines.delete(key);
}

async function countWithEngine(engine, texts, model) {
    if (String(engine).startsWith('file:')) {
        const loaded = await loadFileEngine(engine);
        const counts = [];
        for (const text of texts) counts.push(await loaded.count(text));
        return { counts, label: loaded.label, generic: false };
    }
    const label = tokenizer.describeEngine(engine, model);
    return {
        counts: texts.map(text => tokenizer.countByEngine(engine, text, model)),
        label,
        // A borrowed vocabulary (e.g. o200k for an unknown GPT version) is still
        // an estimate even when the engine itself is exact.
        generic: tokenizer.isGenericEngine(engine) || /参考估算|估算/.test(label)
    };
}

parentPort.on('message', async message => {
    const id = message && message.id;
    try {
        const texts = Array.isArray(message.texts) ? message.texts : [];
        const model = String(message.model || '');
        if (typeof message.storageDir === 'string' && message.storageDir) storageDir = message.storageDir;
        if (Array.isArray(message.files)) pruneFileCache(new Set(message.files.map(name => path.basename(String(name)))));

        const rule = message.preview && message.preview.engine
            ? { engine: String(message.preview.engine) }
            : selectRule(message.rules, model);
        const fallbackEngine = typeof message.defaultEngine === 'string' && message.defaultEngine ? message.defaultEngine : 'builtin:fallback';
        const engine = rule && rule.engine ? String(rule.engine) : fallbackEngine;

        try {
            const result = await countWithEngine(engine, texts, model);
            parentPort.postMessage({ id, counts: result.counts, label: result.label, generic: result.generic, engine });
        } catch (error) {
            // A broken vocabulary must not disable token accounting: fall back
            // to the generic estimate and report why.
            parentPort.postMessage({
                id,
                counts: texts.map(text => tokenizer.countByEngine('builtin:fallback', text, '')),
                label: FALLBACK_LABEL,
                generic: true,
                engine: 'builtin:fallback',
                error: error && error.message ? error.message : String(error)
            });
        }
    } catch (error) {
        parentPort.postMessage({ id, error: error && error.message ? error.message : String(error) });
    }
});
