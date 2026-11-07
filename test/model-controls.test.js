const test = require('node:test');
const assert = require('node:assert/strict');
const capabilities = require('../model-capabilities');
const metrics = require('../request-metrics');
const normalizer = require('../tool-call-normalizer');

test('model contracts distinguish adaptive thinking, effort, switches and token budgets', () => {
    const sol = capabilities.get('gpt-6.1-sol');
    assert.deepEqual(sol.values,['low','medium','high','xhigh','max']);
    assert.equal(sol.default,'medium');
    assert.equal(capabilities.get('gemini-2.5-pro').values.includes('off'),false);
    assert.equal(capabilities.get('claude-opus-4-6').values.includes('xhigh'),false);
    assert.equal(capabilities.get('claude-opus-4-8').values.includes('xhigh'),true);
    assert.equal(capabilities.compatible(sol,capabilities.get('gpt-6.1-terra'),'max'),true);
    assert.equal(capabilities.compatible(sol,capabilities.get('deepseek-flash'),'high'),false);
});

test('protocol mapping never sends one vendors parameter to another vendor or endpoint', () => {
    const stale = { temperature:.7,reasoning_effort:'invalid',thinking:{ type:'enabled',budget_tokens:999 },reasoning:{ effort:'invalid' },output_config:{ effort:'max' } };
    assert.deepEqual(capabilities.map(stale,'unknown','/responses','high'),{ temperature:.7 });
    assert.deepEqual(capabilities.map(stale,'gpt-6.1-sol','/responses','none'),{ reasoning:{ effort:'medium' } });
    assert.deepEqual(capabilities.map(stale,'gpt-6.1-sol','/chat/completions','high'),{ reasoning_effort:'high' });
    assert.deepEqual(capabilities.map(stale,'claude-opus-4-8','/v1/messages','xhigh'),{ thinking:{ type:'adaptive' },output_config:{ effort:'xhigh' } });
    assert.deepEqual(capabilities.map(stale,'claude-opus-4-8','/responses','xhigh'),{ temperature:.7 });
    assert.deepEqual(capabilities.map(stale,'deepseek-flash','/chat/completions','off'),{ temperature:.7,thinking:{ type:'disabled' } });
    assert.deepEqual(capabilities.map(stale,'deepseek-flash','/chat/completions','max'),{ thinking:{ type:'enabled' },reasoning_effort:'max' });
    const budget = capabilities.map({ max_tokens:1024 },'claude-sonnet-4-5','/v1/messages','4096');
    assert.equal(budget.thinking.budget_tokens,4096); assert.ok(budget.max_tokens>4096); assert.equal(budget.output_config,undefined);
    const gemini = capabilities.map(stale,'gemini-2.5-pro','/chat/completions','auto');
    assert.deepEqual(gemini.extra_body,{ google:{ thinking_config:{ thinking_budget:-1 } } });
    for (const config of Object.values(capabilities.registry)) {
        assert.ok(config.values.includes(config.default),config.model);
        assert.equal(capabilities.get(config.model).model,config.model);
    }
});

test('metrics exclude hidden reasoning and request wait/tool duration, and merge terminal usage', () => {
    const state = metrics.create();
    metrics.ingest(state,{ usage:{ prompt_tokens:100,prompt_tokens_details:{ cached_tokens:60 } } },{},10);
    metrics.ingest(state,{}, { contentDelta:'hello ' },1000);
    metrics.ingest(state,{}, { contentDelta:'world' },2000);
    metrics.ingest(state,{ usage:{ completion_tokens:80,completion_tokens_details:{ reasoning_tokens:50 } } },{ contentSnapshot:'hello world' },9000);
    assert.deepEqual(metrics.finish(state),{ input:100,cached:60,output:30,streamMs:1000,hasUsage:true });
    const claude = metrics.create();
    metrics.ingest(claude,{ message:{ usage:{ input_tokens:20,cache_read_input_tokens:50,cache_creation_input_tokens:30 } } });
    metrics.ingest(claude,{ usage:{ output_tokens:10 } });
    assert.equal(metrics.finish(claude).input,100); assert.equal(metrics.finish(claude).cached,50);
});

test('enhanced tool parsing is opt-in, handles quoted Windows paths and never evaluates code', () => {
    const source = String.raw`<|tool_call_start|>[list_dir(dir_path='D:\\msys64\\home', offset=0, limit=50, depth=2)]<|tool_call_end|>`;
    assert.equal(normalizer.parseAgentResponse(source).calls.length,0);
    const parsed = normalizer.parseAgentResponse(source,[],{ enhanced:true });
    assert.equal(parsed.calls.length,1); assert.equal(parsed.calls[0].name,'list_dir');
    assert.deepEqual(parsed.calls[0].arguments,{ dir_path:'D:\\msys64\\home',offset:0,limit:50,depth:2 });
    const injection = '<|tool_call_start|>[run_shell(command=process.exit())]<|tool_call_end|>';
    assert.equal(normalizer.parseAgentResponse(injection,[],{ enhanced:true }).calls.length,0);
    const dot = '<dots_function_call><list_dir">{"dir_path":"."}</invoke></dots_function_call>';
    assert.equal(normalizer.parseAgentResponse(dot,[],{ enhanced:true }).calls[0].name,'list_dir');
});

test('closing tool tags alone never become assistant prose next to native calls', () => {
    const result = normalizer.parseAgentResponse('</tool_call>\n</tool_call>',[{ name:'list_dir',arguments:{} }]);
    assert.equal(result.text,''); assert.equal(result.segments.filter(item => item.type==='text').length,0);
    assert.equal(normalizer.parseAgentResponse('实际答复 </tool_call>',[]).text,'实际答复');
});
