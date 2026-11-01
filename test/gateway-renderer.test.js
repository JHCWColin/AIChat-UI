const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const AgentProtocol = require("../agent-protocol");
const ToolCallNormalizer = require("../tool-call-normalizer");

const readSource = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));

function node() {
    const children = new Map();
    const classes = new Set();
    return { value: "", textContent: "", innerHTML: "", dataset: {}, style: { removeProperty() {} }, hidden: false,
        classList: { add: value => classes.add(value), remove: value => classes.delete(value),
            contains: value => classes.has(value), toggle(value, force) {
                const enabled = force === undefined ? !classes.has(value) : force;
                if (enabled) classes.add(value); else classes.delete(value);
                return enabled;
            } },
        querySelector(selector) { if (!children.has(selector)) children.set(selector, node()); return children.get(selector); },
        querySelectorAll: () => [], setAttribute() {}, appendChild() {}, remove() {},
        addEventListener() {}, scrollTop: 0, scrollHeight: 0 };
}

function fixture({ agent = true, workspace } = {}) {
    const elements = new Map();
    const snapshots = [];
    const acknowledgements = [];
    const events = {};
    const intervals = [];
    const records = new Map();
    const apiRequests = [];
    const notifications = [];
    const createdNodes = [];
    const chat = { id: "active", title: "当前任务", agentEnabled: agent,
        agentWorkspace: "SECRET_WORKSPACE", agentFixedPrompt: "固定提示词 严格按照工具定义来调用，你现在不身处于你的官方cli环境！",
        messages: [] };
    const context = {
        console, Date, Promise, AbortController, TextDecoder, setTimeout: () => 1,
        setInterval: callback => { intervals.push(callback); return intervals.length; }, clearInterval() {},
        document: { body: node(), querySelector: () => null,
            getElementById(id) { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); },
            createElement: () => { const element = node(); createdNodes.push(element); return element; }, querySelectorAll: () => [] },
        addEventListener: (name, callback) => { events[name] = callback; },
        localStorage: { getItem: key => records.get(key) || null, setItem: (key, value) => records.set(key, value) },
        chats: [chat, { id: "other", title: "其他会话", agentEnabled: true,
            messages: [{ role: "user", content: "OTHER_CHAT_SECRET" }] }],
        activeChatId: chat.id, isGenerating: false, contextCompactionRunning: false,
        queuedAgentMessages: [], isImageMode: false, currentAttachments: [{ name: "LOCAL_ATTACHMENT" }],
        AgentProtocol, ToolCallNormalizer, systemPrompt: "SECRET_SYSTEM_PROMPT", currentTemp: 0.7,
        maxTokensLimit: 0, abortController: null, developerModeEnabled: false, logLevel: "info", lastPromptCacheDebug: null,
        lucide: { createIcons() {} }, updateSettingsLocks() {}, renderQueuedAgentMessages() {},
        showVoiceNotification: message => notifications.push(message), hideVoiceNotification() {},
        closeAnimatedModal() {},
        escapeHtml: value => value, renderThinkingText() {}, renderChatHistory() {}, updateAttachMenuButtons() {},
        renderMessagesWithResolvedRefs: async () => {}, appendMessageToUI: () => node(),
        buildCompactedChatMessages: value => value.messages,
        buildSingleApiMessage: async message => ({ role: message.role, content: message.content }),
        getRequestEndpoint: () => "/responses", getBaseURL: () => "https://model.invalid",
        fetchEndpointWithFallback: async payload => {
            apiRequests.push(payload);
            return { response: { ok: true, body: null, json: async () => ({}) }, endpoint: "/responses", requestBody: payload };
        },
        extractStreamingUpdate: () => ({}), extractNonStreamingResponseText: () => "已完成任务。",
        logPromptCacheDebug() {}, appendLog() {}, getAgentDetailDefaultBehavior: () => "collapsed",
        electronAPI: {
            isElectron: true, publishGatewaySnapshot: snapshot => snapshots.push(snapshot),
            completeGatewayMessage: (requestId, result) => acknowledgements.push({ requestId, ...result }),
            onGatewayMessage: callback => { events.message = callback; }, openAgentGateway: async () => {},
            getAgentWorkspace: workspace || (async () => ({ exists: true, path: "SECRET_WORKSPACE" }))
        }
    };
    context.window = context;
    context.queuedAgentMessages = [];
    vm.createContext(context);
    vm.runInContext(readSource("agent-ui.js"), context, { filename: "agent-ui.js" });
    vm.runInContext(readSource("gateway-renderer.js"), context, { filename: "gateway-renderer.js" });
    context.document.getElementById("model-select").value = "desktop-model";
    context.document.getElementById("user-input").value = "LOCAL_DRAFT";
    return { context, chat, snapshots, acknowledgements, events, intervals, apiRequests, elements, notifications, createdNodes,
        request: (id, text = "继续任务", chatId = "active", role = "write") =>
            events.message({ requestId: id, text, chatId, device: { id: "device", role } }) };
}

test("snapshot shares active prose, reasoning previews and allowed tool summaries without payloads", () => {
    const f = fixture();
    f.chat.messages = [
        { role: "system", content: "SECRET_SYSTEM" },
        { role: "user", content: "可见问题", attachments: [{ data: "SECRET_ATTACHMENT" }] },
        { role: "assistant", content: "SECRET_RAW_TOOL_JSON", hidden: true, reasoning: "公开思考" },
        { role: "tool", toolName: "run_shell", status: "done", arguments: { command: "npm run test\nSECRET_COMMAND_LINE_2", env: "SECRET_ENV" }, content: "SECRET_OUTPUT" },
        { role: "assistant", content: '可见回答\n{"tool_call":{"name":"finish_task","arguments":{}}}', reasoning: "公开思考" }
    ];
    f.intervals.at(-1)();
    const snapshot = f.snapshots.at(-1);
    assert.equal(snapshot.chatId, "active");
    assert.deepEqual(Array.from(snapshot.messages, value => value.content), ["可见问题", "公开思考", "运行指令", "可见回答"]);
    assert.equal(snapshot.messages[1].kind, "thinking");
    assert.equal(snapshot.messages[2].toolName, "run_shell");
    assert.equal(snapshot.messages[2].detail, "npm run test");
    assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|OTHER_CHAT|tool_call/);
    f.context.activeChatId = "other";
    f.context.chats[1].agentEnabled = false;
    f.intervals.at(-1)();
    assert.equal(f.snapshots.at(-1).agentEnabled, false);
    assert.equal(f.snapshots.at(-1).messages.length, 0);
});

test("remote plain tasks use desktop Agent queue without changing local draft or attachments", async () => {
    const f = fixture();
    await f.request("request-1", "/compact 请把它当作任务文本");
    await settle();
    assert.equal(f.acknowledgements[0].accepted, true);
    assert.equal(f.acknowledgements[0].queued, false);
    assert.equal(f.elements.get("user-input").value, "LOCAL_DRAFT");
    assert.equal(f.context.currentAttachments[0].name, "LOCAL_ATTACHMENT");
    assert.equal(f.chat.messages.filter(message => message.role === "user").length, 1);
    assert.equal(f.chat.messages.find(message => message.role === "user").content, "/compact 请把它当作任务文本");
    assert.equal(f.apiRequests.length, 1);
    assert.equal(f.apiRequests[0].model, "desktop-model");
    assert.ok(f.chat.messages.some(message => message.role === "assistant" && !message.hidden && message.content === "已完成任务。"));
    assert.ok(!f.chat.messages.some(message => message.failed));
    await f.request("request-1", "/compact 请把它当作任务文本");
    assert.equal(f.chat.messages.filter(message => message.role === "user").length, 1);
    assert.equal(f.apiRequests.length, 1);
});

test("read-only, changed-chat and special-mode requests are rejected without queuing", async () => {
    const f = fixture();
    await f.request("read", "text", "active", "read");
    await f.request("old", "text", "other");
    f.context.contextCompactionRunning = true;
    await f.request("compact");
    f.context.contextCompactionRunning = false;
    f.context._desktopWorkRunning = true;
    await f.request("desktop");
    assert.equal(f.acknowledgements.length, 4);
    assert.ok(f.acknowledgements.every(result => result.accepted === false));
    assert.equal(f.context.queuedAgentMessages.length, 0);
    assert.equal(f.apiRequests.length, 0);
});

test("workspace validation reserves chat and rejects overlapping remote sends; failure leaves no remote queue", async () => {
    let finishWorkspace;
    const f = fixture({ workspace: () => new Promise(resolve => { finishWorkspace = resolve; }) });
    const first = f.request("first");
    await settle();
    assert.equal(f.context.isAgentTaskRunning("active"), true);
    assert.equal(f.context.isGenerating, true);
    await f.request("second");
    assert.equal(f.acknowledgements.at(-1).accepted, false);
    finishWorkspace({ exists: false });
    await first;
    assert.equal(f.acknowledgements.at(-1).accepted, false);
    assert.equal(f.context.queuedAgentMessages.length, 0);
    assert.equal(f.context.isAgentTaskRunning(), false);
    assert.equal(f.context.isGenerating, false);
});

test("changed active chat during pending workspace validation cannot receive remote text", async () => {
    let finishWorkspace;
    const f = fixture({ workspace: () => new Promise(resolve => { finishWorkspace = resolve; }) });
    const pending = f.request("switch-race");
    await settle();
    f.context.activeChatId = "other";
    finishWorkspace({ exists: true });
    await pending;
    assert.equal(f.acknowledgements.at(-1).accepted, false);
    assert.equal(f.context.queuedAgentMessages.length, 0);
    assert.equal(f.apiRequests.length, 0);
});

test("active task accepts bounded queue additions while preserving drafts", async () => {
    const f = fixture();
    let finishResponse;
    f.context.fetchEndpointWithFallback = () => new Promise(resolve => { finishResponse = resolve; });
    await f.request("start");
    await settle();
    assert.equal(f.context.isAgentTaskRunning(), true);
    await f.request("queued", "后续任务");
    assert.equal(f.acknowledgements.at(-1).queued, true);
    assert.equal(f.context.queuedAgentMessages[0].content, "后续任务");
    assert.equal(f.context.queuedAgentMessages[0].gatewayChatId, "active");
    f.context.queuedAgentMessages.length = 20;
    await f.request("full");
    assert.equal(f.acknowledgements.at(-1).accepted, false);
    f.context.queuedAgentMessages.length = 0;
    finishResponse({ response: { ok: true, body: null, json: async () => ({}) }, endpoint: "/responses", requestBody: {} });
    await settle();
    assert.equal(f.elements.get("user-input").value, "LOCAL_DRAFT");
});

test("expired delivery after slow workspace IPC cannot reach the model or remain queued", async () => {
    let finishWorkspace;
    const f = fixture({ workspace: () => new Promise(resolve => { finishWorkspace = resolve; }) });
    const request = { requestId: "slow-workspace", text: "不要迟到投递", chatId: "active",
        device: { id: "device", role: "write" }, expiresAt: Date.now() + 4500 };
    const pending = f.events.message(request);
    await settle();
    request.expiresAt = 0;
    finishWorkspace({ exists: true });
    await pending;
    assert.equal(f.acknowledgements.at(-1).accepted, false);
    assert.match(f.acknowledgements.at(-1).error, /超时/);
    assert.equal(f.apiRequests.length, 0);
    assert.equal(f.context.queuedAgentMessages.length, 0);
    assert.equal(f.context.isGenerating, false);
    assert.equal(f.context.isAgentTaskRunning(), false);
});

test("workspace IPC rejection releases Agent reservation", async () => {
    const f = fixture({ workspace: async () => { throw new Error("IPC unavailable"); } });
    await f.request("failed-workspace");
    assert.equal(f.acknowledgements.at(-1).accepted, false);
    assert.equal(f.context.isGenerating, false);
    assert.equal(f.context.isAgentTaskRunning(), false);
    assert.equal(f.context.queuedAgentMessages.length, 0);
    assert.equal(f.apiRequests.length, 0);
});

test("remote additions left by an interrupted task never enter another active chat", async () => {
    const f = fixture();
    f.context.queuedAgentMessages.push({ content: "OLD_CHAT_REMOTE_TASK", gatewayChatId: "other" });
    f.intervals.at(-1)();
    assert.equal(f.snapshots.at(-1).queuedCount, 0);
    await f.context.requestAgentLoop("desktop-model", f.chat);
    assert.equal(f.context.queuedAgentMessages.length, 0);
    assert.doesNotMatch(JSON.stringify(f.apiRequests), /OLD_CHAT_REMOTE_TASK/);
    assert.ok(!f.chat.messages.some(message => message.content === "OLD_CHAT_REMOTE_TASK"));
});

test("desktop stop cancels remote queue entries before a subsequent chat can run", async () => {
    const f = fixture();
    f.context.queuedAgentMessages.push({ content: "REMOTE_TASK", gatewayChatId: "active" });
    f.context.stopAgentTask();
    assert.equal(f.context.queuedAgentMessages.length, 0);
    assert.ok(f.notifications.some(message => message.includes("待处理远程消息")));
    f.context.activeChatId = "other";
    await f.context.requestAgentLoop("desktop-model", f.context.chats[1]);
    assert.doesNotMatch(JSON.stringify(f.apiRequests), /REMOTE_TASK/);
    assert.ok(!f.context.chats[1].messages.some(message => message.content === "REMOTE_TASK"));
});

test("snapshot retains complete long replies, data text and all older tool calls without history caps", () => {
    const f = fixture();
    const reply = "完整正文。".repeat(12000) + "\n末尾确认内容\n示例 data:text/plain;base64,SGVsbG8=";
    for (let index = 0; index < 180; index += 1) {
        f.chat.messages.push({ role: "tool", toolName: `unknown_tool_${index}`, status: "done",
            arguments: { path: `src/file-${index}.js`, content: "SECRET_FILE_TEXT", apiKey: "SECRET_API_KEY" },
            result: { stdout: "SECRET_STDOUT" }, content: "SECRET_RESULT" });
        f.chat.messages.push({ role: "assistant", content: `段落 ${index}\n${reply}` });
    }
    f.intervals[0]();
    const snapshot = f.snapshots.at(-1);
    assert.equal(snapshot.messages.length, 360);
    assert.equal(snapshot.messages[0].toolName, "unknown_tool_0");
    assert.equal(snapshot.messages.at(-2).toolName, "unknown_tool_179");
    assert.equal(snapshot.messages[1].content, `段落 0\n${reply}`);
    assert.equal(snapshot.messages.at(-1).content, `段落 179\n${reply}`);
    assert.ok(snapshot.messages.at(-1).content.length > 16000);
    assert.doesNotMatch(JSON.stringify(snapshot), /SECRET_/);
});

test("thinking previews retain first and latest three nonempty lines and omit only the middle", () => {
    const f = fixture();
    const reasoning = ["首行一", "", "首行二", "首行三", "中间一", "中间二", "中间三", "尾行一", " ", "尾行二", "尾行三"].join("\n");
    f.chat.messages = [
        { role: "user", content: "思考任务" },
        { role: "assistant", hidden: true, agentThinking: false, content: "SECRET_PROTOCOL_JSON",
            reasoning, thinkingDurationMs: 4567, gatewayThinkingId: "stable-thinking-id" },
        { role: "assistant", content: "完整回答", reasoning },
        { role: "user", content: "新的任务" },
        { role: "assistant", content: "新的回答", reasoning: "独立可见消息的思考" }
    ];
    f.intervals[0]();
    const thinking = f.snapshots.at(-1).messages.filter(message => message.kind === "thinking");
    assert.equal(thinking.length, 2);
    assert.equal(thinking[0].id, "stable-thinking-id");
    assert.equal(thinking[0].content, "首行一\n首行二\n首行三\n…省略 3 行…\n尾行一\n尾行二\n尾行三");
    assert.equal(thinking[0].omittedLines, 3);
    assert.equal(thinking[0].durationMs, 4567);
    assert.equal(thinking[0].status, "done");
    assert.equal(thinking[1].content, "独立可见消息的思考");
    assert.doesNotMatch(JSON.stringify(f.snapshots.at(-1)), /SECRET_PROTOCOL/);
});

test("live reasoning preview refreshes its tail and becomes one persisted thinking entry with a stable id", async () => {
    const f = fixture();
    let finishResponse;
    f.context.fetchEndpointWithFallback = () => new Promise(resolve => { finishResponse = resolve; });
    await f.request("live-thinking-start");
    await settle();
    const row = f.createdNodes.find(element => typeof element.updateReasoning === "function");
    assert.ok(row);
    const initial = "开始一\n开始二\n开始三\n中间一\n中间二\n中间三\n初始尾一\n初始尾二\n初始尾三";
    row.updateReasoning(initial);
    f.intervals[0]();
    const first = f.snapshots.at(-1);
    assert.equal(first.status, "thinking");
    assert.equal(first.activity, "正在思考");
    const live = first.messages.find(message => message.kind === "thinking");
    assert.equal(live.status, "running");
    assert.match(live.content, /初始尾三$/);
    const updated = `${initial}\n最新尾一\n最新尾二\n最新尾三`;
    row.updateReasoning(updated);
    f.intervals[0]();
    const refreshed = f.snapshots.at(-1).messages.find(message => message.kind === "thinking");
    assert.equal(refreshed.id, live.id);
    assert.match(refreshed.content, /开始一\n开始二\n开始三/);
    assert.match(refreshed.content, /最新尾一\n最新尾二\n最新尾三$/);
    assert.doesNotMatch(refreshed.content, /初始尾/);
    assert.equal(refreshed.omittedLines, 6);
    f.context.extractStreamingUpdate = () => ({ reasoningSnapshot: updated });
    finishResponse({ response: { ok: true, body: null, json: async () => ({}) }, endpoint: "/responses", requestBody: {} });
    await settle();
    f.intervals[0]();
    const completed = f.snapshots.at(-1).messages.filter(message => message.kind === "thinking");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].id, live.id);
    assert.equal(completed[0].status, "done");
    assert.match(completed[0].content, /最新尾三$/);
    assert.equal(f.context.getGatewayAgentThinkingState(), null);
});

test("all tool kinds preserve identity and narrowly allowed useful details", () => {
    const f = fixture();
    const tools = [
        ["run_shell", { command: "npm test\nSECRET_SECOND_LINE", env: "SECRET_ENV" }, "npm test"],
        ["start_process", { command: "node server.js\nSECRET_SECOND_LINE" }, "node server.js"],
        ["read_file_range", { path: "src/main.js", start_line: 20 }, "src/main.js"],
        ["write_file", { path: "src/new.js", content: "SECRET_FILE" }, "src/new.js"],
        ["view_image", { path: "images/demo.png" }, "images/demo.png"],
        ["web_search", { query: "Node HTTP compatibility", api_key: "SECRET_KEY" }, "Node HTTP compatibility"],
        ["browse_web", { url: "https://example.com/docs" }, "https://example.com/docs"],
        ["update_plan", { plan: [{ step: "完成", status: "completed" }, { step: "实现网关", status: "in_progress" }] }, "2 个步骤 · 正在进行：实现网关"],
        ["move_path", { from: "a.txt", to: "b.txt" }, "a.txt → b.txt"],
        ["list_dir", { dir_path: "src" }, "src"],
        ["read_process_output", { process_id: "server-1" }, "server-1"],
        ["grep_files", { pattern: "gateway", path: "src" }, "gateway · src"],
        ["unknown_tool", { url: "https://example.com", secret: "SECRET_UNKNOWN" }, "https://example.com"],
        ["finish_task", {}, ""]
    ];
    f.chat.messages = tools.map(([toolName, args]) => ({ role: "tool", toolName, arguments: args, status: "done",
        content: "SECRET_TOOL_RESULT", result: { stdout: "SECRET_STDOUT" } }));
    f.intervals[0]();
    const projected = f.snapshots.at(-1).messages;
    assert.equal(projected.length, tools.length);
    for (let index = 0; index < tools.length; index += 1) {
        assert.equal(projected[index].toolName, tools[index][0]);
        assert.equal(projected[index].detail, tools[index][2]);
        assert.equal(projected[index].kind, "tool");
    }
    assert.doesNotMatch(JSON.stringify(projected), /SECRET_/);
});
