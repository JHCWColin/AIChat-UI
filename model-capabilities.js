(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AIUIModelCapabilities = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    const registry = Object.create(null);
    function add(names, provider, mechanism, values, defaultValue, extra = {}) {
        for (const name of names.split(' ')) registry[name] = Object.freeze({ model:name, provider, mechanism, values:values.split(' '), default:defaultValue, ...extra });
    }
    add('gpt-6.1-sol','openai','effort','low medium high xhigh max','medium');
    add('gpt-6.1-terra gpt-6-luna gpt-5.6-sol gpt-5.6-terra gpt-5.6-luna','openai','effort','none low medium high xhigh max','medium');
    add('gpt-6-astra','openai','effort','default low medium high xhigh max','default');
    add('gpt-5.5','openai','effort','none low medium high xhigh','medium');
    add('gpt-5.4 gpt-5.2','openai','effort','none low medium high xhigh','none');
    add('gpt-5.1','openai','effort','none low medium high','none');
    add('gpt-5','openai','effort','minimal low medium high','medium');
    add('o1 o3 o3-mini o4-mini','openai','effort','low medium high','medium');
    add('claude-opus-4-6 claude-sonnet-4-6 claude-mythos-preview','anthropic','adaptive-effort','low medium high max','high');
    add('claude-opus-4-7 claude-opus-4-8 claude-opus-5 claude-sonnet-5 claude-sonnet-5-5 claude-fable-5 claude-fable-5-1 claude-mythos-5 claude-mythos-5-1','anthropic','adaptive-effort','low medium high xhigh max','high');
    add('claude-opus-5-5 claude-haiku-5-5','anthropic','adaptive-effort','low medium high xhigh max','medium');
    add('claude-opus-4-5','anthropic','manual-effort','low medium high','high');
    add('claude-sonnet-4-5 claude-haiku-4-5 claude-opus-4-1 claude-sonnet-4 claude-opus-4 claude-3-7-sonnet','anthropic','budget','off 1024 4096 8192 16384','off');
    add('deepseek-flash deepseek-v4-pro deepseek-v4.1-flash','deepseek','thinking-effort','off low high max','high');
    add('deepseek-chat','deepseek','thinking-toggle','off on','off');
    add('deepseek-reasoner','deepseek','fixed','default','default');
    add('grok-4.7 grok-4.6','xai','effort','low medium high xhigh','high');
    add('grok-4.5','xai','effort','low medium high','high');
    add('grok-3-mini grok-3-mini-fast','xai','effort','low high','low');
    add('gemini-4-argon gemini-3.8-flash gemini-3.7-flash','google','thinking-level','low medium high','medium');
    add('gemini-3.6-flash','google','thinking-level','minimal low medium high','medium');
    add('gemini-3.5-flash-lite','google','thinking-level','minimal low medium high','minimal');
    add('gemini-3.1-pro-preview','google','thinking-level','low medium high','high');
    add('gemini-3-flash-preview','google','thinking-level','minimal low medium high','high');
    add('gemini-3-pro-preview','google','thinking-level','low high','high');
    add('gemini-2.5-pro','google','thinking-budget','auto 128 1024 8192 16384 32768','auto');
    add('gemini-2.5-flash','google','thinking-budget','auto off 512 1024 8192 24576','auto');
    add('gemini-2.5-flash-lite','google','thinking-budget','off auto 512 1024 8192 24576','off');
    const labels = { none:'none',off:'off',on:'on',auto:'auto',default:'Automatic',minimal:'minimal',low:'low',medium:'medium',high:'high',xhigh:'xhigh',max:'max' };
    function get(model) {
        const name = String(model || '').split('/').pop().toLowerCase();
        if (registry[name]) return registry[name];
        // A date snapshot inherits only its exact parent model's documented contract.
        const parent = name.replace(/-\d{4}-\d{2}-\d{2}$|-\d{8}$|-\d{4}$/, '');
        if (registry[parent]) return { ...registry[parent], model:name };
        return { model:name, provider:'unknown', mechanism:'fixed', values:['default'], default:'default' };
    }
    function compatible(previous, next, value) {
        return previous.provider === next.provider && previous.mechanism === next.mechanism && next.values.includes(value);
    }
    function map(payload, model, endpoint, selected) {
        const capability = get(model);
        const value = capability.values.includes(String(selected)) ? String(selected) : capability.default;
        // Never carry controls from a previous model/protocol into this request.
        const { reasoning_effort, reasoning, thinking, output_config, thinking_budget, extra_body, ...clean } = payload;
        const result = { ...clean };
        const messages = endpoint === '/messages' || endpoint === '/v1/messages';
        const chat = endpoint === '/chat/completions';
        const responses = endpoint === '/responses';
        if (capability.provider === 'openai' && capability.mechanism === 'effort') {
            if (responses && value !== 'default') result.reasoning = { effort:value };
            if (chat && value !== 'default') result.reasoning_effort = value;
            if (value !== 'none') { delete result.temperature; delete result.top_p; delete result.top_logprobs; }
        } else if (capability.provider === 'xai' && capability.mechanism === 'effort') {
            if (chat) result.reasoning_effort = value;
            if (responses) result.reasoning = { effort:value };
        } else if (capability.provider === 'anthropic' && messages) {
            if (capability.mechanism === 'adaptive-effort') {
                result.thinking = { type:'adaptive' };
                result.output_config = { effort:value };
                delete result.temperature; delete result.top_p;
            } else if (capability.mechanism === 'manual-effort') {
                result.output_config = { effort:value }; // Effort is independent of manual thinking.
            } else if (capability.mechanism === 'budget' && value !== 'off') {
                const budget = Number(value);
                result.thinking = { type:'enabled', budget_tokens:budget };
                if (!result.max_tokens || result.max_tokens <= budget) result.max_tokens = budget + 4096;
                delete result.temperature; delete result.top_p;
            }
        } else if (capability.provider === 'deepseek') {
            if (capability.mechanism === 'thinking-effort') {
                if (chat || messages) result.thinking = { type:value === 'off' ? 'disabled':'enabled' };
                if (value !== 'off' && chat) result.reasoning_effort = value;
                if (value !== 'off' && messages) result.output_config = { effort:value };
                if (responses) result.reasoning = { effort:value === 'off' ? 'none':value };
                if (value !== 'off') delete result.temperature;
            } else if (capability.mechanism === 'thinking-toggle' && chat) result.thinking = { type:value === 'on' ? 'enabled':'disabled' };
        } else if (capability.provider === 'google' && chat) {
            // Google's OpenAI-compatible interface keeps native budget/level in
            // extra_body.google, never in Anthropic's thinking object.
            if (capability.mechanism === 'thinking-level') result.extra_body = { google:{ thinking_config:{ thinking_level:value } } };
            if (capability.mechanism === 'thinking-budget') result.extra_body = { google:{ thinking_config:{ thinking_budget:value === 'auto' ? -1:value === 'off' ? 0:Number(value) } } };
        }
        return result;
    }
    return { registry, get, compatible, map, label:value => labels[value] || `${Number(value).toLocaleString()} tokens` };
});
