"use strict";

// Real BrowserWindows and preloads exercise the complete HTTP -> main ->
// renderer -> existing Agent queue path. The model response alone is mocked.
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { registerAgentGateway } = require("../gateway-electron");

const root = path.resolve(__dirname, "..");
const testDirectory = path.join(os.tmpdir(), `aiui-gateway-electron-${process.pid}`);
app.setPath("userData", path.join(testDirectory, "user-data"));
app.disableHardwareAcceleration();
let mainWindow;
let rendererReady = false;
const errors = [];
const integration = registerAgentGateway({
    app, BrowserWindow, ipcMain,
    getMainWindow: () => mainWindow,
    isMainSender: event => event.sender === mainWindow?.webContents,
    isRendererReady: () => rendererReady,
    hasConversationWindow: () => false
});
ipcMain.on("renderer:ready", () => { rendererReady = true; });
ipcMain.handle("app:get-update-log", () => "## V8.1.0 Release · 2026-10-31\n\n- Agent 网关");
ipcMain.handle("agent:get-command-settings", () => ({ defaults: [], additions: [] }));
ipcMain.handle("agent:get-workspace", () => ({ bound: true, exists: true, path: testDirectory, environment: "Windows test workspace" }));
ipcMain.handle("agent:stop-all-processes", () => ({ success: true }));

const evaluate = (win, fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
async function until(fn, label, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const result = await fn();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${label}`);
}
async function freePort() {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    return port;
}
function observe(win) {
    win.webContents.on("console-message", (_event, level, message) => {
        if (level >= 3 && !/Content Security Policy|ERR_FILE_NOT_FOUND|font/i.test(message)) errors.push(message);
    });
    win.webContents.on("render-process-gone", (_event, details) => errors.push(`Renderer exited: ${details.reason}`));
    return win;
}
async function capture(win, name) {
    await evaluate(win, async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    win.webContents.invalidate();
    const background = await evaluate(win, () => getComputedStyle(document.body).backgroundColor);
    const expected = background.match(/\d+/g)?.slice(0, 3).map(Number);
    let image;
    await until(async () => {
        image = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        if (!win.webContents.isOffscreen() || !expected) return true;
        // A hidden renderer can return its previous composited surface directly
        // after a theme toggle. Check actual bitmap pixels rather than dataset.
        const bitmap = image.toBitmap();
        const offset = (2 * image.getSize().width + 2) * 4;
        const actual = [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]];
        return actual.every((value, index) => Math.abs(value - expected[index]) <= 2);
    }, `freshly painted ${name}`, 5000);
    const file = path.join(testDirectory, name);
    await fs.writeFile(file, image.toPNG());
    return file;
}

app.whenReady().then(async () => {
    let exitCode = 0;
    try {
        await fs.mkdir(testDirectory, { recursive: true });
        mainWindow = observe(new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { preload: path.join(root, "preload.js"), contextIsolation: true, nodeIntegration: false } }));
        integration.bindMainWindow(mainWindow);
        await mainWindow.loadFile(path.join(root, "index.html"));
        await until(() => rendererReady, "main renderer ready");
        assert.equal(await evaluate(mainWindow, () => !document.getElementById("agent-gateway-btn").hidden), true);
        await evaluate(mainWindow, () => {
            const chat = chats.find(item => item.id === activeChatId);
            chat.agentEnabled = true;
            chat.title = "这是一个用于检查手机单行省略效果的很长的 Agent 会话标题，包含完整任务名称与上下文";
            chat.agentWorkspace = "test-workspace";
            chat.agentEnvironment = "test-environment";
            chat.messages = [
                { role: "user", content: "请检查当前任务" },
                { role: "assistant", content: "正在准备检查。", agentDisplayOnly: true },
                { role: "assistant", content: "HIDDEN_PROTOCOL_SECRET", hidden: true, agentThinking: true, reasoning: "先确认运行环境\n梳理现有模块\n检查接口与页面\n仅中间分析一\n仅中间分析二\n决定验证顺序\n准备运行测试\n最后整理结果", thinkingDurationMs: 4200 },
                { role: "tool", name: "run_shell", toolName: "run_shell", status: "done", arguments: { command: "npm run test\nSECOND_COMMAND_SECRET", token: "PRIVATE_TOOL_ARGUMENT" }, content: "SECRET_OUTPUT" },
                { role: "tool", name: "custom_inspect", toolName: "custom_inspect", status: "done", arguments: { path: "src/demo.js" }, content: "SECRET_TOOL_RESULT" }
            ];
            renderMessages(chat.messages);
            updateAgentUIForChat(chat);
            document.getElementById("user-input").value = "LOCAL_DRAFT";
            currentAttachments = [{ name: "LOCAL_ATTACHMENT", isText: true, data: "PRIVATE_ATTACHMENT" }];
            localStorage.setItem("api_key", "PRIVATE_API_KEY");
            localStorage.setItem("request_endpoint", "/chat/completions");
            window.__gatewayModelBodies = [];
            window.fetch = async (_url, options) => {
                window.__gatewayModelBodies.push(JSON.parse(options.body));
                const index = window.__gatewayModelBodies.length;
                return new Response(new ReadableStream({ start(controller) {
                    const encoder = new TextEncoder();
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "先验证请求格式\n核对当前会话\n分析运行条件\n实时中间步骤一\n实时中间步骤二\n准备处理消息\n正在运行验证\n实时思考末行" } }] })}\n\n`));
                    const finish = () => {
                        const text = `桌面模型回复 ${index}。\n{"tool_call":{"name":"finish_task","arguments":{}}}`;
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`));
                        controller.close();
                    };
                    if (index === 1) window.__finishGatewayModel = finish;
                    else finish();
                } }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
            };
        });
        await evaluate(mainWindow, () => window.electronAPI.openAgentGateway());
        const consoleWindow = await until(() => BrowserWindow.getAllWindows().find(win => win !== mainWindow), "independent console");
        observe(consoleWindow);
        assert.equal(consoleWindow.getParentWindow(), null);
        assert.equal(await evaluate(consoleWindow, () => typeof window.electronAPI), "undefined");
        assert.equal(await evaluate(mainWindow, () => typeof window.gatewayConsoleAPI), "undefined");
        const port = await freePort();
        await evaluate(consoleWindow, async port => {
            await gatewayConsoleAPI.configure({ host: "127.0.0.1", port, allowWrite: true, pollIntervalMs: 1000 });
            await gatewayConsoleAPI.start();
        }, port);
        const status = await evaluate(consoleWindow, () => gatewayConsoleAPI.getStatus());
        assert.equal(status.running, true);
        await until(async () => (await evaluate(consoleWindow, () => gatewayConsoleAPI.getStatus())).snapshot.agentEnabled, "snapshot projection");

        // A window that has the management preload still cannot impersonate the console.
        const intruder = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, "gateway-preload.js"), contextIsolation: true, sandbox: true } });
        await intruder.loadURL("data:text/html,<title>Untrusted</title>");
        assert.equal(await evaluate(intruder, async () => { try { await gatewayConsoleAPI.getStatus(); return false; } catch { return true; } }), true);
        intruder.destroy();

        const mobile = observe(new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { partition: "gateway-test-remote", contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } }));
        // Deliver an old anonymous session response after login has completed.
        let releaseInitialSession;
        mobile.webContents.session.webRequest.onHeadersReceived({ urls: [`http://127.0.0.1:${port}/api/session`] }, (details, callback) => {
            if (!releaseInitialSession) releaseInitialSession = () => callback({ responseHeaders: details.responseHeaders });
            else callback({ responseHeaders: details.responseHeaders });
        });
        await mobile.loadURL(`http://127.0.0.1:${port}`);
        await until(() => releaseInitialSession, "delayed initial anonymous session");
        await until(() => evaluate(mobile, () => !document.getElementById("login-button").disabled), "login page");
        const loginImage = await capture(mobile, "remote-login-mobile.png");
        await evaluate(mobile, code => {
            document.getElementById("device-name").value = "测试手机";
            document.getElementById("access-code").value = code;
            document.getElementById("login-form").requestSubmit();
        }, status.credentials.writeCode);
        await until(() => evaluate(mobile, () => document.getElementById("messages").textContent.includes("正在准备检查")), "remote snapshot");
        releaseInitialSession();
        mobile.webContents.session.webRequest.onHeadersReceived(null);
        await evaluate(mobile, () => new Promise(resolve => setTimeout(resolve, 150)));
        assert.equal(await evaluate(mobile, () => document.getElementById("login-view").hidden), true, "stale anonymous session must not undo successful login");
        assert.equal(await evaluate(consoleWindow, () => {
            document.getElementById("allow-write").click();
            return [...document.querySelectorAll('#allow-write, #rotate-codes, #advanced-form input, #advanced-form button, .device-role, .device-actions button')].every(control => control.disabled);
        }), true, "permissions cannot silently change during an unfinished console operation");
        await until(() => evaluate(consoleWindow, () => !document.getElementById("allow-write").disabled && !document.getElementById("allow-write").checked), "write switch saved");
        await evaluate(consoleWindow, () => document.getElementById("allow-write").click());
        await until(() => evaluate(consoleWindow, () => !document.getElementById("allow-write").disabled && document.getElementById("allow-write").checked), "write switch restored");
        const remoteText = await evaluate(mobile, () => document.body.innerText);
        for (const secret of ["SECOND_COMMAND_SECRET", "SECRET_OUTPUT", "SECRET_TOOL_RESULT", "PRIVATE_TOOL_ARGUMENT", "HIDDEN_PROTOCOL_SECRET", "PRIVATE_API_KEY", "PRIVATE_ATTACHMENT"]) assert(!remoteText.includes(secret), secret);
        assert(remoteText.includes("运行指令"));
        const allProjectedText = await evaluate(mobile, () => document.getElementById("messages").textContent);
        for (const visible of ["npm run test", "run_shell", "custom_inspect", "先确认运行环境", "最后整理结果"]) assert(allProjectedText.includes(visible), visible);
        for (const omitted of ["仅中间分析一", "仅中间分析二"]) assert(!allProjectedText.includes(omitted), omitted);
        const compactLayout = await evaluate(mobile, () => {
            const title = document.getElementById("session-title");
            const activity = document.getElementById("activity-detail").closest(".activity-bar");
            return { titleEllipsis: getComputedStyle(title).textOverflow === "ellipsis" && getComputedStyle(title).whiteSpace === "nowrap",
                titleOneLine: title.getBoundingClientRect().height < 40, statusHeight: activity?.getBoundingClientRect().height || 0,
                noComposerFooter: !document.querySelector(".composer-meta, .workspace-footer") };
        });
        assert.equal(compactLayout.titleEllipsis, true);
        assert.equal(compactLayout.titleOneLine, true);
        assert(compactLayout.statusHeight <= 40);
        assert.equal(compactLayout.noComposerFooter, true);
        assert.equal(await evaluate(mobile, () => typeof window.electronAPI), "undefined");
        assert.equal(await evaluate(mobile, () => document.body.scrollWidth <= window.innerWidth), true);
        const syncStartedAt = Date.now();
        await evaluate(mainWindow, () => { chats.find(chat => chat.id === activeChatId).messages.push({ role: "assistant", content: "状态同步验证", agentDisplayOnly: true }); });
        await until(() => evaluate(mobile, () => document.getElementById("messages").textContent.includes("状态同步验证")), "polling latency", 3000);
        const measuredLatencyMs = Date.now() - syncStartedAt;
        assert(measuredLatencyMs < 3000);
        await evaluate(mainWindow, () => {
            const chat = chats.find(item => item.id === activeChatId);
            const longText = "完整正文保留验证。".repeat(3000);
            window.__gatewayFullReply = `## 完整回复\n\n**重点内容**与[项目说明](https://example.com/docs)。\n\n> 这是引用。\n\n- 项目一\n- 项目二\n\n\`\`\`javascript\nconst message = '<safe>';\n\`\`\`\n\n| 项目 | 状态 |\n| --- | --- |\n| 网关 | 完成 |\n\n${longText}\n\n正文最后一个标记 FULL_REPLY_END\n\n<img src="https://invalid.example/tracking.png" onerror="window.__markdownExecuted=true"><script>window.__markdownExecuted=true</script>[危险链接](javascript:alert(1))`;
            chat.messages.push({ role: "assistant", content: window.__gatewayFullReply, agentDisplayOnly: true });
        });
        await until(() => evaluate(mobile, () => document.getElementById("messages").textContent.includes("FULL_REPLY_END")), "complete long Markdown reply");
        const markdown = await evaluate(mobile, () => ({
            headings: document.querySelectorAll("#messages h2").length,
            strong: document.querySelectorAll("#messages strong").length,
            code: document.querySelector("#messages pre code")?.textContent,
            table: Boolean(document.querySelector("#messages table")),
            quote: Boolean(document.querySelector("#messages blockquote")),
            dangerous: Boolean(document.querySelector('#messages script,#messages img,#messages [onerror],#messages a[href^="javascript:"]')) || Boolean(window.__markdownExecuted),
            linkSafe: [...document.querySelectorAll("#messages a[href]")].every(link => link.rel.includes("noopener") && link.rel.includes("noreferrer")),
            fullReplyOccurrences: document.getElementById("messages").textContent.split("完整正文保留验证。").length - 1,
            noOverflow: document.body.scrollWidth <= window.innerWidth
        }));
        assert(markdown.headings > 0 && markdown.strong > 0 && markdown.table && markdown.quote);
        assert(markdown.code.includes("<safe>"));
        assert.equal(markdown.dangerous, false);
        assert.equal(markdown.linkSafe, true);
        assert.equal(markdown.fullReplyOccurrences, 3000);
        assert.equal(markdown.noOverflow, true);

        await evaluate(mobile, () => {
            const input = document.getElementById("message-input"); input.value = "/compact 只作为任务消息"; input.dispatchEvent(new Event("input"));
            document.getElementById("message-form").requestSubmit();
        });
        await until(() => evaluate(mainWindow, () => window.__gatewayModelBodies.length === 1), "remote task reaches desktop model");
        await until(() => evaluate(mobile, () => document.getElementById("messages").textContent.includes("实时思考末行")), "live reasoning preview");
        assert.equal(await evaluate(mobile, () => document.getElementById("messages").textContent.includes("实时中间步骤一")), false);
        await until(() => evaluate(mobile, () => document.getElementById("send-result").textContent.includes("已发送")), "message acknowledgement");
        await evaluate(mobile, () => {
            const input = document.getElementById("message-input"); input.value = "运行中追加消息"; input.dispatchEvent(new Event("input"));
            document.getElementById("message-form").requestSubmit();
        });
        await until(() => evaluate(mainWindow, () => window.queuedAgentMessages.length === 1), "remote followup queued");
        await evaluate(mainWindow, () => window.__finishGatewayModel());
        await until(() => evaluate(mainWindow, () => window.__gatewayModelBodies.length === 2 && !window.isAgentTaskRunning()), "queue processed by desktop");
        const desktop = await evaluate(mainWindow, () => ({ draft: document.getElementById("user-input").value, attachment: currentAttachments[0]?.name, messages: chats.find(chat => chat.id === activeChatId).messages.filter(message => message.role === "user").map(message => message.content) }));
        assert.equal(desktop.draft, "LOCAL_DRAFT");
        assert.equal(desktop.attachment, "LOCAL_ATTACHMENT");
        assert.equal(desktop.messages.filter(text => text === "/compact 只作为任务消息").length, 1);
        assert.equal(desktop.messages.filter(text => text === "运行中追加消息").length, 1);
        await until(() => evaluate(mobile, () => document.getElementById("messages").textContent.includes("桌面模型回复 2")), "model reply reflected remotely");
        // Keep visual QA separate from the long-response regression fixture, so
        // both themes show readable, representative content in the same viewport.
        await evaluate(mainWindow, () => {
            const chat = chats.find(item => item.id === activeChatId);
            chat.messages = [
                { role: "user", content: "请检查网关，并告诉我当前进度。" },
                { role: "assistant", content: "", hidden: true, agentThinking: true, reasoning: "先检查当前会话\n确认远程访问权限\n验证网关运行状态", thinkingDurationMs: 3200 },
                { role: "tool", name: "run_shell", toolName: "run_shell", status: "done", arguments: { command: "npm run test" }, content: "PRIVATE_TEST_OUTPUT" },
                { role: "assistant", content: "## 网关运行正常\n\n已完成 **连接验证**，消息只会发往电脑端当前会话。\n\n- 浏览器可以查看任务进度\n- 可写设备能够追加消息\n\n> 操作权限仍由电脑端控制。\n\n```js\nconst connected = true;\n```", agentDisplayOnly: true }
            ];
        });
        await until(() => evaluate(mobile, () => document.getElementById("messages").textContent.includes("网关运行正常") && !document.getElementById("messages").textContent.includes("FULL_REPLY_END")), "representative screenshot transcript");
        await evaluate(mobile, () => { document.getElementById("send-result").hidden = true; document.getElementById("messages").scrollTop = 0; });
        await evaluate(mobile, () => document.documentElement.dataset.theme !== "light" && document.querySelector('#workspace-view .theme-toggle').click());
        const lightImage = await capture(mobile, "remote-workspace-light.png");
        const lightBackground = await evaluate(mobile, () => getComputedStyle(document.body).backgroundColor);
        await evaluate(mobile, () => document.querySelector('#workspace-view .theme-toggle').click());
        assert.equal(await evaluate(mobile, () => document.documentElement.dataset.theme), "dark");
        assert.notEqual(await evaluate(mobile, () => getComputedStyle(document.body).backgroundColor), lightBackground);
        const workspaceImage = await capture(mobile, "remote-workspace-dark.png");
        await mobile.reload();
        await until(() => evaluate(mobile, () => !document.getElementById("workspace-view").hidden), "authenticated reload");
        assert.equal(await evaluate(mobile, () => document.documentElement.dataset.theme), "dark");
        const deviceId = (await evaluate(consoleWindow, () => gatewayConsoleAPI.getStatus())).devices[0].id;
        await evaluate(consoleWindow, id => gatewayConsoleAPI.setDeviceRole(id, "read"), deviceId);
        await until(() => evaluate(mobile, () => document.getElementById("message-form").hidden), "role downgrade enforced");
        await evaluate(mainWindow, () => { createNewChat(); });
        await until(() => evaluate(mobile, () => !document.querySelector("#messages .message") && Boolean(document.querySelector("#messages .conversation-empty")) && document.getElementById("session-title").textContent.includes("等待")), "active non-Agent clears transcript");
        await evaluate(consoleWindow, () => document.querySelector(".device-actions button").click());
        await until(() => evaluate(consoleWindow, () => document.getElementById("device-list").textContent.includes("解除阻止")), "console immediately reflects kicked device");
        await until(() => evaluate(mobile, () => !document.getElementById("login-view").hidden), "device kicked");
        await evaluate(mobile, code => {
            document.getElementById("access-code").value = code;
            document.getElementById("login-form").requestSubmit();
        }, status.credentials.writeCode);
        await until(() => evaluate(mobile, () => document.getElementById("login-error").textContent.includes("强制下线")), "blocked device cannot reconnect");
        const consoleImage = await capture(consoleWindow, "gateway-console.png");
        await evaluate(consoleWindow, () => gatewayConsoleAPI.stop());
        assert.equal((await evaluate(consoleWindow, () => gatewayConsoleAPI.getStatus())).running, false);
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ passed: true, measuredLatencyMs, markdown, compactLayout, desktopMessages: desktop.messages, screenshots: [loginImage, lightImage, workspaceImage, consoleImage] }, null, 2));
    } catch (error) {
        exitCode = 1;
        console.error(error.stack || error);
        console.error(JSON.stringify({ errors, artifacts: testDirectory }));
    } finally {
        integration.dispose();
        for (const win of BrowserWindow.getAllWindows()) win.destroy();
        app.exit(exitCode);
    }
});
