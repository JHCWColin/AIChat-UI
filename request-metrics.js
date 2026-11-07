(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AIUIRequestMetrics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    function create() { return { input:0, cached:0, output:0, reasoning:0, reasoningText:'', first:0, last:0, text:'', hasUsage:false, hasOutputUsage:false,hasReasoningUsage:false }; }
    function ingest(state, payload, update = {}, now = performance.now()) {
        const response = payload?.response || payload;
        const usage = response?.usage || payload?.message?.usage || payload?.usageMetadata;
        if (usage) {
            const input = usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount;
            const cached = usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cachedContentTokenCount;
            if (Number.isFinite(input)) {
                // Anthropic's input_tokens excludes both cache reads and writes.
                state.input = input + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
                state.hasUsage = true;
            }
            if (Number.isFinite(cached)) state.cached = cached;
            const output = usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount;
            if (Number.isFinite(output)) { state.output = output; state.hasOutputUsage = true; }
            const reasoning = usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens;
            if (Number.isFinite(reasoning)) { state.reasoning = reasoning; state.hasReasoningUsage = true; }
            // Gemini candidate counts already exclude thoughtsTokenCount.
            if (Number.isFinite(usage.candidatesTokenCount)) { state.reasoning = 0; state.hasReasoningUsage = true; }
        }
        state.reasoningText = update.reasoningSnapshot || state.reasoningText + (update.reasoningDelta || '');
        if (update.contentDelta || (update.contentSnapshot && update.contentSnapshot !== state.text)) {
            if (!state.first) state.first = now;
            state.last = now;
            state.text = update.contentSnapshot || state.text + (update.contentDelta || '');
        }
        return state;
    }
    function finish(state, fallbackOutput = 0) {
        const duration = state.first && state.last > state.first ? state.last - state.first : 0;
        return { input:state.input, cached:Math.min(state.input,state.cached),
            output:state.hasOutputUsage && (!state.reasoningText || state.hasReasoningUsage)
                ? Math.max(0,state.output-state.reasoning) : fallbackOutput || state.localOutput || 0,
            streamMs:duration, hasUsage:state.hasUsage };
    }
    return { create, ingest, finish };
});
