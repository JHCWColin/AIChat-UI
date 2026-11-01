const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const AgentProtocol = require("../agent-protocol");
const ToolCallNormalizer = require("../tool-call-normalizer");

const projectRoot = path.resolve(__dirname, "..");
const agentSource = fs.readFileSync(path.join(projectRoot, "agent-ui.js"), "utf8");
const html = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
const adapterNames = ["extractResponsesTextContent", "extractResponsesOutputText", "extractResponsesReasoningText",
    "extractChatCompletionUpdate", "extractStreamingUpdate", "extractMessagesStreamUpdate", "extractMessagesOutputText",
    "extractMessagesReasoningText", "mergeStreamingText", "parseSSEEventBlock", "getStreamingErrorMessage", "extractNonStreamingResponseText",
    "buildRequestPayloadForEndpoint", "buildResponsesInputFromMessages", "buildMessagesPayloadFromBase",
    "buildMessagesContentBlocks", "toAnthropicImageBlock", "cacheControlEnabled"];
const adapterSource = adapterNames.map(name => {
    const match = html.match(new RegExp(`^        function ${name}\\b[\\s\\S]*?\\n        \\}`, "m"));
    if (!match) throw new Error(`Cannot extract shipped adapter ${name}`);
    return match[0];
}).join("\n");

function element() {
    const children = new Map();
    return { value: "", textContent: "", innerHTML: "", dataset: {}, style: { removeProperty() {} },
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        querySelector(selector) { if (!children.has(selector)) children.set(selector, element()); return children.get(selector); },
        querySelectorAll: () => [], setAttribute() {}, appendChild() {}, replaceChildren() {}, remove() {}, scrollTop: 0, scrollHeight: 0 };
}

const outputMessage = text => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const nativeCall = (name, args = {}) => ({ type: "function_call", id: `${name}-id`, call_id: `${name}-call`, name, arguments: JSON.stringify(args) });
const payloadResponse = payload => ({ ok: true, body: null, json: async () => payload });
const outputResponse = (text, calls = []) => payloadResponse({ status: "completed", output: [...(text ? [outputMessage(text)] : []), ...calls] });
const event = (type, data, id = "") => `${id ? `id: ${id}\n` : ""}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
function streamResponse(events) {
    let index = 0;
    const encoded = events.map(value => new TextEncoder().encode(value));
    return { ok: true, body: { getReader: () => ({ read: async () => index < encoded.length
        ? { done: false, value: encoded[index++] } : { done: true } }) } };
}

function fixture(responses) {
    const nodes = new Map();
    const requests = [];
    const executedTools = [];
    const chat = { id: "test-chat", title: "简单总结未来", agentEnabled: true,
        agentFixedPrompt: "严格按照工具定义来调用，你现在不身处于你的官方cli环境！", messages: [{ role: "user", content: "简单总结未来" }] };
    const context = {
        console, Date, Promise, AbortController, TextDecoder, CSS: { escape: String },
        setInterval: () => 1, clearInterval() {}, setTimeout: () => 1,
        document: { body: element(), createElement: element, querySelector: () => null,
            getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); } },
        localStorage: { getItem: () => null, setItem() {} }, chats: [chat], activeChatId: chat.id,
        queuedAgentMessages: [], isGenerating: false, contextCompactionRunning: false, isImageMode: false,
        currentTemp: 0.7, maxTokensLimit: 0, abortController: null, developerModeEnabled: false, logLevel: "info", lastPromptCacheDebug: null,
        AgentProtocol, ToolCallNormalizer, lucide: { createIcons() {} },
        renderThinkingText() {}, escapeHtml: String, showVoiceNotification() {}, hideVoiceNotification() {},
        updateSettingsLocks() {}, renderChatHistory() {}, updateAttachMenuButtons() {},
        renderMessagesWithResolvedRefs: async () => {}, appendMessageToUI: element,
        buildCompactedChatMessages: value => value.messages,
        buildSingleApiMessage: async message => ({ role: message.role, content: message.content }),
        getRequestEndpoint: () => "/responses", getBaseURL: () => "https://model.test/v1", logPromptCacheDebug() {}, appendLog() {},
        getAgentDetailDefaultBehavior: () => "expanded",
        fetchEndpointWithFallback: async body => {
            requests.push(JSON.parse(JSON.stringify(body)));
            if (requests.length > 8) throw new Error("Unexpected unbounded model loop");
            return { response: responses[Math.min(requests.length - 1, responses.length - 1)], endpoint: "/responses", requestBody: body };
        },
        electronAPI: { getAgentWorkspace: async () => ({ exists: true }),
            executeAgentTool: async request => { executedTools.push(request); return { success: true }; } }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(adapterSource, context, { filename: "shipped-index-adapters.js" });
    vm.runInContext(agentSource, context, { filename: "agent-ui.js" });
    return { context, chat, requests, executedTools,
        run: async () => {
            await context.requestAgentLoop("model", chat);
            assert.ok(!chat.messages.some(message => /^Agent 执行失败：.*(?:not defined|is not a function)/.test(message.content)),
                "test fixture must supply the actual renderer environment");
        },
        visible: () => chat.messages.filter(message => message.role === "assistant" && !message.hidden),
        successfulFinishes: () => chat.messages.filter(message => message.toolName === "finish_task" && message.result?.success === true) };
}

test("Responses events sharing an SSE id retain final item/completed text after reasoning", async () => {
    const final = "未来的发展将更重视技术进步、可持续发展与人机协作。";
    const f = fixture([streamResponse([
        event("response.reasoning_summary_text.delta", { delta: "用户要简单总结未来；先计划再回答。" }, "shared-id"),
        event("response.output_item.done", { item: outputMessage(final) }, "shared-id"),
        event("response.completed", { response: { status: "completed", output: [outputMessage(final), nativeCall("finish_task")] } }, "shared-id")
    ])]);
    await f.run();
    assert.equal(f.requests.length, 1);
    assert.equal(f.successfulFinishes().length, 1);
    assert.ok(f.visible().some(message => message.content === final && message.agentFinal));
    assert.ok(!f.visible().some(message => message.content.includes("先计划再回答")));
});

test("an identical Responses replay is ignored without dropping distinct output deltas", async () => {
    const first = event("response.output_text.delta", { delta: "第一段。", sequence_number: 1 }, "reused-id");
    const f = fixture([streamResponse([
        first, first,
        event("response.output_text.delta", { delta: "第二段。", sequence_number: 2 }, "reused-id"),
        event("response.completed", { response: { status: "completed", output: [outputMessage("第一段。第二段。"), nativeCall("finish_task")] } }, "reused-id")
    ])]);
    await f.run();
    assert.ok(f.visible().some(message => message.content === "第一段。第二段。"));
    assert.equal(f.requests.length, 1);
});

test("consecutive identical content deltas with a reused SSE id preserve repeated tokens", async () => {
    const token = event("response.output_text.delta", { delta: "哈" }, "shared-id-without-sequence");
    const f = fixture([streamResponse([token, token,
        event("response.completed", { response: { status: "completed", output: [nativeCall("finish_task")] } }, "shared-id-without-sequence")
    ])]);
    await f.run();
    assert.equal(f.requests.length, 1);
    assert.ok(f.visible().some(message => message.content === "哈哈"));
    assert.equal(f.successfulFinishes().length, 1);
});

test("consecutive identical reasoning deltas with a reused SSE id retain the complete thought", async () => {
    const token = event("response.reasoning_summary_text.delta", { delta: "认真考虑。" }, "shared-id-without-sequence");
    const f = fixture([streamResponse([token, token,
        event("response.output_text.delta", { delta: "这是实际回答。" }, "shared-id-without-sequence"),
        event("response.completed", { response: { status: "completed", output: [nativeCall("finish_task")] } }, "shared-id-without-sequence")
    ])]);
    await f.run();
    assert.equal(f.requests.length, 1);
    const thought = f.chat.messages.find(message => message.hidden && message.role === "assistant" && message.reasoning);
    assert.equal(thought.reasoning, "认真考虑。认真考虑。");
    assert.ok(f.visible().some(message => message.content === "这是实际回答。"));
});

test("thinking-only prose plus native finish cannot silently complete and recovers with actual final", async () => {
    const intent = '<think>THOUGHT_ONLY {"tool_call":{"name":"run_shell","arguments":{"command":"DO_NOT_RUN"}}}</think>';
    const f = fixture([outputResponse(intent, [nativeCall("finish_task")]), outputResponse("这是实际给用户的完整总结。", [nativeCall("finish_task")])]);
    await f.run();
    assert.equal(f.requests.length, 2);
    assert.equal(f.successfulFinishes().length, 1);
    assert.ok(f.chat.messages.some(message => message.toolName === "finish_task" && message.result?.success === false));
    assert.ok(f.visible().some(message => message.content === "这是实际给用户的完整总结。"));
    assert.ok(f.visible().some(message => message.agentRecovery && message.content.includes("尚未提供最终答复")));
    assert.ok(!f.visible().some(message => /THOUGHT_ONLY|任务已完成。/.test(message.content)));
    assert.equal(f.chat.messages.find(message => message.toolName === "agent_protocol").result.diagnostics.issue, "missing_final_answer");
    assert.equal(f.executedTools.length, 0);
});

test("reasoning-only completed envelopes retry finitely, never execute intentions and report unfinished", async () => {
    const reasoning = 'THOUGHT_ONLY 应该更新计划再回答 {"tool_call":{"name":"update_plan","arguments":{"plan":[]}}}';
    const f = fixture([payloadResponse({ status: "completed", output: [{ type: "reasoning", summary: [{ type: "summary_text", text: reasoning }] }] })]);
    await f.run();
    assert.equal(f.requests.length, 3);
    assert.equal(f.successfulFinishes().length, 0);
    assert.equal(f.executedTools.length, 0);
    assert.equal(f.chat.agentPlan, undefined);
    assert.ok(f.visible().some(message => message.failed && message.agentFinal && message.content.includes("本轮任务未完成")));
    assert.ok(!f.visible().some(message => message.content.includes("THOUGHT_ONLY")));
    assert.ok(f.chat.messages.filter(message => message.toolName === "agent_protocol")
        .every(message => message.result.diagnostics.issue === "reasoning_without_output" && !/JSON syntax|malformed/.test(message.content)));
    const correction = f.requests[1].messages.find(message => /不要继续仅在思考通道/.test(message.content));
    assert.ok(correction);
    assert.equal(f.context.isGenerating, false);
    assert.equal(f.context.getGatewayAgentThinkingState(), null);
});

test("native finish without prose remains unfinished after bounded attempts", async () => {
    const f = fixture([outputResponse("", [nativeCall("finish_task")])]);
    await f.run();
    assert.equal(f.requests.length, 3);
    assert.equal(f.successfulFinishes().length, 0);
    assert.ok(f.visible().at(-1).failed);
    assert.match(f.visible().at(-1).content, /没有提供可显示的最终答复/);
    assert.doesNotMatch(f.visible().map(message => message.content).join("\n"), /任务已完成。/);
});

test("actual plan call continues into final Responses completed output rather than ending the loop", async () => {
    const plan = [{ step: "理解问题", status: "completed" }, { step: "输出总结", status: "in_progress" }];
    const f = fixture([outputResponse("", [nativeCall("update_plan", { plan })]), streamResponse([
        event("response.completed", { response: { status: "completed", output: [outputMessage("这是计划之后的实际总结。"), nativeCall("finish_task")] } })
    ])]);
    await f.run();
    assert.equal(f.requests.length, 2);
    assert.equal(f.chat.agentPlan.steps.length, 2);
    assert.equal(f.successfulFinishes().length, 1);
    assert.ok(f.visible().some(message => message.content === "这是计划之后的实际总结。"));
});

const dsmlPlanSample = [
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="update_plan">',
    '<｜｜DSML｜｜ parameter name="explanation" string="true">实际验证通过，接下来总结。</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="plan" string="false">[{"step":"实际验证","status":"completed"}]</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>'
].join("\n");

test("a live double-fullwidth DSML plan is executable protocol and never a final answer", async () => {
    const f = fixture([outputResponse(dsmlPlanSample), outputResponse("", [nativeCall("finish_task")]),
        outputResponse("已完成文件修改，实际验证通过。", [nativeCall("finish_task")])]);
    await f.run();
    assert.equal(f.requests.length, 3);
    assert.ok(f.chat.messages.some(message => message.toolName === "update_plan" && message.result?.success));
    assert.ok(f.visible().some(message => message.agentFinal && message.content === "已完成文件修改，实际验证通过。"));
    assert.ok(f.visible().some(message => message.agentRecovery && /尚未提供最终答复/.test(message.content)));
    assert.doesNotMatch(f.visible().map(message => message.content).join("\n"), /DSML|dsml_|string="false"/);
    assert.equal(f.successfulFinishes().length, 1);
});

test("a native finish accompanied only by DSML must recover with actual prose", async () => {
    const f = fixture([outputResponse(dsmlPlanSample, [nativeCall("finish_task")]),
        outputResponse("真实的中文最终总结。", [nativeCall("finish_task")])]);
    await f.run();
    assert.equal(f.requests.length, 2);
    assert.ok(f.visible().some(message => message.agentFinal && message.content === "真实的中文最终总结。"));
    assert.doesNotMatch(f.visible().map(message => message.content).join("\n"), /DSML|dsml_/);
    assert.equal(f.successfulFinishes().length, 1);
});

test("DSML cleanup preserves native-tool final Markdown code fences and ordinary HTML", async () => {
    const prose = "已完成，结果如下：\n```js\nconst total = 3;\n```\n<p>中文说明。</p>";
    const f = fixture([outputResponse(`${dsmlPlanSample}\n${prose}`, [nativeCall("finish_task")])]);
    await f.run();
    assert.equal(f.requests.length, 1);
    assert.ok(f.visible().some(message => message.agentFinal && message.content === prose));
    assert.equal(f.successfulFinishes().length, 1);
});

test("a final answer consisting only of a code fence retains Markdown with and without native finish", async () => {
    const prose = "```javascript\nconst total = 3;\n```";
    for (const calls of [[], [nativeCall("finish_task")]]) {
        const f = fixture([outputResponse(prose, calls)]);
        await f.run();
        assert.equal(f.requests.length, 1);
        assert.ok(f.visible().some(message => message.agentFinal && message.content === prose));
        assert.equal(f.successfulFinishes().length, 1);
    }
});

test("legal plan, actual work, completed plan and final answer do not produce protocol errors", async () => {
    const f = fixture([outputResponse(dsmlPlanSample), outputResponse("", [nativeCall("read_file_range", { path: "a.txt" })]),
        outputResponse(dsmlPlanSample), outputResponse("实际工作已完成，验证通过。", [nativeCall("finish_task")])]);
    await f.run();
    assert.equal(f.requests.length, 4);
    assert.equal(f.executedTools.length, 1);
    assert.equal(f.chat.messages.filter(message => message.toolName === "update_plan").length, 2);
    assert.ok(!f.chat.messages.some(message => message.toolName === "agent_protocol"));
    assert.equal(f.successfulFinishes().length, 1);
});

test("malformed DSML cannot complete even alongside a valid native finish", async () => {
    const broken = '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="write_file"><｜｜DSML｜｜ parameter name="path" string="false">{broken}</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
    const f = fixture([outputResponse(broken, [nativeCall("finish_task")])]);
    await f.run();
    assert.equal(f.requests.length, 3);
    assert.equal(f.executedTools.length, 0);
    assert.equal(f.successfulFinishes().length, 0);
    assert.ok(f.visible().at(-1).failed);
    assert.doesNotMatch(f.visible().map(message => message.content).join("\n"), /DSML|dsml_|\{broken\}/);
});

test("old protocol-only display rows cannot satisfy a later bare finish", async () => {
    const f = fixture([outputResponse("", [nativeCall("finish_task")])]);
    const oldProtocol = { role: "assistant", content: dsmlPlanSample, agentDisplayOnly: true };
    f.chat.messages.push(oldProtocol);
    await f.run();
    assert.equal(f.requests.length, 3);
    assert.equal(f.successfulFinishes().length, 0);
    assert.ok(!oldProtocol.agentFinal);
    assert.ok(f.visible().at(-1).failed);
});

test("repeated plan-only output produces a visible unfinished error instead of an unbounded loop", async () => {
    const f = fixture([outputResponse("", [nativeCall("update_plan", { plan: [{ step: "准备回答", status: "in_progress" }] })])]);
    await f.run();
    assert.equal(f.requests.length, 3);
    assert.equal(f.successfulFinishes().length, 0);
    assert.ok(f.visible().some(message => message.failed && /反复更新计划/.test(message.content)));
    const reminders = f.chat.messages.filter(message => message.toolName === "agent_protocol");
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].result.diagnostics.issue, "repeated_plan_without_progress");
    assert.doesNotMatch(reminders[0].content, /malformed|JSON syntax|本次错误的工具调用/);
});

test("repeated plan calls with commentary still require an actual final result", async () => {
    const f = fixture([outputResponse("我将先更新计划，然后回答。", [nativeCall("update_plan", {
        plan: [{ step: "准备回答", status: "in_progress" }]
    })])]);
    await f.run();
    assert.equal(f.requests.length, 3);
    assert.equal(f.successfulFinishes().length, 0);
    assert.ok(f.visible().some(message => message.failed && /反复更新计划/.test(message.content)));
});

test("complete output_item.done envelope alone produces the actual answer", async () => {
    const f = fixture([streamResponse([event("response.output_item.done", { item: outputMessage("最终事件中的回答。") })])]);
    await f.run();
    assert.equal(f.requests.length, 1);
    assert.equal(f.successfulFinishes().length, 1);
    assert.ok(f.visible().some(message => message.content === "最终事件中的回答。"));
});

test("reported output limits are distinguished from reasoning-only responses without increasing the limit", async () => {
    const f = fixture([payloadResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
        usage: { output_tokens: 128, output_tokens_details: { reasoning_tokens: 128 } },
        output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "还在思考。" }] }] })]);
    await f.run();
    assert.equal(f.requests.length, 3);
    assert.equal(f.successfulFinishes().length, 0);
    assert.ok(f.visible().some(message => message.failed && /长度限制/.test(message.content)));
    assert.ok(f.requests.every(request => request.max_tokens === undefined));
    assert.ok(f.chat.messages.filter(message => message.toolName === "agent_protocol")
        .every(message => message.result.diagnostics.issue === "output_token_limit"));
});

test("a separate finish-only round can complete the current user's previously visible answer", async () => {
    const f = fixture([outputResponse("当前任务的完整总结已经输出给用户。", [nativeCall("update_plan", {
        plan: [{ step: "输出总结", status: "completed" }]
    })]), outputResponse("", [nativeCall("finish_task")])]);
    await f.run();
    assert.equal(f.requests.length, 2);
    assert.equal(f.successfulFinishes().length, 1);
    assert.ok(f.visible().some(message => message.content === "当前任务的完整总结已经输出给用户。" && message.agentFinal));
    assert.ok(!f.visible().some(message => message.failed));
});

test("a bare finish after real work cannot promote an earlier progress sentence", async () => {
    const progress = "重命名后确认内容包含‘验证通过’，现在删除该文件并创建 followup.json。";
    const final = "已删除临时文件并创建 followup.json，实际验证通过。";
    const f = fixture([
        outputResponse(progress, [nativeCall("delete_path", { path: "temp.txt" })]),
        outputResponse("", [nativeCall("finish_task")]),
        outputResponse(final, [nativeCall("finish_task")])
    ]);
    await f.run();
    assert.equal(f.requests.length, 3);
    assert.equal(f.executedTools.length, 1);
    assert.equal(f.successfulFinishes().length, 1);
    assert.ok(f.visible().some(message => message.content === progress && !message.agentFinal));
    assert.ok(f.visible().some(message => message.content === final && message.agentFinal));
    assert.ok(f.visible().some(message => message.agentRecovery && /尚未提供最终答复/.test(message.content)));
});

test("a newly consumed queued user turn receives a fresh reasoning-only retry budget", async () => {
    const reasoning = payloadResponse({ status: "completed", output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "思考当前问题。" }] }] });
    const f = fixture([reasoning]);
    const send = f.context.fetchEndpointWithFallback;
    f.context.fetchEndpointWithFallback = async body => {
        const response = await send(body);
        if (f.requests.length === 2) f.context.queuedAgentMessages.push({ content: "新用户任务", gatewayChatId: f.chat.id });
        return response;
    };
    await f.run();
    assert.equal(f.requests.length, 5);
    assert.equal(f.chat.messages.filter(message => message.role === "user").length, 2);
    assert.equal(f.visible().filter(message => /（1\/3）/.test(message.content)).length, 2);
    assert.ok(f.visible().at(-1).failed);
});

test("new queued tasks reset the missing-final counter and cannot reuse an old user's answer", async () => {
    const f = fixture([outputResponse("", [nativeCall("finish_task")])]);
    const send = f.context.fetchEndpointWithFallback;
    f.context.fetchEndpointWithFallback = async body => {
        const response = await send(body);
        if (f.requests.length === 2) f.context.queuedAgentMessages.push({ content: "新任务仍需自己的答复", gatewayChatId: f.chat.id });
        return response;
    };
    await f.run();
    assert.equal(f.requests.length, 5);
    assert.equal(f.successfulFinishes().length, 0);
    assert.ok(f.visible().at(-1).failed);
});

test("new queued user tasks reset the plan-only counter", async () => {
    const plan = outputResponse("", [nativeCall("update_plan", { plan: [{ step: "输出新任务总结", status: "in_progress" }] })]);
    const f = fixture([plan, plan, plan, outputResponse("新任务的实际总结。", [nativeCall("finish_task")])]);
    const send = f.context.fetchEndpointWithFallback;
    f.context.fetchEndpointWithFallback = async body => {
        const response = await send(body);
        if (f.requests.length === 2) f.context.queuedAgentMessages.push({ content: "另一项任务", gatewayChatId: f.chat.id });
        return response;
    };
    await f.run();
    assert.equal(f.requests.length, 4);
    assert.equal(f.successfulFinishes().length, 1);
    assert.ok(!f.visible().some(message => message.failed));
});

test("failed work batched with finish defers success claims and requests an actual repair round", async () => {
    const f = fixture([
        outputResponse("文件已写入并验证。", [nativeCall("write_file", { path: "a.txt", content: "x" }), nativeCall("finish_task")]),
        outputResponse("", [nativeCall("write_file", { path: "a.txt", content: "x" })]),
        outputResponse("已重试写入并确认完成。", [nativeCall("finish_task")])
    ]);
    let writes = 0;
    f.context.electronAPI.executeAgentTool = async request => {
        f.executedTools.push(request);
        return ++writes === 1 ? { success: false, error: "DISK_FULL" } : { success: true };
    };
    await f.run();
    assert.equal(f.requests.length, 3);
    assert.equal(f.successfulFinishes().length, 1);
    assert.equal(f.executedTools.length, 2);
    assert.ok(!f.visible().some(message => message.content === "文件已写入并验证。"));
    assert.ok(f.visible().some(message => /实际工具执行失败/.test(message.content)));
    assert.ok(f.visible().some(message => message.content === "已重试写入并确认完成。" && message.agentFinal));
    assert.ok(f.requests[1].messages.some(message => message.content.includes("DISK_FULL")));
    assert.equal(f.chat.messages.find(message => message.toolName === "agent_protocol").result.diagnostics.issue, "tool_execution_failed");
});

test("repeated failed work before finish terminates visibly without accepting a false success", async () => {
    const f = fixture([outputResponse("文件已保存。", [nativeCall("write_file", { path: "a.txt", content: "x" }), nativeCall("finish_task")])]);
    f.context.electronAPI.executeAgentTool = async () => ({ success: false, error: "READ_ONLY_DISK" });
    await f.run();
    assert.equal(f.requests.length, 3);
    assert.equal(f.successfulFinishes().length, 0);
    assert.ok(!f.visible().some(message => message.content === "文件已保存。"));
    assert.ok(f.visible().at(-1).failed);
    assert.match(f.visible().at(-1).content, /实际工具连续执行失败/);
});

test("an earlier exploration failure that was repaired does not permanently block final completion", async () => {
    const f = fixture([
        outputResponse("", [nativeCall("read_file_range", { path: "missing.txt" })]),
        outputResponse("", [nativeCall("write_file", { path: "missing.txt", content: "created" })]),
        outputResponse("文件原先不存在，现已创建。", [nativeCall("finish_task")])
    ]);
    f.context.electronAPI.executeAgentTool = async request => request.name === "read_file_range"
        ? { success: false, error: "ENOENT" } : { success: true };
    await f.run();
    assert.equal(f.requests.length, 3);
    assert.equal(f.successfulFinishes().length, 1);
    assert.ok(!f.visible().some(message => message.failed));
});

test("a failed finish batch invalidates stale prose before a later bare finish", async () => {
    const f = fixture([
        outputResponse("这是之前尚未验证的总结。", [nativeCall("update_plan", { plan: [{ step: "写入", status: "in_progress" }] })]),
        outputResponse("写入已成功。", [nativeCall("write_file", { path: "a.txt", content: "x" }), nativeCall("finish_task")]),
        outputResponse("", [nativeCall("finish_task")])
    ]);
    f.context.electronAPI.executeAgentTool = async () => ({ success: false, error: "WRITE_FAILED" });
    await f.run();
    assert.equal(f.requests.length, 5);
    assert.equal(f.successfulFinishes().length, 0);
    assert.ok(!f.visible().some(message => message.content === "写入已成功。"));
    assert.ok(f.visible().at(-1).failed);
});

test("normal complex tasks can interleave repeated plan updates with real tools and finish", async () => {
    const plan = nativeCall("update_plan", { plan: [{ step: "完成工作", status: "in_progress" }] });
    const f = fixture([
        outputResponse("", [plan]), outputResponse("", [nativeCall("read_file_range", { path: "a.txt" })]),
        outputResponse("", [plan]), outputResponse("", [nativeCall("write_file", { path: "a.txt", content: "x" })]),
        outputResponse("", [plan]), outputResponse("已完成实际工作。", [nativeCall("read_file_range", { path: "a.txt" }), nativeCall("finish_task")])
    ]);
    await f.run();
    assert.equal(f.requests.length, 6);
    assert.equal(f.successfulFinishes().length, 1);
    assert.ok(!f.visible().some(message => message.failed));
    assert.ok(f.visible().some(message => message.content === "已完成实际工作。"));
});

test("Agent history keeps user/tool chronology and the existing Responses input prefix across rounds", async () => {
    const toolText = JSON.stringify({ tool_call: { name: "read_file_range", arguments: { path: "a.txt" } } });
    const f = fixture([outputResponse(toolText), outputResponse("文件已读取。", [nativeCall("finish_task")])]);
    await f.run();
    assert.equal(f.requests.length, 2);
    const first = f.context.buildRequestPayloadForEndpoint(f.requests[0], "/responses");
    const second = f.context.buildRequestPayloadForEndpoint(f.requests[1], "/responses");
    assert.equal(second.instructions, first.instructions);
    assert.equal(JSON.stringify(second.input.slice(0, first.input.length)), JSON.stringify(first.input));
    assert.deepEqual(Array.from(second.input, message => message.role), ["user", "assistant", "user"]);
    assert.equal(second.input[0].content[0].text, "简单总结未来");
    assert.equal(second.input[1].content[0].text, toolText);
    assert.match(second.input[2].content[0].text, /^\[Tool Result: read_file_range\]/);
    assert.equal(second.input.filter(message => message.content.some(part => part.text === "简单总结未来")).length, 1);
});

test("Agent history replays complete opaque reasoning items on Responses without sending them to other protocols", async () => {
    const opaque = { type: "reasoning", id: "rs_agent", summary: [{ type: "summary_text", text: "safe summary" }],
        encrypted_content: "OPAQUE_AGENT_STATE" };
    const f = fixture([
        payloadResponse({ status: "completed", output: [opaque] }),
        outputResponse("Agent 完成回答。", [nativeCall("finish_task")])
    ]);
    await f.run();
    const saved = f.chat.messages.find(message => message.responsesReasoning?.items?.length);
    assert.ok(saved);
    assert.equal(saved.content, "");
    assert.deepEqual(saved.responsesReasoning.items, [opaque]);
    const second = f.requests[1];
    const responses = f.context.buildRequestPayloadForEndpoint(second, "/responses");
    assert.ok(responses.input.some(message => message.type === "reasoning"
        && message.encrypted_content === "OPAQUE_AGENT_STATE"));
    for (const endpoint of ["/chat/completions", "/v1/messages"]) {
        const adapted = f.context.buildRequestPayloadForEndpoint(second, endpoint);
        assert.ok(!JSON.stringify(adapted).includes("OPAQUE_AGENT_STATE"));
    }
});

test("view_image results become actual image blocks in Responses, Chat Completions and Messages payloads", async () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    const f = fixture([outputResponse("", [nativeCall("view_image", { path: "sample.png" })]),
        outputResponse("图片中的主要颜色是红色。", [nativeCall("finish_task")])]);
    f.context.electronAPI.executeAgentTool = async () => ({ success: true, path: "sample.png", mimeType: "image/png", dataUrl });
    await f.run();
    assert.equal(f.requests.length, 2);
    const base = f.requests[1];
    const toolResult = base.messages.find(message => Array.isArray(message.content)
        && message.content.some(part => part.type === "image_url"));
    assert.ok(toolResult);
    assert.match(toolResult.content[0].text, /sample\.png/);
    assert.doesNotMatch(toolResult.content[0].text, /base64|dataUrl/);
    assert.equal(toolResult.content[1].image_url.url, dataUrl);

    const responses = f.context.buildRequestPayloadForEndpoint(base, "/responses");
    assert.ok(responses.input.some(message => message.content.some(part => part.type === "input_image" && part.image_url === dataUrl)));
    assert.ok(!responses.input.flatMap(message => message.content).some(part => part.text?.includes(dataUrl)));
    const completions = f.context.buildRequestPayloadForEndpoint(base, "/chat/completions");
    assert.ok(completions.messages.some(message => Array.isArray(message.content)
        && message.content.some(part => part.type === "image_url" && part.image_url.url === dataUrl)));
    const messages = f.context.buildRequestPayloadForEndpoint(base, "/v1/messages");
    assert.ok(messages.messages.some(message => message.content.some(part => part.type === "image"
        && part.source.media_type === "image/png" && part.source.data === dataUrl.split(",")[1])));
});

test("persisted image JSON without a result object is restored as an image and oversized-image notes stay textual", async () => {
    const dataUrl = "data:image/jpeg;base64,AAABBB";
    const f = fixture([outputResponse("最终说明。", [nativeCall("finish_task")])]);
    f.chat.messages.push({ role: "tool", toolName: "view_image", status: "done",
        content: JSON.stringify({ success: true, path: "old.jpg", dataUrl }) });
    f.chat.messages.push({ role: "tool", toolName: "view_image", status: "done",
        result: { success: true, path: "large.png", dataUrl: "", note: "image exceeds 8MB, data URL omitted" } });
    await f.run();
    const base = f.requests[0];
    const restored = base.messages.find(message => Array.isArray(message.content));
    assert.equal(restored.content[1].image_url.url, dataUrl);
    assert.doesNotMatch(restored.content[0].text, /AAABBB|dataUrl/);
    const omitted = base.messages.find(message => typeof message.content === "string" && message.content.includes("large.png"));
    assert.match(omitted.content, /data URL omitted/);
    assert.doesNotMatch(omitted.content, /"dataUrl"/);
});
