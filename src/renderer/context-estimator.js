(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.AIUIContextEstimator = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    const CATEGORY_LABELS = {
        systemTools: "系统工具",
        systemPrompt: "系统提示",
        messages: "消息",
        toolResults: "工具结果",
        attachments: "附件",
        images: "图片",
        reasoningItems: "Reasoning 项"
    };

    function asText(value) {
        if (typeof value === "string") return value;
        if (typeof value === "number" || typeof value === "boolean") return String(value);
        return "";
    }

    function reasoningText(value) {
        if (typeof value === "string") return value;
        if (Array.isArray(value)) return value.map(reasoningText).filter(Boolean).join("\n");
        if (!value || typeof value !== "object") return "";
        // encrypted_content is serialized model state, not a tokenizable transcript.
        if (typeof value.text === "string") return value.text;
        return [reasoningText(value.summary), reasoningText(value.content)].filter(Boolean).join("\n");
    }

    function opaqueReasoningCount(content) {
        const parts = Array.isArray(content) ? content : [content];
        return parts.reduce((count, part) => count + (part?.type === "reasoning"
            && typeof part.encrypted_content === "string" && part.encrypted_content ? 1 : 0), 0);
    }

    async function countText(text, tokenizer, model) {
        const value = String(text || "");
        if (!value) return 0;
        if (tokenizer && typeof tokenizer.count === "function") {
            const count = Number(await tokenizer.count(value, model));
            if (Number.isFinite(count) && count >= 0) return Math.ceil(count);
        }
        const chinese = (value.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
        const remaining = value.length - chinese;
        return Math.ceil(chinese * 1.6 + remaining * 0.35);
    }

    function splitAttachments(text) {
        const chunks = [];
        const pattern = /\n?\n\[文件: ([^\]]+)\]\n[\s\S]*?\n\[\/文件: \1\]/g;
        let cursor = 0;
        let match;
        while ((match = pattern.exec(text))) {
            if (match.index > cursor) chunks.push({ type: "message", text: text.slice(cursor, match.index) });
            chunks.push({ type: "attachment", text: match[0] });
            cursor = match.index + match[0].length;
        }
        if (cursor < text.length) chunks.push({ type: "message", text: text.slice(cursor) });
        if (!chunks.length && text) chunks.push({ type: "message", text });
        return chunks;
    }

    function splitAgentPrompt(text) {
        const source = String(text || "");
        const toolEnd = source.indexOf("\n\nCore Agent Rules\n\n");
        if (toolEnd < 0) return { systemTools: "", systemPrompt: source };
        const rulesStart = toolEnd + 2;
        const customPromptIndex = source.indexOf("\n\nUser System Prompt\n\n", rulesStart);
        const environmentIndex = source.indexOf("\n\nCurrent Environment\n\n", rulesStart);
        const tailIndex = [customPromptIndex, environmentIndex].filter(index => index >= 0).sort((a, b) => a - b)[0];
        const rulesEnd = tailIndex === undefined ? source.length : tailIndex;
        const systemPrompt = tailIndex === undefined ? "" : source.slice(tailIndex);
        return {
            systemTools: `${source.slice(0, toolEnd)}\n\n${source.slice(rulesStart, rulesEnd)}`.trim(),
            systemPrompt: systemPrompt.trim()
        };
    }

    async function countMessageContent(content, tokenizer, model, categories, defaultCategory) {
        const parts = Array.isArray(content) ? content : [content];
        let hasContent = false;
        for (const part of parts) {
            if (part && typeof part === "object") {
                if (["input_image", "image_url"].includes(part.type)) {
                    categories.images += 768;
                    hasContent = true;
                    continue;
                }
                if (part.type === "reasoning") {
                    const text = reasoningText(part);
                    categories.reasoningItems += await countText(text, tokenizer, model);
                    hasContent = true;
                    continue;
                }
                if (["text", "input_text", "output_text"].includes(part.type)) {
                    const text = asText(part.text);
                    if (!text) continue;
                    hasContent = true;
                    await addText(text, defaultCategory, tokenizer, model, categories);
                    continue;
                }
                continue;
            }
            const text = asText(part);
            if (!text) continue;
            hasContent = true;
            await addText(text, defaultCategory, tokenizer, model, categories);
        }
        return hasContent;
    }

    async function addText(text, category, tokenizer, model, categories) {
        for (const chunk of splitAttachments(text)) {
            if (chunk.type === "attachment") categories.attachments += await countText(chunk.text, tokenizer, model);
            else categories[category] += await countText(chunk.text, tokenizer, model);
        }
    }

    async function estimate(messages, options = {}) {
        const tokenizer = options.tokenizer || null;
        const model = String(options.model || "");
        const contextWindow = Math.max(1, Number(options.contextWindow) || 128000);
        const isAgent = options.agent === true;
        const categories = {
            systemTools: 0,
            systemPrompt: 0,
            messages: 0,
            toolResults: 0,
            attachments: 0,
            images: 0,
            reasoningItems: 0
        };
        let messageOverhead = 0;
        let opaqueReasoningItems = 0;

        for (const message of Array.isArray(messages) ? messages : []) {
            if (!message || typeof message !== "object") continue;
            if (message.type === "reasoning") {
                categories.reasoningItems += await countText(reasoningText(message), tokenizer, model);
                opaqueReasoningItems += opaqueReasoningCount(message);
                continue;
            }
            opaqueReasoningItems += opaqueReasoningCount(message.content);
            if (message.role === "system") {
                const systemText = typeof message.content === "string"
                    ? message.content
                    : Array.isArray(message.content)
                        ? message.content.map(part => asText(part?.text)).join("\n")
                        : "";
                if (isAgent && /以下是历史对话的独立摘要/.test(systemText)) {
                    categories.messages += await countText(systemText, tokenizer, model);
                } else if (isAgent) {
                    const split = splitAgentPrompt(systemText);
                    categories.systemTools += await countText(split.systemTools, tokenizer, model);
                    categories.systemPrompt += await countText(split.systemPrompt, tokenizer, model);
                } else {
                    categories.systemPrompt += await countText(systemText, tokenizer, model);
                }
                messageOverhead += 4;
                continue;
            }
            const contentText = typeof message.content === "string"
                ? message.content
                : Array.isArray(message.content)
                    ? message.content.map(part => asText(part?.text)).join(" ")
                    : "";
            const isToolResult = message.role === "tool" || /^\s*\[Tool Result:/i.test(contentText);
            const category = isToolResult ? "toolResults" : "messages";
            await countMessageContent(message.content, tokenizer, model, categories, category);
            messageOverhead += 4;
        }

        const usedTokens = Object.values(categories).reduce((sum, count) => sum + count, 0) + messageOverhead;
        const reserveTokens = isAgent ? Math.round(contextWindow * 0.08) : 0;
        const freeTokens = Math.max(0, contextWindow - usedTokens - reserveTokens);
        const categoryEntries = Object.entries(categories)
            .filter(([, tokens]) => tokens > 0)
            .map(([key, tokens]) => ({ key, label: CATEGORY_LABELS[key], tokens }));
        if (messageOverhead) categoryEntries.push({ key: "messageOverhead", label: "消息格式开销", tokens: messageOverhead });
        if (reserveTokens) categoryEntries.push({ key: "compactionBuffer", label: "自动压缩预留", tokens: reserveTokens });
        categoryEntries.push({ key: "freeSpace", label: "可用空间", tokens: freeTokens });

        return {
            model,
            contextWindow,
            usedTokens,
            reserveTokens,
            freeTokens,
            usedPercent: Math.min(100, Math.round(usedTokens / contextWindow * 100)),
            overWindow: usedTokens + reserveTokens > contextWindow,
            categories,
            opaqueReasoningItems,
            hasOpaqueReasoningItems: opaqueReasoningItems > 0,
            categoryEntries,
            tokenizerLabel: tokenizer && typeof tokenizer.describe === "function"
                ? tokenizer.describe(model)
                : "本地字符估算"
        };
    }

    return { countText, splitAgentPrompt, estimate };
});
