const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const AgentProtocol = require("../renderer/agent-protocol");
const AgentActivity = require("../renderer/agent-activity");
const ToolCallNormalizer = require("../renderer/tool-call-normalizer");
const AIUIMemoryTransport = require("../renderer/memory-transport");
const { createStore } = require("../renderer/user-memory");

const projectRoot = path.resolve(__dirname, "..");
const agentSource = fs.readFileSync(path.join(projectRoot, "renderer", "agent-ui.js"), "utf8");
const html = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
const adapterNames = ["extractResponsesTextContent", "extractResponsesOutputText", "extractResponsesReasoningText",
    "extractChatCompletionUpdate", "extractStreamingUpdate", "extractMessagesStreamUpdate", "extractMessagesOutputText",
    "extractMessagesReasoningText", "mergeStreamingText", "parseSSEEventBlock", "getStreamingErrorMessage", "extractNonStreamingResponseText",
    "buildRequestPayloadForEndpoint", "buildResponsesInputFromMessages", "buildMessagesPayloadFromBase",
    "buildMessagesContentBlocks", "toAnthropicImageBlock", "cacheControlEnabled",
    "isGeminiEndpoint", "isOllamaEndpoint", "toGeminiParts", "buildGeminiPayloadFromBase", "buildOllamaPayloadFromBase",
    "extractGeminiStreamUpdate", "extractGeminiOutputText", "extractOllamaStreamUpdate", "extractOllamaOutputText"];
const adapterSource = adapterNames.map(name => {
    const match = html.match(new RegExp(`^        function ${name}\\b[\\s\\S]*?\\n        \\}`, "m"));
    if (!match) throw new Error(`Cannot extract shipped adapter ${name}`);
    return match[0];
}).join("\n");

function element() {
    const children = new Map();
    return { value: "", textContent: "", innerHTML: "", dataset: {}, isConnected: true, style: { removeProperty() {} },
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        querySelector(selector) { if (!children.has(selector)) children.set(selector, element()); return children.get(selector); },
        querySelectorAll: () => [], setAttribute() {}, append() {}, appendChild() {}, insertBefore() {}, replaceChildren() {}, remove() {}, scrollTop: 0, scrollHeight: 0 };
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

function fixture(responses, { memory = false, endpoint = "/responses", insertion } = {}) {
    const nodes = new Map();
    const values = new Map();
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    const memoryStore = memory ? createStore(storage) : null;
    const requests = [];
    const memoryAtRequest = [];
    const executedTools = [];
    const retryNotices = [];
    if (insertion) storage.setItem("agent_message_insertion", insertion);
    const chat = { id: "test-chat", title: "简单总结未来", agentEnabled: true, agentSystemPrompt: "已有用户规则",
        agentFixedPrompt: "严格按照工具定义来调用，你现在不身处于你的官方cli环境！", messages: [{ role: "user", content: "简单总结未来" }] };
    const context = {
        console, Date, Promise, AbortController, AbortSignal, TextDecoder, CSS: { escape: String },
        setInterval: () => 1, clearInterval() {}, clearTimeout: clearImmediate,
        setTimeout(callback, delay) {
            if (delay !== 5000) return 1;
            retryNotices.push(context.agentReconnectNotice);
            return setImmediate(callback);
        },
        requestAnimationFrame: setImmediate, cancelAnimationFrame: clearImmediate, renderAssistantMarkdown: String,
        document: { body: element(), createElement: element, querySelector: () => null,
            getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); } },
        localStorage: storage, chats: [chat], activeChatId: chat.id,
        queuedAgentMessages: [], isGenerating: false, contextCompactionRunning: false, isImageMode: false,
        currentTemp: 0.7, maxTokensLimit: 0, abortController: null, developerModeEnabled: false, logLevel: "info", lastPromptCacheDebug: null,
        AgentProtocol, AgentActivity, ToolCallNormalizer, AIUIMemory: memoryStore, AIUIMemoryTransport, lucide: { createIcons() {} },
        renderThinkingText() {}, escapeHtml: String, showVoiceNotification() {}, hideVoiceNotification() {}, closeAnimatedModal() {},
        updateSettingsLocks() {}, renderChatHistory() {}, updateAttachMenuButtons() {}, scrollChatToBottom() {},
        renderMessagesWithResolvedRefs: async () => {}, appendMessageToUI: element,
        buildCompactedChatMessages: value => value.messages,
        buildSingleApiMessage: async message => ({ role: message.role, content: message.content }),
        getRequestEndpoint: () => endpoint, getBaseURL: () => "https://model.test/v1", logPromptCacheDebug() {}, appendLog() {},
        getAgentDetailDefaultBehavior: () => "expanded",
        fetchEndpointWithFallback: async (body, endpoint = "/responses", _signal, options = {}) => {
            const requestBody = options.decorateRequest?.(body, endpoint) || body;
            requests.push(JSON.parse(JSON.stringify(requestBody)));
            memoryAtRequest.push(memoryStore?.list());
            if (requests.length > 8) throw new Error("Unexpected unbounded model loop");
            return { response: responses[Math.min(requests.length - 1, responses.length - 1)], endpoint, requestBody,
                requestDecorated: Boolean(options.decorateRequest) };
        },
        electronAPI: { getAgentWorkspace: async () => ({ exists: true }),
            executeAgentTool: async request => { executedTools.push(request); return { success: true }; } }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(adapterSource, context, { filename: "shipped-index-adapters.js" });
    vm.runInContext(agentSource, context, { filename: "agent-ui.js" });
    return { context, chat, requests, executedTools, memoryStore, memoryAtRequest, retryNotices,
        run: async () => {
            await context.requestAgentLoop("model", chat);
            assert.ok(!chat.messages.some(message => /^Agent 执行失败：.*(?:not defined|is not a function)/.test(message.content)),
                "test fixture must supply the actual renderer environment");
        },
        visible: () => chat.messages.filter(message => message.role === "assistant" && !message.hidden),
        successfulFinishes: () => chat.messages.filter(message => message.toolName === "finish_task" && message.result?.success === true) };
}

test("all backend HTTP failures retry six times and report each status in the transcript", async () => {
    const statuses = [400, 404, 401, 403, 429, 500];
    const f = fixture([...statuses.map(status => ({ ok: false, status })), outputResponse("后端恢复后的完整答复。")]);
    await f.run();
    assert.equal(f.requests.length, 7);
    assert.equal(f.retryNotices.length, 6);
    statuses.forEach((status, index) => assert.match(f.retryNotices[index], new RegExp(`^后端错误：HTTP ${status} .+ 正在重试 （${index + 1}/6）$`)));
    assert.equal(f.context.agentReconnectNotice, "");
    assert.equal(f.visible().at(-1).content, "后端恢复后的完整答复。");
});

test("empty and incomplete backend replies exhaust the same retry budget without running a partial tool", async () => {
    const partial = streamResponse([event("response.output_text.delta", { delta: '{"tool_call":{"name":"list_dir","arguments":{"path":"."}}}' })]);
    const f = fixture([partial, payloadResponse({ status: "completed", output: [] })]);
    await f.run();
    assert.equal(f.requests.length, 7);
    assert.equal(f.retryNotices.length, 6);
    assert.match(f.retryNotices[0], /回复流提前中断/);
    assert.match(f.retryNotices.at(-1), /后端返回空响应/);
    assert.equal(f.executedTools.length, 0);
    assert.match(f.visible().at(-1).content, /已重试 6 次/);
});

test("backend stream errors and invalid payloads recover without saving the failed attempt", async () => {
    const broken = streamResponse([
        event("response.output_text.delta", { delta: "中断前的正文" }),
        event("response.failed", { response: { error: { message: "暂时无法继续" } } })
    ]);
    const f = fixture([broken, streamResponse(["data: {oops}\n\n"]), outputResponse("可用答复。")]);
    await f.run();
    assert.equal(f.requests.length, 3);
    assert.match(f.retryNotices[0], /暂时无法继续/);
    assert.match(f.retryNotices[1], /无效的响应格式/);
    assert.doesNotMatch(JSON.stringify(f.chat.messages), /中断前的正文/);
});

test("network and backend idle timeouts use the retry budget and respect cancellation", async () => {
    const f = fixture([outputResponse("重试成功。")]);
    const setTimer = f.context.setTimeout;
    const send = f.context.fetchEndpointWithFallback;
    let attempts = 0;
    f.context.setTimeout = (callback, delay) => delay === 120000 ? setImmediate(callback) : setTimer(callback, delay);
    f.context.fetchEndpointWithFallback = async (body, endpoint, signal, options) => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("Failed to fetch");
        if (attempts === 2) return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return send(body, endpoint, signal, options);
    };
    await f.run();
    assert.equal(attempts, 3);
    assert.match(f.retryNotices[0], /网络连接失败或中断/);
    assert.match(f.retryNotices[1], /等待后端回复超时/);
    assert.equal(f.visible().at(-1).content, "重试成功。");

    const stopped = fixture([{ ok: false, status: 401 }]);
    const stoppedTimer = stopped.context.setTimeout;
    stopped.context.setTimeout = (callback, delay) => {
        if (delay === 5000) return setImmediate(() => stopped.context.stopAgentTask());
        return stoppedTimer(callback, delay);
    };
    await stopped.run();
    assert.equal(stopped.requests.length, 1);
    assert.equal(stopped.context.agentReconnectNotice, "");
    assert.equal(stopped.visible().at(-1).content, "Agent 已停止。");
});

test("interrupt sends new messages immediately and discards the aborted model turn", async () => {
    const f = fixture([outputResponse("未应用新消息。"), outputResponse("这是调整后的答复。")], { insertion: "interrupt" });
    const send = f.context.fetchEndpointWithFallback;
    f.context.fetchEndpointWithFallback = async (...args) => {
        const response = await send(...args);
        if (f.requests.length > 1) return response;
        const signal = args[2];
        const interrupted = new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        assert.equal(f.context.queueAgentUserMessage(f.chat, "改用简短的方案"), true);
        assert.equal(signal.aborted, true);
        assert.equal(f.context.queueAgentUserMessage(f.chat, "并给出验证步骤"), true);
        return interrupted;
    };
    await f.run();
    assert.deepEqual(f.requests[1].messages.slice(-2), [
        { role: "user", content: "改用简短的方案" }, { role: "user", content: "并给出验证步骤" }
    ]);
    assert.equal(f.retryNotices.length, 0);
    assert.deepEqual(f.visible().map(message => message.content), ["这是调整后的答复。"]);
});

test("private native Agent memory keeps textual finish and the cached conversation prefix", async () => {
    const saved = "用户偏好四格缩进。";
    const finish = '{"tool_call":{"name":"finish_task","arguments":{}}}';
    const f = fixture([outputResponse(`已了解你的代码风格。\n${finish}`, [nativeCall("manage_memory", { action: "add", text: saved })]),
        outputResponse("这是一条后续回复。")], { memory: true });
    await f.run();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].tools[0].name, "manage_memory");
    assert.equal(f.successfulFinishes().length, 1);
    assert.equal(f.visible().at(-1).content, "已了解你的代码风格。");
    const activity = { created: 1 };
    assert.deepEqual(f.visible().at(-1).memoryActivity, activity);
    const savedChat = JSON.parse(f.context.localStorage.getItem("ai_chats"))[0];
    assert.deepEqual(savedChat.messages.find(message => message.agentFinal).memoryActivity, activity);
    assert.deepEqual(f.memoryStore.list().map(record => record.text), [saved]);
    assert.doesNotMatch(JSON.stringify(f.chat.messages), /manage_memory|四格缩进/);

    f.chat.messages.push({ role: "user", content: "继续之前的回复。" });
    await f.run();
    assert.equal(f.requests[1].messages[0].content, f.requests[0].messages[0].content);
    assert.match(f.memoryStore.getContext({ id: "another-chat" }), /四格缩进/);
});

test("an Agent memory-only response waits privately for a visible answer", async () => {
    const saved = "用户偏好短标题。";
    const f = fixture([outputResponse("", [nativeCall("manage_memory", { action: "add", text: saved })]),
        outputResponse("会采用简短标题。")], { memory: true });
    await f.run();
    assert.deepEqual(f.memoryAtRequest, [[], []]);
    assert.match(f.requests[1].messages.at(-1).content, /no complete answer/);
    assert.deepEqual(f.visible().map(message => message.content), ["会采用简短标题。"]);
    assert.deepEqual(f.visible().at(-1).memoryActivity, { created: 1 });
    assert.deepEqual(f.memoryStore.list().map(record => record.text), [saved]);
});

test("remote Agent input receives a normal response without desktop memories or tool arguments", async () => {
    const saved = "用户偏好 PDF 报告。";
    const remote = "用户偏好远程修改记录。";
    const hiddenCall = JSON.stringify({ tool_call: { name: "manage_memory", arguments: { action: "add", text: remote } } });
    const f = fixture([outputResponse(`收到你的任务。\n${hiddenCall}`, [nativeCall("manage_memory", { action: "add", text: remote })])], { memory: true });
    f.memoryStore.applyCalls([{ name: "manage_memory", args: { action: "add", text: saved } }]);
    f.context.queuedAgentMessages.push({ gatewayChatId: f.chat.id, content: "来自网关的任务" });
    await f.run();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].tools, undefined);
    assert.doesNotMatch(JSON.stringify(f.requests[0]), /PDF 报告/);
    assert.doesNotMatch(JSON.stringify(f.chat.messages), /manage_memory|远程修改记录/);
    assert.equal(f.visible().at(-1).content, "收到你的任务。");
    assert.deepEqual(f.memoryStore.list().map(record => record.text), [saved]);
});

test("refreshes the command tool definitions for saved Agent chats", async () => {
    const f = fixture([]);
    const [system] = await f.context.buildAgentMessagesForContextEstimate(f.chat);
    assert.equal(system.role, "system");
    assert.match(system.content, /For every run_shell and start_process call, include a short, accurate description/);
    assert.match(system.content, /User System Prompt\n\n已有用户规则/);
});

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
