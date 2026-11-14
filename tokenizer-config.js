'use strict';
/*
 * Persists the user-editable Tokenizer / context-capacity rules and owns the
 * uploaded HuggingFace tokenizer.json files. Files are copied into the app data
 * directory so a rule keeps working after the original file is moved.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Rules = require('./tokenizer-rules.js');

const MAX_FILE_BYTES = 80 * 1024 * 1024;
const ALLOWED_EXTENSION = /\.json$/i;

function createTokenizerConfig(app) {
    const root = () => path.join(app.getPath('userData'), 'tokenizers');
    const filesDir = () => path.join(root(), 'files');
    const configPath = () => path.join(root(), 'config.json');
    let cache = null;
    let validator = null;

    function ensureDirs() {
        fs.mkdirSync(filesDir(), { recursive: true });
    }

    function readConfig() {
        if (cache) return cache;
        let raw = null;
        try { raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (_) { /* first run */ }
        cache = Rules.normalizeConfig(raw);
        return cache;
    }

    function writeConfig(next) {
        const normalized = Rules.normalizeConfig(next);
        ensureDirs();
        const file = configPath();
        const temporary = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2), 'utf8');
        fs.renameSync(temporary, file);
        cache = normalized;
        return normalized;
    }

    function listFiles() {
        try {
            return fs.readdirSync(filesDir())
                .filter(name => ALLOWED_EXTENSION.test(name))
                .map(name => {
                    const full = path.join(filesDir(), name);
                    let size = 0;
                    let modified = 0;
                    try { const stat = fs.statSync(full); size = stat.size; modified = stat.mtimeMs; } catch (_) { /* ignore */ }
                    // Stored ids carry a content hash for de-duplication; the UI
                    // shows the file's original name instead.
                    return { id: name, name: name.replace(/-[0-9a-f]{8}(\.json)$/i, '$1'), storedName: name, size, modified };
                })
                .sort((a, b) => a.name.localeCompare(b.name));
        } catch (_) {
            return [];
        }
    }

    function publicConfig() {
        const config = readConfig();
        return { ...config, files: listFiles(), storageDir: filesDir() };
    }

    function slugify(name) {
        const base = String(name || 'tokenizer').replace(/\.[^.]+$/, '');
        const safe = base.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 48);
        return safe || 'tokenizer';
    }

    // The bundled runtime is only loaded when a vocabulary is imported.
    function getValidator() {
        if (!validator) validator = require('./tokenizer-runtime.cjs');
        return validator;
    }

    function importFile(payload) {
        const name = String(payload?.name || '').trim();
        const content = String(payload?.content == null ? '' : payload.content);
        if (!ALLOWED_EXTENSION.test(name)) return { ok: false, error: '只接受 HuggingFace 的 tokenizer.json 文件' };
        if (!content.trim()) return { ok: false, error: '文件内容为空' };
        if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) return { ok: false, error: '文件超过 80MB 上限' };
        // Parse and actually encode a sample before anything touches the disk.
        let info;
        try { info = getValidator().validateJsonTokenizer(content); } catch (error) { return { ok: false, error: error.message || String(error) }; }
        ensureDirs();
        const hash = crypto.createHash('sha1').update(content).digest('hex').slice(0, 8);
        const id = `${slugify(name)}-${hash}.json`;
        const target = path.join(filesDir(), id);
        if (!fs.existsSync(target)) fs.writeFileSync(target, content, 'utf8');
        return {
            ok: true,
            file: {
                id,
                name: String(payload?.originalName || name),
                size: Buffer.byteLength(content, 'utf8'),
                vocabulary: info.vocabulary || 0
            },
            config: publicConfig()
        };
    }

    function deleteFile(id) {
        const name = path.basename(String(id || ''));
        if (!name) return publicConfig();
        const config = readConfig();
        writeConfig({
            ...config,
            tokenizerRules: config.tokenizerRules.filter(rule => rule.engine !== `file:${name}`)
        });
        try { fs.unlinkSync(path.join(filesDir(), name)); } catch (_) { /* already gone */ }
        return publicConfig();
    }

    return {
        publicConfig,
        readConfig,
        writeConfig,
        importFile,
        deleteFile,
        listFiles,
        ensureDirs,
        filesDir
    };
}

module.exports = { createTokenizerConfig };
