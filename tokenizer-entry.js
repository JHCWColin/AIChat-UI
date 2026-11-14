import { encode as encodeCl100k } from "gpt-tokenizer/model/gpt-4";
import { encode as encodeO200k } from "gpt-tokenizer/model/gpt-4o";
import { Tokenizer } from "@huggingface/tokenizers";
import anthropicRanks from "@anthropic-ai/tokenizer/claude.json";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const legacyOpenAIModel = /^(?:gpt-3\.5|gpt-4(?:-|$)|text-embedding-)/i;
const bundledTokenizers = new Map();
const jsonTokenizers = new Map();

const ENGINE_LABELS = {
    "builtin:openai-o200k": "o200k_base",
    "builtin:openai-cl100k": "cl100k_base",
    "builtin:deepseek-v4": "DeepSeek V4 官方词表（本地）",
    "builtin:deepseek-v41": "DeepSeek V4.1 官方词表（本地）",
    "builtin:anthropic": "Anthropic Claude 词表（本地）",
    "builtin:qwen": "Qwen 词表（本地）",
    "builtin:glm": "GLM 词表（本地）",
    "builtin:llama": "Llama 词表（本地）",
    "builtin:mistral": "Mistral 词表（本地）",
    "builtin:yi": "Yi 词表（本地）",
    "builtin:internlm": "InternLM 词表（本地）",
    "builtin:gemma": "Gemma 词表（本地）",
    "builtin:fallback": "通用 o200k_base 参考估算"
};

function deepSeekFamily(model) {
    // Match only explicit released families. API aliases and relays may point at
    // a different tokenizer, so never silently claim that they are an exact match.
    const name = String(model || "").split("/").pop().replace(/_/g, "-");
    if (/^deepseek-flash$/i.test(name)) return "deepseek-v41";
    if (/^deepseek-v(?:4\.1|41)(?:-|$)/i.test(name)) return "deepseek-v41";
    if (/^deepseek-v4(?:-pro(?:-|$)|$)/i.test(name)) return "deepseek-v4";
    return null;
}

function getBundledTokenizer(family) {
    if (!bundledTokenizers.has(family)) {
        const data = JSON.parse(gunzipSync(readFileSync(join(__dirname, "tokenizer-assets", `${family}.json.gz`))));
        // No model weights, downloads, worker, or file:// fetch is involved. The
        // vocabulary is loaded lazily inside Electron's existing preload process.
        bundledTokenizers.set(family, new Tokenizer(data, { clean_up_tokenization_spaces: false }));
    }
    return bundledTokenizers.get(family);
}

function countBundled(family, value) {
    return getBundledTokenizer(family).encode(value, { add_special_tokens: false }).ids.length;
}

// Anthropic ships its published tokenizer as a Base64 tiktoken vocabulary.
// The bundled pure-JS BPE produces exactly the same counts as the official
// package without pulling in tiktoken's WASM build.
const claudeBpe = { ready: false, ranks: null, pattern: null, cache: new Map() };

function ensureClaudeBpe() {
    if (claudeBpe.ready) return;
    const ranks = new Map();
    const tokens = String(anthropicRanks.bpe_ranks || "").split(" ");
    for (let index = 0; index < tokens.length; index += 1) {
        ranks.set(Buffer.from(tokens[index], "base64").toString("latin1"), index);
    }
    claudeBpe.ranks = ranks;
    claudeBpe.pattern = new RegExp(anthropicRanks.pat_str, "gu");
    claudeBpe.ready = true;
}

function countClaudePiece(piece) {
    const cached = claudeBpe.cache.get(piece);
    if (cached !== undefined) return cached;
    let parts = piece.split("");
    while (parts.length > 1) {
        let mergeAt = -1;
        let mergeRank = Infinity;
        for (let index = 0; index < parts.length - 1; index += 1) {
            const rank = claudeBpe.ranks.get(parts[index] + parts[index + 1]);
            if (rank !== undefined && rank < mergeRank) { mergeRank = rank; mergeAt = index; }
        }
        if (mergeAt < 0) break;
        const left = parts[mergeAt];
        const right = parts[mergeAt + 1];
        const merged = [];
        for (let index = 0; index < parts.length;) {
            if (index < parts.length - 1 && parts[index] === left && parts[index + 1] === right) {
                merged.push(left + right);
                index += 2;
            } else {
                merged.push(parts[index]);
                index += 1;
            }
        }
        parts = merged;
    }
    if (claudeBpe.cache.size < 50000) claudeBpe.cache.set(piece, parts.length);
    return parts.length;
}

function countClaude(value) {
    ensureClaudeBpe();
    const pieces = value.normalize("NFKC").match(claudeBpe.pattern) || [];
    let total = 0;
    for (const piece of pieces) {
        let cursor = 0;
        while (cursor < piece.length) {
            let end = Math.min(cursor + 2048, piece.length);
            // Never cut a surrogate pair in half.
            if (end < piece.length) {
                const code = piece.charCodeAt(end - 1);
                if (code >= 0xd800 && code <= 0xdbff) end -= 1;
            }
            const slice = piece.slice(cursor, end);
            cursor = end;
            total += countClaudePiece(Buffer.from(slice, "utf8").toString("latin1"));
        }
    }
    return total;
}

function countLegacy(text, model = "") {
    const value = String(text || "");
    if (!value) return 0;
    const family = deepSeekFamily(model);
    if (family) return countBundled(family, value);
    const encoder = legacyOpenAIModel.test(String(model).split("/").pop()) ? encodeCl100k : encodeO200k;
    return encoder(value).length;
}

function describeLegacy(model = "") {
    const name = String(model || "");
    const family = deepSeekFamily(name);
    if (family === "deepseek-v4") return "DeepSeek V4 官方词表（本地）";
    if (family === "deepseek-v41") return /^deepseek-flash$/i.test(name.split("/").pop())
        ? "DeepSeek Flash → V4.1 官方词表（本地）" : "DeepSeek V4.1 官方词表（本地）";
    if (/deepseek/i.test(name)) return "DeepSeek 版本未知 · 通用 o200k_base 参考估算";
    const claudeFamily = name.split('/').pop().replace(/_/g, '-').match(/^claude-(?:(?:\d+(?:\.\d+)?-)+)?(sonnet|opus|fable)(?:-|$)/i);
    if (claudeFamily) return `Claude ${claudeFamily[1][0].toUpperCase() + claudeFamily[1].slice(1).toLowerCase()} · 通用 o200k_base 参考估算`;
    if (/^(?:gpt-(?:3\.5|4|5)(?:[.\-]|$)|o[134](?:-|$))/i.test(name.split('/').pop())) {
        return legacyOpenAIModel.test(name.split('/').pop()) ? "cl100k_base" : "o200k_base";
    }
    return "通用 o200k_base 参考估算";
}

// User supplied HuggingFace tokenizer.json files are loaded once per path and
// reused; the worker drops the cache when the file's mtime changes.
function loadJsonTokenizer(filePath) {
    const key = String(filePath || "");
    if (!jsonTokenizers.has(key)) {
        const data = JSON.parse(readFileSync(key, "utf8"));
        jsonTokenizers.set(key, new Tokenizer(data, { clean_up_tokenization_spaces: false }));
    }
    const tokenizer = jsonTokenizers.get(key);
    return text => tokenizer.encode(String(text || ""), { add_special_tokens: false }).ids.length;
}

function forgetJsonTokenizer(filePath) {
    jsonTokenizers.delete(String(filePath || ""));
}

module.exports = Object.freeze({
    count: countLegacy,
    describe: describeLegacy,
    countByEngine(engine = "", text = "", model = "") {
        const value = String(text || "");
        if (!value) return 0;
        switch (engine) {
            case "builtin:openai-cl100k": return encodeCl100k(value).length;
            case "builtin:openai-o200k": return encodeO200k(value).length;
            case "builtin:deepseek-v4": return countBundled("deepseek-v4", value);
            case "builtin:deepseek-v41": return countBundled("deepseek-v41", value);
            case "builtin:anthropic": return countClaude(value);
            case "builtin:qwen": return countBundled("qwen", value);
            case "builtin:glm": return countBundled("glm", value);
            case "builtin:llama": return countBundled("llama", value);
            case "builtin:mistral": return countBundled("mistral", value);
            case "builtin:yi": return countBundled("yi", value);
            case "builtin:internlm": return countBundled("internlm", value);
            case "builtin:gemma": return countBundled("gemma", value);
            case "builtin:fallback": return encodeO200k(value).length;
            case "builtin:openai-auto":
            default: return countLegacy(value, model);
        }
    },
    describeEngine(engine = "", model = "") {
        if (engine === "builtin:openai-auto") return describeLegacy(model);
        if (engine === "builtin:deepseek-v41" && /^deepseek-flash$/i.test(String(model).split("/").pop())) {
            return "DeepSeek Flash → V4.1 官方词表（本地）";
        }
        return ENGINE_LABELS[engine] || "通用 o200k_base 参考估算";
    },
    isGenericEngine(engine = "") {
        return engine === "builtin:fallback";
    },
    // Uploaded files must be real HuggingFace tokenizer.json documents; a file
    // that cannot be parsed and encode a sample is rejected before it is stored.
    validateJsonTokenizer(text) {
        let data;
        try { data = JSON.parse(text); } catch (error) { throw new Error(`JSON 解析失败：${error.message}`); }
        if (!data || typeof data !== "object" || !data.model) throw new Error("不是 HuggingFace tokenizer.json：缺少 model 字段");
        let instance;
        try { instance = new Tokenizer(data, { clean_up_tokenization_spaces: false }); } catch (error) { throw new Error(`词表无法加载：${error.message}`); }
        let ids;
        try { ids = instance.encode("你好，世界！ Hello, world!", { add_special_tokens: false }).ids; } catch (error) { throw new Error(`词表无法编码文本：${error.message}`); }
        if (!Array.isArray(ids) || !ids.length) throw new Error("词表编码结果为空，文件可能不完整");
        let vocabulary = 0;
        if (data.model && data.model.vocab && typeof data.model.vocab === "object") vocabulary = Object.keys(data.model.vocab).length;
        return { vocabulary, sample: ids.length };
    },
    loadJsonTokenizer,
    forgetJsonTokenizer
});
