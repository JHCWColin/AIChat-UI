"use strict";

const path = require("path");
const { pathToFileURL } = require("url");
const { AgentGateway } = require("./agent-gateway");

// This adapter is the only bridge between the HTTP service and Electron. The
// service never receives an Electron object, model credential, or tool runner.
function registerAgentGateway({ app, BrowserWindow, ipcMain, getMainWindow, isMainSender, isRendererReady, hasConversationWindow }) {
    let gateway = null;
    let initialization = null;
    let consoleWindow = null;
    let lastSnapshot = unavailableSnapshot();
    let lastPublishedAt = 0;
    let statusTimer = null;
    let disposed = false;
    const pending = new Map();
    const consoleUrl = pathToFileURL(path.join(__dirname, "gateway-console.html")).href;

    function unavailableSnapshot() {
        return { chatId: null, title: "", agentEnabled: false, running: false, status: "offline", activity: "桌面会话暂不可用", messages: [], queuedCount: 0, updatedAt: Date.now() };
    }

    function isTopFrame(event) {
        return Boolean(event.senderFrame && event.senderFrame === event.sender.mainFrame);
    }

    function requireMain(event) {
        if (!isMainSender(event) || !isTopFrame(event)) throw new Error("非法的 Agent 网关请求");
    }

    function requireConsole(event) {
        if (!consoleWindow || consoleWindow.isDestroyed() || event.sender !== consoleWindow.webContents || !isTopFrame(event) || event.senderFrame.url !== consoleUrl) {
            throw new Error("此操作只能在本机 Agent 网关控制台执行");
        }
    }

    function publishConsoleStatus() {
        if (statusTimer) return;
        statusTimer = setTimeout(() => {
            statusTimer = null;
            if (gateway && consoleWindow && !consoleWindow.isDestroyed()) {
                consoleWindow.webContents.send("agent-gateway:status", gateway.getStatus());
            }
        }, 250);
        statusTimer.unref?.();
    }

    function forwardMessage(message) {
        const win = getMainWindow();
        if (!win || win.isDestroyed() || !isRendererReady() || Date.now() - lastPublishedAt > 5000) {
            throw new Error("桌面会话暂不可用，请稍后重试");
        }
        if (hasConversationWindow()) throw new Error("桌面正在进行语音或桌面协作，暂不可追加消息");
        if (!lastSnapshot.agentEnabled || String(lastSnapshot.chatId) !== String(message.chatId)) {
            throw new Error("当前活动会话已改变，请刷新后重试");
        }
        const requestId = `${message.device.id}:${message.requestId}`;
        if (pending.has(requestId)) return pending.get(requestId).promise;
        let resolveRequest;
        const promise = new Promise(resolve => { resolveRequest = resolve; });
        const timer = setTimeout(() => {
            pending.delete(requestId);
            resolveRequest({ accepted: false, error: "桌面响应超时，请检查桌面会话状态" });
        }, 5000);
        timer.unref?.();
        pending.set(requestId, { promise, resolve: resolveRequest, timer });
        win.webContents.send("agent-gateway:message", { ...message, requestId, expiresAt: Date.now() + 4500 });
        return promise;
    }

    async function getGateway() {
        if (!initialization) {
            initialization = (async () => {
                await app.whenReady();
                const service = new AgentGateway({
                    settingsPath: path.join(app.getPath("userData"), "agent-gateway.json"),
                    assetsDir: path.join(__dirname, "remote-control"),
                    onMessage: forwardMessage
                });
                await service.initialize();
                if (disposed) throw new Error("应用正在退出");
                gateway = service;
                service.updateSnapshot(lastSnapshot);
                service.on("status", publishConsoleStatus);
                return service;
            })().catch(error => {
                initialization = null;
                throw error;
            });
        }
        return initialization;
    }

    async function openConsole() {
        await getGateway();
        if (consoleWindow && !consoleWindow.isDestroyed()) {
            if (consoleWindow.isMinimized()) consoleWindow.restore();
            consoleWindow.show();
            consoleWindow.focus();
            return { opened: true };
        }
        consoleWindow = new BrowserWindow({
            title: "Agent 网关 · AIUI",
            width: 1120, height: 850, minWidth: 760, minHeight: 620,
            backgroundColor: "#161819", autoHideMenuBar: true,
            icon: path.join(__dirname, "favicon.ico"),
            webPreferences: {
                preload: path.join(__dirname, "gateway-preload.js"),
                nodeIntegration: false, contextIsolation: true, sandbox: true,
                webSecurity: true, partition: "agent-gateway-console"
            }
        });
        const win = consoleWindow;
        win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        win.webContents.on("will-navigate", event => event.preventDefault());
        win.webContents.on("will-redirect", event => event.preventDefault());
        win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        win.on("closed", () => { if (consoleWindow === win) consoleWindow = null; });
        await win.loadFile(path.join(__dirname, "gateway-console.html"));
        return { opened: true };
    }

    ipcMain.handle("agent-gateway:open", event => { requireMain(event); return openConsole(); });
    const actions = {
        "get-status": service => service.getStatus(),
        configure: (service, patch) => service.configure(patch),
        start: service => service.start(),
        stop: service => service.stop(),
        "kick-device": (service, id) => service.kickDevice(id),
        "set-device-role": (service, id, role) => service.setDeviceRole(id, role),
        "unblock-device": (service, id) => service.unblockDevice(id),
        "rotate-credentials": service => service.rotateCredentials()
    };
    for (const [action, handler] of Object.entries(actions)) {
        ipcMain.handle(`agent-gateway:${action}`, async (event, ...args) => {
            requireConsole(event);
            const service = await getGateway();
            await handler(service, ...args);
            return service.getStatus();
        });
    }
    ipcMain.on("agent-gateway:snapshot", (event, snapshot) => {
        try { requireMain(event); } catch { return; }
        if (!snapshot || typeof snapshot !== "object") return;
        lastPublishedAt = Date.now();
        lastSnapshot = snapshot;
        gateway?.updateSnapshot(snapshot);
    });
    ipcMain.on("agent-gateway:message-result", (event, requestId, result) => {
        try { requireMain(event); } catch { return; }
        const request = pending.get(requestId);
        if (!request) return;
        pending.delete(requestId);
        clearTimeout(request.timer);
        request.resolve(result?.accepted === true
            ? { accepted: true, queued: result.queued === true }
            : { accepted: false, error: String(result?.error || "桌面拒绝了此消息").slice(0, 300) });
    });

    function invalidateRenderer() {
        lastPublishedAt = 0;
        lastSnapshot = unavailableSnapshot();
        gateway?.updateSnapshot(lastSnapshot);
        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.resolve({ accepted: false, error: "桌面会话已断开" });
        }
        pending.clear();
    }

    const heartbeat = setInterval(() => {
        if (lastPublishedAt && Date.now() - lastPublishedAt > 5000) invalidateRenderer();
    }, 1000);
    heartbeat.unref?.();

    return {
        openConsole,
        bindMainWindow(win) {
            // Hidden/minimized desktop windows still own the Agent and must keep
            // publishing within the polling latency budget.
            win.webContents.setBackgroundThrottling(false);
            win.webContents.on("did-start-loading", invalidateRenderer);
            win.webContents.on("render-process-gone", invalidateRenderer);
            win.on("closed", invalidateRenderer);
        },
        dispose() {
            disposed = true;
            clearInterval(heartbeat);
            invalidateRenderer();
            clearTimeout(statusTimer);
            gateway?.stop().catch(error => console.warn(`[AgentGateway] ${error.message}`));
        }
    };
}

module.exports = { registerAgentGateway };
