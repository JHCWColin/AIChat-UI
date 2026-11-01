import { encode as encodeCl100k } from "gpt-tokenizer/model/gpt-4";
import { encode as encodeO200k } from "gpt-tokenizer/model/gpt-4o";
import { countTokens as countClaudeTokens } from "@anthropic-ai/tokenizer";
import { Tokenizer } from "@huggingface/tokenizers";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const legacyOpenAIModel = /^(?:gpt-3\.5|gpt-4(?:-|$)|text-embedding-)/i;
const deepSeekTokenizers = new Map();

function deepSeekFamily(model) {
    // Match only explicit released families. API aliases and relays may point at
    // a different tokenizer, so never silently claim that they are an exact match.
    const name = String(model || "").split("/").pop().replace(/_/g, "-");
    if (/^deepseek-flash$/i.test(name)) return "deepseek-v41";
    if (/^deepseek-v(?:4\.1|41)(?:-|$)/i.test(name)) return "deepseek-v41";
    if (/^deepseek-v4(?:-pro(?:-|$)|$)/i.test(name)) return "deepseek-v4";
    return null;
}

function getDeepSeekTokenizer(family) {
    if (!deepSeekTokenizers.has(family)) {
        const data = JSON.parse(gunzipSync(readFileSync(join(__dirname, "tokenizer-assets", `${family}.json.gz`))));
        // No model weights, downloads, worker, or file:// fetch is involved. The
        // vocabulary is loaded lazily inside Electron's existing preload process.
        deepSeekTokenizers.set(family, new Tokenizer(data, { clean_up_tokenization_spaces: false }));
    }
    return deepSeekTokenizers.get(family);
}

module.exports = Object.freeze({
    count(text, model = "") {
        const value = String(text || "");
        if (!value) return 0;
        const family = deepSeekFamily(model);
        if (family) return getDeepSeekTokenizer(family).encode(value, { add_special_tokens: false }).ids.length;
        if (/^claude-/i.test(String(model))) {
            try {
                return countClaudeTokens(value);
            } catch (_) {
                return encodeO200k(value).length;
            }
        }
        const encoder = legacyOpenAIModel.test(String(model)) ? encodeCl100k : encodeO200k;
        return encoder(value).length;
    },
    describe(model = "") {
        const name = String(model || "");
        const family = deepSeekFamily(name);
        if (family === "deepseek-v4") return "DeepSeek V4 官方词表（本地）";
        if (family === "deepseek-v41") return /^deepseek-flash$/i.test(name.split("/").pop())
            ? "DeepSeek Flash → V4.1 官方词表（本地）" : "DeepSeek V4.1 官方词表（本地）";
        if (/deepseek/i.test(name)) return "DeepSeek 版本未知 · 通用 o200k_base 参考估算";
        if (/^claude-/i.test(name)) return "Anthropic 旧词表参考估算";
        if (/^(?:gpt-|o[134](?:-|$))/i.test(name)) {
            return legacyOpenAIModel.test(name) ? "OpenAI cl100k_base" : "OpenAI o200k_base";
        }
        return "通用 o200k_base 参考估算";
    }
});
