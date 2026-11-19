/*
 * Tokenizer / context-capacity rule model shared by the renderer and the main
 * process. A rule is "model name -> engine or token budget"; rules are ordered
 * and the first enabled match wins. Matching is a case-insensitive prefix by
 * default, or a user-supplied regular expression when a rule opts in.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.AIUITokenizerRules = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    const DEFAULT_CONTEXT_WINDOW = 128000;
    const MAX_CONTEXT_WINDOW = 100000000;

    // Built-in engines implemented by tokenizer-runtime.cjs. Uploaded
    // vocabularies are addressed as "file:<stored file name>".
    const ENGINES = Object.freeze([
        { id: "builtin:openai-auto", label: "OpenAI 自动", detail: "gpt-3.5 / gpt-4 用 cl100k_base，其余用 o200k_base。" },
        { id: "builtin:openai-o200k", label: "o200k_base", detail: "GPT-4o 及之后的官方词表。" },
        { id: "builtin:openai-cl100k", label: "cl100k_base", detail: "GPT-3.5 / GPT-4 的官方词表。" },
        { id: "builtin:deepseek-v4", label: "DeepSeek V4（本地）", detail: "随应用打包的 DeepSeek V4 词表。" },
        { id: "builtin:deepseek-v41", label: "DeepSeek V4.1（本地）", detail: "deepseek-flash 也使用它。" },
        { id: "builtin:anthropic", label: "Claude 词表（本地）", detail: "Anthropic 公布的分词器，本地精确计算。" },
        { id: "builtin:qwen", label: "Qwen（本地）", detail: "Qwen3 / Qwen2.5 官方词表，随应用打包。" },
        { id: "builtin:glm", label: "GLM（本地）", detail: "GLM-4.5 系列官方词表，随应用打包。" },
        { id: "builtin:llama", label: "Llama（本地）", detail: "Llama 3.x 官方词表，随应用打包。" },
        { id: "builtin:mistral", label: "Mistral（本地）", detail: "Mistral 7B 系列官方词表，随应用打包。" },
        { id: "builtin:yi", label: "Yi（本地）", detail: "Yi 1.5 系列官方词表，随应用打包。" },
        { id: "builtin:internlm", label: "InternLM（本地）", detail: "InternLM2.5 官方词表，随应用打包。" },
        { id: "builtin:gemma", label: "Gemma（本地）", detail: "Gemma 3 官方词表，随应用打包。" },
        { id: "builtin:fallback", label: "通用估算（o200k）", detail: "复用 o200k_base，界面标注为通用预估。" }
    ]);

    const ENGINE_IDS = ENGINES.map(engine => engine.id);
    const ENGINE_MAP = Object.create(null);
    for (const engine of ENGINES) ENGINE_MAP[engine.id] = engine;

    const DEFAULT_TOKENIZER_DEFAULT = Object.freeze({ engine: "builtin:fallback" });
    const DEFAULT_CONTEXT_DEFAULT = Object.freeze({ value: DEFAULT_CONTEXT_WINDOW });

    const DEFAULT_TOKENIZER_RULES = Object.freeze([
        rule("tok-gpt", "gpt-", "builtin:openai-auto"),
        rule("tok-o1", "o1", "builtin:openai-auto"),
        rule("tok-o3", "o3", "builtin:openai-auto"),
        rule("tok-o4", "o4", "builtin:openai-auto"),
        rule("tok-claude", "claude-", "builtin:anthropic"),
        rule("tok-gemini", "gemini-", "builtin:fallback"),
        rule("tok-deepseek-flash", "deepseek-flash", "builtin:deepseek-v41"),
        rule("tok-deepseek-v41", "deepseek-v4.1", "builtin:deepseek-v41"),
        rule("tok-deepseek-v4", "deepseek-v4", "builtin:deepseek-v4"),
        rule("tok-qwen", "qwen", "builtin:qwen"),
        rule("tok-glm", "glm-", "builtin:glm"),
        rule("tok-llama", "llama-", "builtin:llama"),
        rule("tok-mistral", "mistral", "builtin:mistral"),
        rule("tok-yi", "yi-", "builtin:yi"),
        rule("tok-internlm", "internlm", "builtin:internlm"),
        rule("tok-gemma", "gemma-", "builtin:gemma"),
        // These vendors publish no reusable tokenizer.json. The rows stay so a
        // family can be pointed at an uploaded vocabulary in one click.
        rule("tok-grok", "grok-", "builtin:fallback"),
        rule("tok-kimi", "kimi", "builtin:fallback"),
        rule("tok-moonshot", "moonshot-", "builtin:fallback"),
        rule("tok-doubao", "doubao", "builtin:fallback"),
        rule("tok-hy4", "hy4", "builtin:fallback"),
        rule("tok-hunyuan", "hunyuan-", "builtin:fallback"),
        rule("tok-step", "step-", "builtin:fallback")
    ]);

    const DEFAULT_CONTEXT_RULES = Object.freeze([
        ctxRule("ctx-claude-fable", "claude-fable", 1000000),
        ctxRule("ctx-claude-mythos", "claude-mythos", 1000000),
        ctxRule("ctx-claude-opus-5", "claude-opus-5", 1000000),
        ctxRule("ctx-claude-sonnet-5", "claude-sonnet-5", 1000000),
        ctxRule("ctx-claude-haiku-5", "claude-haiku-5", 1000000),
        ctxRule("ctx-claude-opus-46", "claude-opus-4-6", 1000000),
        ctxRule("ctx-claude-opus-47", "claude-opus-4-7", 1000000),
        ctxRule("ctx-claude-opus-48", "claude-opus-4-8", 1000000),
        ctxRule("ctx-claude-sonnet-46", "claude-sonnet-4-6", 1000000),
        ctxRule("ctx-claude-haiku-45", "claude-haiku-4-5", 200000),
        ctxRule("ctx-claude", "claude-", 200000),
        ctxRule("ctx-gpt-6", "gpt-6", 400000),
        ctxRule("ctx-gpt-5", "gpt-5", 400000),
        ctxRule("ctx-gpt-41", "gpt-4.1", 400000),
        ctxRule("ctx-o3", "o3", 400000),
        ctxRule("ctx-o4", "o4", 400000),
        ctxRule("ctx-gpt", "gpt-", 128000),
        ctxRule("ctx-gemini", "gemini-", 1000000),
        ctxRule("ctx-deepseek-v4-pro", "deepseek-v4-pro", 1000000),
        ctxRule("ctx-deepseek-v4-flash", "deepseek-v4-flash", 1000000),
        ctxRule("ctx-deepseek-v41-flash", "deepseek-v4.1-flash", 1000000),
        ctxRule("ctx-deepseek-flash", "deepseek-flash", 1000000),
        ctxRule("ctx-deepseek-pro", "deepseek-pro", 1000000),
        ctxRule("ctx-deepseek", "deepseek-", 256000),
        ctxRule("ctx-kimi-k3", "kimi-k3", 1000000),
        ctxRule("ctx-kimi", "kimi", 256000),
        ctxRule("ctx-moonshot-128k", "moonshot-v1-128k", 128000),
        ctxRule("ctx-moonshot", "moonshot-", 128000),
        ctxRule("ctx-glm-5", "glm-5", 256000),
        ctxRule("ctx-glm", "glm-", 200000),
        ctxRule("ctx-qwen-long", "qwen-long", 10000000),
        ctxRule("ctx-qwen4", "qwen4", 1000000),
        ctxRule("ctx-qwen", "qwen", 256000),
        ctxRule("ctx-grok-41-fast", "grok-4.1-fast", 2000000),
        ctxRule("ctx-grok-47", "grok-4.7", 500000),
        ctxRule("ctx-grok", "grok-", 256000),
        ctxRule("ctx-doubao", "doubao", 256000),
        ctxRule("ctx-hy4", "hy4", 1000000),
        ctxRule("ctx-hunyuan", "hunyuan-", 256000),
        ctxRule("ctx-step-3", "step-3", 64000),
        ctxRule("ctx-step", "step-", 32000)
    ]);

    function rule(id, pattern, engine, enabled) {
        return Object.freeze({ id, pattern, regex: false, engine, enabled: enabled !== false, builtin: true });
    }

    function ctxRule(id, pattern, value, enabled) {
        return Object.freeze({ id, pattern, regex: false, value, enabled: enabled !== false, builtin: true });
    }

    function normalizePattern(value, regex) {
        const text = String(value == null ? "" : value).trim();
        // A trailing star is the UI's shorthand for "starts with"; regex rules
        // keep their source untouched.
        return regex ? text : text.replace(/\*+$/, "").trim();
    }

    function modelCandidates(model) {
        const name = String(model || "").trim().toLowerCase();
        if (!name) return [];
        const base = name.split("/").pop();
        return base && base !== name ? [base, name] : [name];
    }

    const regexCache = new Map();
    function compileRegex(source) {
        const key = String(source || "");
        if (regexCache.has(key)) return regexCache.get(key);
        let compiled = null;
        try { compiled = new RegExp(key, "i"); } catch (_) { compiled = null; }
        if (regexCache.size > 200) regexCache.clear();
        regexCache.set(key, compiled);
        return compiled;
    }

    function ruleMatches(rule, model) {
        const regex = Boolean(rule && rule.regex === true);
        const pattern = normalizePattern(rule && rule.pattern, regex);
        if (!pattern) return false;
        const names = modelCandidates(model);
        if (!names.length) return false;
        if (regex) {
            const compiled = compileRegex(pattern);
            if (!compiled) return false;
            return names.some(name => { compiled.lastIndex = 0; return compiled.test(name); });
        }
        const needle = pattern.toLowerCase();
        return names.some(name => name.startsWith(needle));
    }

    function resolveRule(rules, model) {
        for (const rule of Array.isArray(rules) ? rules : []) {
            if (!rule || rule.enabled === false) continue;
            if (ruleMatches(rule, model)) return rule;
        }
        return null;
    }

    function resolveContextWindow(rules, model, fallback = DEFAULT_CONTEXT_WINDOW) {
        const match = resolveRule(rules, model);
        const value = Number(match && match.value);
        return Number.isFinite(value) && value >= 1 ? Math.round(value) : fallback;
    }

    // 512K / 512k / 1M / 1m / 64万 / 8千 / 256000 / 1,000,000 tokens all work.
    function parseTokenValue(input) {
        if (typeof input === "number") return Number.isFinite(input) && input > 0 ? Math.round(input) : null;
        const text = String(input == null ? "" : input).trim().replace(/[,，_\s]/g, "");
        if (!text) return null;
        const match = text.match(/^(\d+(?:\.\d+)?)(k|m|w|千|万|tokens?)?$/i);
        if (!match) return null;
        const base = Number(match[1]);
        if (!Number.isFinite(base) || base <= 0) return null;
        const unit = String(match[2] || "").toLowerCase();
        const multiplier = unit === "k" || unit === "千" ? 1000
            : unit === "m" ? 1000000
                : unit === "w" || unit === "万" ? 10000
                    : 1;
        const value = Math.round(base * multiplier);
        if (value < 1 || value > MAX_CONTEXT_WINDOW) return null;
        return value;
    }

    function formatTokenValue(value) {
        const count = Math.round(Number(value) || 0);
        if (count <= 0) return "0";
        if (count >= 1000000) {
            const millions = count / 1000000;
            return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
        }
        if (count >= 1000) {
            const thousands = count / 1000;
            return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
        }
        return String(count);
    }

    function engineLabel(engine) {
        const id = String(engine || "");
        if (id.startsWith("file:")) return `自定义词表：${id.slice(5)}`;
        return ENGINE_MAP[id]?.label || "未配置词表";
    }

    function isGenericEngine(engine) {
        const id = String(engine || "");
        if (id.startsWith("file:")) return false;
        return id === "builtin:fallback";
    }

    function safeRuleId(value, fallback) {
        // Ids end up in inline event handlers, so never keep quotes or spaces.
        return String(value || fallback).replace(/[^\w.:-]+/g, "_").slice(0, 80) || fallback;
    }

    function normalizeEngine(engine) {
        const id = String(engine || "");
        if (id.startsWith("file:")) return id;
        return ENGINE_IDS.includes(id) ? id : "builtin:fallback";
    }

    function normalizeTokenizerRule(item, index) {
        if (!item || typeof item !== "object") return null;
        const regex = item.regex === true;
        const pattern = normalizePattern(item.pattern, regex);
        return {
            id: safeRuleId(item.id, `tok-${index}-${pattern || "empty"}`),
            pattern,
            regex,
            engine: normalizeEngine(item.engine),
            enabled: item.enabled !== false,
            builtin: item.builtin === true
        };
    }

    function normalizeContextRule(item, index) {
        if (!item || typeof item !== "object") return null;
        const regex = item.regex === true;
        const pattern = normalizePattern(item.pattern, regex);
        const parsed = typeof item.value === "number" ? Math.round(item.value) : parseTokenValue(item.value);
        return {
            id: safeRuleId(item.id, `ctx-${index}-${pattern || "empty"}`),
            pattern,
            regex,
            value: Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_WINDOW,
            enabled: item.enabled !== false,
            builtin: item.builtin === true
        };
    }

    function normalizeConfig(config) {
        const source = config && typeof config === "object" ? config : {};
        const tokenSource = Array.isArray(source.tokenizerRules) ? source.tokenizerRules : DEFAULT_TOKENIZER_RULES;
        const contextSource = Array.isArray(source.contextRules) ? source.contextRules : DEFAULT_CONTEXT_RULES;
        const contextDefault = parseTokenValue(source.contextDefault && source.contextDefault.value);
        return {
            version: 3,
            tokenizerRules: tokenSource.map(normalizeTokenizerRule).filter(Boolean),
            contextRules: contextSource.map(normalizeContextRule).filter(Boolean),
            tokenizerDefault: { engine: normalizeEngine(source.tokenizerDefault && source.tokenizerDefault.engine) },
            contextDefault: { value: contextDefault || DEFAULT_CONTEXT_DEFAULT.value }
        };
    }

    function cloneRules(rules) {
        return (Array.isArray(rules) ? rules : []).map(item => ({ ...item }));
    }

    function regexError(rule) {
        if (!rule || rule.regex !== true) return null;
        const source = normalizePattern(rule.pattern, true);
        if (!source) return "正则表达式为空";
        return compileRegex(source) ? null : "正则表达式无效";
    }

    // A rule is shadowed when an earlier enabled rule already captures every
    // model name it could match. Prefix rules are decidable; regular
    // expressions are probed with the other rule's pattern as a sample, so
    // those findings are reported as "可能" instead of certain.
    function detectConflicts(rules) {
        const list = Array.isArray(rules) ? rules : [];
        const conflicts = [];
        const active = list.map((rule, index) => ({ rule, index })).filter(entry => entry.rule && entry.rule.enabled !== false);
        const seen = new Map();
        for (const { rule, index } of active) {
            const pattern = normalizePattern(rule.pattern, rule.regex === true);
            if (!pattern) {
                conflicts.push({ ruleId: rule.id, index, message: "模型名匹配为空，会连未配置的模型一起匹配" });
                continue;
            }
            const key = `${rule.regex === true ? "re:" : "prefix:"}${pattern.toLowerCase()}`;
            if (seen.has(key)) {
                conflicts.push({ ruleId: rule.id, index, message: `与第 ${seen.get(key) + 1} 条规则完全相同，永远不会命中` });
                continue;
            }
            seen.set(key, index);
        }
        for (const { rule, index } of active) {
            const pattern = normalizePattern(rule.pattern, rule.regex === true);
            if (!pattern) continue;
            const isRegex = rule.regex === true;
            for (const previous of active) {
                if (previous.index >= index) break;
                const earlier = previous.rule;
                const earlierRegex = earlier.regex === true;
                const earlierPattern = normalizePattern(earlier.pattern, earlierRegex);
                if (!earlierPattern) {
                    conflicts.push({ ruleId: rule.id, index, message: `被第 ${previous.index + 1} 条「匹配全部」规则永久遮蔽` });
                    break;
                }
                // Identical source and mode was already reported as a duplicate.
                if (!isRegex && !earlierRegex && pattern.toLowerCase() === earlierPattern.toLowerCase()) break;
                if (isRegex && earlierRegex && pattern === earlierPattern) break;
                if (!isRegex && !earlierRegex && pattern.toLowerCase().startsWith(earlierPattern.toLowerCase())) {
                    conflicts.push({ ruleId: rule.id, index, message: `被第 ${previous.index + 1} 条规则「${earlierPattern}」覆盖，永远不会命中` });
                    break;
                }
                // Use the literal part of a regex as a probe string for overlap.
                const sample = (isRegex ? pattern.replace(/[\\^$.*+?()[\]{}|]/g, "") : pattern).slice(0, 60);
                if (earlierRegex) {
                    const compiled = compileRegex(earlierPattern);
                    if (compiled && sample) {
                        compiled.lastIndex = 0;
                        const hit = compiled.test(sample) || modelCandidates(sample).some(name => { compiled.lastIndex = 0; return compiled.test(name); });
                        if (hit) {
                            conflicts.push({ ruleId: rule.id, index, message: `可能被第 ${previous.index + 1} 条正则规则「${earlierPattern}」抢先匹配` });
                            break;
                        }
                    }
                } else if (isRegex && sample.toLowerCase().startsWith(earlierPattern.toLowerCase())) {
                    conflicts.push({ ruleId: rule.id, index, message: `可能与第 ${previous.index + 1} 条规则「${earlierPattern}」重叠` });
                    break;
                }
            }
        }
        return conflicts;
    }

    function validateConfig(config) {
        const normalized = normalizeConfig(config);
        const errors = [];
        const check = (rule, index, group) => {
            const pattern = normalizePattern(rule.pattern, rule.regex === true);
            if (!pattern) errors.push({ ruleId: rule.id, group, message: `第 ${index + 1} 条规则缺少模型名` });
            const problem = regexError(rule);
            if (problem) errors.push({ ruleId: rule.id, group, message: `第 ${index + 1} 条规则${problem}` });
        };
        normalized.tokenizerRules.forEach((rule, index) => check(rule, index, "tokenizer"));
        normalized.contextRules.forEach((rule, index) => check(rule, index, "context"));
        const tokenizerConflicts = detectConflicts(normalized.tokenizerRules);
        const contextConflicts = detectConflicts(normalized.contextRules);
        return {
            config: normalized,
            errors,
            tokenizerConflicts,
            contextConflicts,
            conflicts: [...tokenizerConflicts, ...contextConflicts],
            ok: errors.length === 0
        };
    }

    return {
        DEFAULT_CONTEXT_WINDOW,
        ENGINES,
        ENGINE_IDS,
        DEFAULT_TOKENIZER_RULES,
        DEFAULT_CONTEXT_RULES,
        DEFAULT_TOKENIZER_DEFAULT,
        DEFAULT_CONTEXT_DEFAULT,
        normalizePattern,
        ruleMatches,
        resolveRule,
        resolveContextWindow,
        parseTokenValue,
        formatTokenValue,
        engineLabel,
        isGenericEngine,
        regexError,
        normalizeTokenizerRule,
        normalizeContextRule,
        normalizeConfig,
        cloneRules,
        detectConflicts,
        validateConfig
    };
});
