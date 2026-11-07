const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const estimator = require('../context-estimator');

function service(base,respond) {
    const calls = [];
    const context = {
        URL,AbortSignal,console,
        AIUIContextEstimator:estimator,
        getBaseURL:() => base,
        getAPIKey:() => 'test-key',
        buildMessagesPayloadFromBase:({messages}) => ({messages:messages.filter(m=>m.role!=='system'),system:messages.filter(m=>m.role==='system').map(m=>m.content).join('\n')}),
        fetch:async (url,options) => { const call={url,body:JSON.parse(options.body),headers:options.headers}; calls.push(call); return respond(call); },
        window:{electronAPI:{ countContextBatch:async texts=>({counts:texts.map(()=>5),label:'通用 o200k_base 参考估算',generic:true}) }}
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../context-token-service.js'),'utf8'),context);
    return {calls,count:(model,text='test')=>context.window.estimateContextAccurately([{role:'system',content:'system'},{role:'user',content:text}],{model,contextWindow:10000})};
}

test('Claude Sonnet, Opus and Fable snapshots and relay aliases use count_tokens and reuse counts',async()=>{
    const client=service('https://relay.example/proxy/v1/messages',()=>({ok:true,json:async()=>({input_tokens:123})}));
    for (const model of ['claude-sonnet-4-6','claude-sonnet-5-5','claude-opus-4-8','claude-opus-5-5','claude-fable-5-1','anthropic/claude-3-7-sonnet-20250219','claude_fable_5']) {
        const result=await client.count(model);
        assert.equal(result.usedTokens,123); assert.equal(result.generic,false);
        const call=client.calls.at(-1);
        assert.equal(call.url,'https://relay.example/proxy/v1/messages/count_tokens');
        assert.equal(call.body.model,model); assert.equal(call.headers.Authorization,'Bearer test-key');
        const before=client.calls.length; await client.count(model); assert.equal(client.calls.length,before);
    }
});

test('Claude supports alternate relay count endpoints and keeps generic fallback on API failure',async()=>{
    const client=service('https://relay.example/v1',call=>({ok:!call.url.includes('/v1/'),json:async()=>({input_tokens:99})}));
    assert.equal((await client.count('claude-fable-5')).usedTokens,99);
    assert.equal(client.calls[1].url,'https://relay.example/messages/count_tokens');
    const failure=service('https://relay.example/v1',()=>({ok:false}));
    assert.equal((await failure.count('claude-opus-5')).generic,true);
    await failure.count('claude-opus-5','changed text'); assert.equal(failure.calls.length,2);
});

test('official Anthropic uses bare model IDs, rejects invalid counts and does not report local precision',async()=>{
    const client=service('https://api.anthropic.com/v1/messages',()=>({ok:true,json:async()=>({input_tokens:-1})}));
    assert.equal((await client.count('anthropic/claude-sonnet-5')).generic,true);
    assert.equal(client.calls[0].body.model,'claude-sonnet-5');
    assert.equal(client.calls[0].headers.Authorization,undefined);
});
