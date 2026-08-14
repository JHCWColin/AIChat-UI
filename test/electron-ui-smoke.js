const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const http = require("http");

const projectRoot = path.resolve(__dirname, "..");
const outputRoot = path.join(os.tmpdir(), "aiui-agent-ui-smoke");
const consoleErrors = [];
const liveWindows = new Set();
let server = null;
let baseUrl = "";

ipcMain.handle("app:get-update-log", async () => "## V7.0.0 Canary 1 · 2026-08-14\n\n- Smoke test");
ipcMain.handle("agent:get-command-settings", async () => ({
    defaults: ["git status", "npm run test"],
    additions: ["git push"]
}));
ipcMain.handle("agent:get-workspace", async () => ({
    bound: true,
    exists: true,
    path: "D:\\workspace\\demo",
    environment: "OS: Windows 11\nShell: PowerShell\nWorkspace: D:\\workspace\\demo\nNode: v24.0.0"
}));

async function captureWindow(width, height, fileName, prepare) {
    const win = new BrowserWindow({
        width,
        height,
        x: 0,
        y: 0,
        show: true,
        opacity: 0,
        webPreferences: {
            preload: path.join(projectRoot, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false
        }
    });
    liveWindows.add(win);
    win.on("closed", () => liveWindows.delete(win));
    win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        consoleErrors.push(`did-fail-load ${errorCode} ${errorDescription} ${validatedURL} main=${isMainFrame}`);
    });
    await win.loadURL(`${baseUrl}/index.html`);
    await new Promise(resolve => setTimeout(resolve, 1600));
    if (prepare) await win.webContents.executeJavaScript(`(${prepare.toString()})()`);
    await new Promise(resolve => setTimeout(resolve, 250));
    const state = await win.webContents.executeJavaScript(`({
        hasProtocol: Boolean(window.AgentProtocol),
        hasAgentEntry: Boolean(document.getElementById('agent-entry-btn')),
        hasCommandMode: Boolean(document.getElementById('agent-command-mode-select')),
        hasAgentSettings: Boolean(document.getElementById('section-agent')),
        hasAgentDiffSetting: Boolean(document.getElementById('agent-diff-max-lines')),
        hasAgentTimeoutSetting: Boolean(document.getElementById('agent-shell-timeout-seconds')),
        attachMenuClass: document.getElementById('attach-menu')?.className || '',
        settingsModalClass: document.getElementById('settings-modal')?.className || '',
        agentSettingsClass: document.getElementById('section-agent')?.className || '',
        commandModeVisible: document.getElementById('agent-command-mode-bar')?.classList.contains('visible') || false,
        workspaceText: document.getElementById('active-chat-workspace')?.textContent || '',
        canvasDisplay: getComputedStyle(document.getElementById('canvas-toggle-btn')).display,
        agentToolRows: document.querySelectorAll('.agent-tool-row-wrapper').length,
        agentPreviewLines: document.querySelectorAll('.agent-tool-preview-line').length,
        agentToolCollapsed: document.querySelector('.agent-tool-row.collapsed') !== null,
        bodyWidth: document.body.scrollWidth,
        viewportWidth: window.innerWidth
    })`);
    const image = await win.webContents.capturePage();
    const outputPath = path.join(outputRoot, fileName);
    await fs.writeFile(outputPath, image.toPNG());
    return { outputPath, state };
}

app.whenReady().then(async () => {
    try {
        await fs.mkdir(outputRoot, { recursive: true });
        server = http.createServer(async (request, response) => {
            try {
                const requestPath = decodeURIComponent(String(request.url || "/").split("?")[0]);
                const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
                const targetPath = path.resolve(projectRoot, relativePath);
                if (!targetPath.startsWith(projectRoot)) {
                    response.writeHead(403).end("Forbidden");
                    return;
                }
                const extension = path.extname(targetPath).toLowerCase();
                const types = {
                    ".html": "text/html; charset=utf-8",
                    ".js": "text/javascript; charset=utf-8",
                    ".css": "text/css; charset=utf-8",
                    ".png": "image/png",
                    ".jpg": "image/jpeg",
                    ".jpeg": "image/jpeg",
                    ".ico": "image/x-icon",
                    ".md": "text/plain; charset=utf-8"
                };
                response.writeHead(200, { "Content-Type": types[extension] || "application/octet-stream" });
                response.end(await fs.readFile(targetPath));
            } catch {
                response.writeHead(404).end("Not found");
            }
        });
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        const main = await captureWindow(1200, 800, "agent-main.png", function () {
            toggleAttachMenu({ stopPropagation() {} });
        });
        const settings = await captureWindow(390, 844, "agent-settings-mobile.png", function () {
            toggleSettings();
            const button = document.querySelector('[data-section="agent"]');
            switchSettingsSection("agent", button);
        });
        const active = await captureWindow(1200, 800, "agent-active.png", function () {
            localStorage.setItem("agent_diff_max_lines", "10");
            const chat = chats.find(item => item.id === activeChatId);
            chat.agentEnabled = true;
            chat.agentWorkspace = "D:\\workspace\\demo";
            chat.agentEnvironment = "OS: Windows 11\nShell: PowerShell\nWorkspace: D:\\workspace\\demo\nNode: v24.0.0";
            chat.agentFixedPrompt = AgentProtocol.buildFixedAgentPrompt({ environment: chat.agentEnvironment });
            chat.messages = [
                { role: "user", content: "检查 package.json" },
                {
                    role: "tool",
                    name: "read_file_range",
                    toolName: "read_file_range",
                    arguments: { path: "package.json", start_line: 1, end_line: 100 },
                    status: "done",
                    result: { success: true, path: "package.json", actualStartLine: 1, actualEndLine: 74, returnedLines: 74 },
                    content: "{}",
                    toolId: "smoke-tool"
                },
                {
                    role: "tool",
                    name: "edit_file",
                    toolName: "edit_file",
                    arguments: { path: "package.json", old_text: "old", new_text: "new" },
                    status: "done",
                    result: { success: true, path: "package.json", occurrences: 1 },
                    displayDiff: {
                        lines: Array.from({ length: 12 }, (_, index) => ({
                            type: index % 2 ? "add" : "delete",
                            text: `line-${index + 1}`
                        }))
                    },
                    content: "{}",
                    toolId: "smoke-edit"
                }
            ];
            updateAgentUIForChat(chat);
            renderMessages(chat.messages);
            document.querySelector('.agent-tool-summary.clickable')?.click();
        });
        const result = { main, settings, active, consoleErrors };
        console.log(JSON.stringify(result, null, 2));
        if (!main.state.hasProtocol || !main.state.hasAgentEntry || !main.state.hasCommandMode || !settings.state.hasAgentSettings || !settings.state.hasAgentDiffSetting || !settings.state.hasAgentTimeoutSetting) {
            process.exitCode = 1;
        }
        if (main.state.bodyWidth > main.state.viewportWidth + 2 || settings.state.bodyWidth > settings.state.viewportWidth + 2) {
            process.exitCode = 1;
        }
        if (!active.state.commandModeVisible || active.state.workspaceText !== "D:\\workspace\\demo" || active.state.canvasDisplay !== "none" || active.state.agentToolRows !== 2 || active.state.agentPreviewLines !== 11 || !active.state.agentToolCollapsed) {
            process.exitCode = 1;
        }
    } catch (error) {
        console.error(error);
        console.error(consoleErrors);
        process.exitCode = 1;
    } finally {
        for (const win of liveWindows) {
            if (!win.isDestroyed()) win.destroy();
        }
        if (server) await new Promise(resolve => server.close(resolve));
        app.exit(process.exitCode || 0);
    }
});
