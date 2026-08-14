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

ipcMain.handle("app:get-update-log", async () => "## V7.0.0 Canary 6 · 2026-08-15\n\n- Smoke test");
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
ipcMain.handle("agent:execute-tool", async (_event, request) => {
    const args = request?.arguments || {};
    const startLine = Number(args.start_line) || 1;
    const endLine = Number(args.end_line) || startLine;
    return {
        success: true,
        path: String(args.path || "mock.txt"),
        requestedStartLine: startLine,
        requestedEndLine: endLine,
        actualStartLine: startLine,
        actualEndLine: endLine,
        returnedLines: Math.max(0, endLine - startLine + 1),
        totalLines: Math.max(endLine, 250),
        content: "mock file content"
    };
});

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
    if (prepare) {
        const prepareResult = await win.webContents.executeJavaScript(`(async () => {
            try {
                return { value: await (${prepare.toString()})() };
            } catch (error) {
                return { error: String(error && error.message || error), stack: String(error && error.stack || '') };
            }
        })()`);
        if (prepareResult?.error) throw new Error(`${fileName}: ${prepareResult.error}\n${prepareResult.stack}`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    const stateResult = await win.webContents.executeJavaScript(`(() => {
        try {
            return { state: ({
        hasProtocol: Boolean(window.AgentProtocol),
        hasAgentEntry: Boolean(document.getElementById('agent-entry-btn')),
        hasCommandMode: Boolean(document.getElementById('agent-command-mode-select')),
        hasAgentSettings: Boolean(document.getElementById('section-agent')),
        hasAgentDiffSetting: Boolean(document.getElementById('agent-diff-max-lines')),
        hasAgentDetailBehaviorSetting: Boolean(document.getElementById('agent-detail-default-behavior')),
        hasAgentTimeoutSetting: Boolean(document.getElementById('agent-shell-timeout-seconds')),
        hasLegacyApprovalPrefixInput: Boolean(document.getElementById('agent-command-approval-prefix')),
        attachMenuClass: document.getElementById('attach-menu')?.className || '',
        settingsModalClass: document.getElementById('settings-modal')?.className || '',
        agentSettingsClass: document.getElementById('section-agent')?.className || '',
        commandModeVisible: document.getElementById('agent-command-mode-bar')?.classList.contains('visible') || false,
        workspaceText: document.getElementById('active-chat-workspace')?.textContent || '',
        canvasDisplay: getComputedStyle(document.getElementById('canvas-toggle-btn')).display,
        inputTopRightRadius: getComputedStyle(document.querySelector('.input-area')).borderTopRightRadius,
        agentToolRows: document.querySelectorAll('.agent-tool-row-wrapper').length,
        agentSegmentRows: document.querySelectorAll('.agent-segment-row').length,
        agentPreviewLines: document.querySelectorAll('.agent-tool-preview-line').length,
        agentToolCollapsed: document.querySelector('.agent-tool-row.collapsed') !== null,
        agentToolIconSize: parseFloat(getComputedStyle(document.querySelector('.agent-tool-summary svg') || document.body).width),
        agentToolFontSize: parseFloat(getComputedStyle(document.querySelector('.agent-tool-summary') || document.body).fontSize),
        visibleHasToolJson: document.getElementById('messages-wrapper')?.innerText.includes('tool_call') || false,
        visibleHasJsonWrapper: (() => {
            const visibleText = (document.getElementById('messages-wrapper')?.innerText || '').toLowerCase();
            return visibleText.includes('<json>') || visibleText.includes('</json>');
        })(),
        finishInsideFinal: Boolean(document.querySelector('.agent-final-row .agent-tool-inline [data-lucide="check-circle-2"]')),
        finishBeforeFooter: (() => {
            const contentCol = document.querySelector('.agent-final-row .message-content-col');
            const finish = contentCol?.querySelector('.agent-tool-inline');
            const footer = contentCol?.querySelector('.message-footer');
            return Boolean(finish && footer && (finish.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING));
        })(),
        agentShowsMilliseconds: document.getElementById('messages-wrapper')?.innerText.includes('1234毫秒') || false,
        agentShowsChineseOutput: document.getElementById('messages-wrapper')?.innerText.includes('中文命令输出') || false,
        agentCompletedTaskTurns: (() => getCompleteConversationTurns({
            agentEnabled: true,
            contextCompaction: { version: 1, summaries: [] },
            messages: [
                { role: 'user', content: '任务一' },
                { role: 'assistant', content: '{"tool_call":{}}', hidden: true },
                { role: 'tool', content: '{}' },
                { role: 'assistant', content: '完成一', agentFinal: true },
                { role: 'user', content: '任务二' },
                { role: 'assistant', content: '{"tool_call":{}}', hidden: true },
                { role: 'tool', content: '{}' },
                { role: 'assistant', content: '完成二', agentFinal: true }
            ]
        }).length)(),
        agentMockApiCalls: window.__agentMockRequestBodies?.length || 0,
        agentMockStructuredInput: Array.isArray(window.__agentMockRequestBodies) && window.__agentMockRequestBodies.length > 0
            ? window.__agentMockRequestBodies.every(body => Array.isArray(body?.input) && body.input.every(message => message && typeof message.role === 'string'))
            : false,
        agentMockVisibleClean: (() => {
            if (!window.__agentMockFinished) return false;
            const visibleText = document.getElementById('messages-wrapper')?.innerText || '';
            const normalizedText = visibleText.toLowerCase();
            const hasForbiddenText = ['toolresult', 'tool result', 'dsml', 'tool_call'].some(fragment => normalizedText.includes(fragment));
            const hasForbiddenLine = visibleText.split(String.fromCharCode(10)).some(line => {
                const trimmed = line.trim().toLowerCase();
                return trimmed === 'user:' || trimmed === '<' || trimmed === '/>' || trimmed === '</>';
            });
            return !hasForbiddenText && !hasForbiddenLine;
        })(),
        agentMockHasFinalAnswer: window.__agentMockFinished
            ? (document.getElementById('messages-wrapper')?.innerText || '').includes('这是一个 Node.js + Express 局域网文件共享项目。')
            : false,
        agentMockHasInternalNarration: window.__agentMockFinished
            ? (document.getElementById('messages-wrapper')?.innerText || '').includes('现在用中文回答用户的问题')
            : false,
        agentMockReasoningRenderCount: window.__agentReasoningRenderCount || 0,
        agentMockHasThinkingStrong: Boolean(document.querySelector('.agent-final-row .ai-thinking-status .thinking-text strong')),
        agentMockThinkingWasLimited: (document.querySelector('.agent-final-row .thinking-text')?.innerText || '').includes('省略2行'),
        agentFallbackRequests: window.__agentFallbackRequests || [],
        agentSaw501Warning: window.__agentSaw501Warning === true,
        agentFallbackHasProtocolError: window.__agentFallbackHasProtocolError === true,
        bodyWidth: document.body.scrollWidth,
        viewportWidth: window.innerWidth
            }) };
        } catch (error) {
            return { error: String(error && error.message || error), stack: String(error && error.stack || '') };
        }
    })()`);
    if (stateResult?.error) throw new Error(`${fileName}: ${stateResult.error}\n${stateResult.stack}`);
    const state = stateResult.state;
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
                { role: "assistant", content: '先读取。\n{"tool_call":{"name":"read_file_range","arguments":{}}}', hidden: true, agentToolResponse: true },
                { role: "assistant", content: "<json>先读取文件。</json>\n\n\n", agentDisplayOnly: true, agentSegment: true },
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
                { role: "assistant", content: "然后修改文件。", agentDisplayOnly: true, agentSegment: true },
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
                },
                { role: "assistant", content: "运行测试。", agentDisplayOnly: true, agentSegment: true },
                {
                    role: "tool",
                    name: "run_shell",
                    toolName: "run_shell",
                    arguments: { command: "npm test" },
                    status: "done",
                    result: { success: true, stdout: "中文命令输出", stderr: "", exitCode: 0, durationMs: 1234, stdoutBytes: 18, stderrBytes: 0 },
                    content: "{}",
                    toolId: "smoke-shell",
                    executionId: "smoke-shell-execution"
                },
                { role: "assistant", content: '任务完成。\n<json>{"tool_call":{"name":"finish_task","arguments":{}}}</json>', agentDisplayOnly: true, agentFinal: true },
                {
                    role: "tool",
                    name: "finish_task",
                    toolName: "finish_task",
                    arguments: {},
                    status: "done",
                    result: { success: true },
                    content: "{}",
                    toolId: "smoke-finish"
                }
            ];
            updateAgentUIForChat(chat);
            renderMessages(chat.messages);
            document.querySelector('.agent-tool-summary.clickable')?.click();
        });
        const mixedProtocol = await captureWindow(1200, 800, "agent-mixed-protocol.png", async function () {
            localStorage.setItem("request_endpoint", "/responses");
            localStorage.setItem("agent_diff_max_lines", "10");
            localStorage.setItem("agent_detail_default_behavior", "expanded");
            const chat = chats.find(item => item.id === activeChatId);
            chat.agentEnabled = true;
            chat.agentWorkspace = "D:\\workspace\\demo";
            chat.agentEnvironment = "OS: Windows 11\nShell: PowerShell\nWorkspace: D:\\workspace\\demo\nNode: v24.0.0";
            chat.agentFixedPrompt = AgentProtocol.buildFixedAgentPrompt({ environment: chat.agentEnvironment });
            chat.messages = [{ role: "user", content: "帮我查看一下这个项目的结构" }];
            updateAgentUIForChat(chat);
            renderMessages(chat.messages);

            const mockResponses = [
                [
                    "</>",
                    "我来查看项目的主要文件来了解这个项目。",
                    "<",
                    '{"tool_call":{"name":"read_file_range","arguments":{"path":"package.json","start_line":1,"end_line":14}}}',
                    "/> <",
                    '{"tool_call":{"name":"read_file_range","arguments":{"path":"server.js","start_line":1,"end_line":119}}}',
                    "/> <",
                    '{"tool_call":{"name":"read_file_range","arguments":{"path":"start.bat","start_line":1,"end_line":24}}}',
                    "/> <",
                    "/>",
                    "让我再看一下前端页面，以便完整了解项目。",
                    "<",
                    '{"tool_call":{"name":"read_file_range","arguments":{"path":"views\\\\index.ejs","start_line":1,"end_line":120}}}',
                    "/>"
                ].join("\n"),
                [
                    "user:",
                    "",
                    "ToolResult:read_file_range",
                    '{"success":true,"path":"views/index.ejs","content":"mock content\\n</｜｜DSML｜｜>"}',
                    '<{"tool_call":{"name":"read_file_range","arguments":{"path":"views\\\\index.ejs","start_line":121,"end_line":240}}}/>'
                ].join("\n"),
                [
                    "user:",
                    "ToolResult:read_file_range",
                    '{"success":true,"path":"views/index.ejs","content":"more mock content\\n</｜｜DSML｜｜>"}',
                    '<{"tool_call":"read_file_range","arguments":{"path":"views\\\\index.ejs","start_line":176,"end_line":250}}/>'
                ].join("\n"),
                [
                    "user:",
                    "ToolResult:read_file_range",
                    '{"success":true,"path":"views/index.ejs","content":"final mock content\\n</｜｜DSML｜｜>"}',
                    "好的，我已经完整了解了这个项目。现在用中文回答用户的问题。",
                    '<{"tool_call":{"name":"finish_task","arguments":{}}}/>',
                    "这是一个 Node.js + Express 局域网文件共享项目。"
                ].join("\n")
            ];
            const requestBodies = [];
            let responseIndex = 0;
            const originalRenderThinkingText = renderThinkingText;
            window.__agentReasoningRenderCount = 0;
            window.renderThinkingText = function (element, text) {
                if (element?.closest('.agent-thinking-row')) window.__agentReasoningRenderCount += 1;
                return originalRenderThinkingText(element, text);
            };
            window.fetch = async (_url, options = {}) => {
                requestBodies.push(JSON.parse(options.body || "{}"));
                const responseText = mockResponses[responseIndex++] || mockResponses[mockResponses.length - 1];
                const encoder = new TextEncoder();
                const stream = new ReadableStream({
                    start(controller) {
                        const reasoningLines = ['**分析**', '第2行', '第3行', '第4行', '第5行', '第6行', '第7行', '第8行', '第9行', '第10行', '第11行', '第12行'];
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoningLines.slice(0, 6).join('\n') } }] })}\n\n`));
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: `\n${reasoningLines.slice(6).join('\n')}` } }] })}\n\n`));
                        const payload = JSON.stringify({ choices: [{ delta: { content: responseText } }] });
                        controller.enqueue(encoder.encode(`data: ${payload}\n\ndata: [DONE]\n\n`));
                        controller.close();
                    }
                });
                return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
            };
            await requestAgentLoop("deepseek-v4-flash", chat);
            window.__agentMockRequestBodies = requestBodies;
            window.__agentMockFinished = true;
        });
        const fallback = await captureWindow(1200, 800, "agent-501-fallback.png", async function () {
            localStorage.setItem("request_endpoint", "/responses");
            const chat = chats.find(item => item.id === activeChatId);
            chat.agentEnabled = true;
            chat.agentWorkspace = "D:\\workspace\\demo";
            chat.agentEnvironment = "OS: Windows 11\nShell: PowerShell\nWorkspace: D:\\workspace\\demo\nNode: v24.0.0";
            chat.agentFixedPrompt = AgentProtocol.buildFixedAgentPrompt({ environment: chat.agentEnvironment });
            chat.messages = [{ role: "user", content: "测试 501 转接" }];
            updateAgentUIForChat(chat);
            renderMessages(chat.messages);
            const requests = [];
            window.__agentSaw501Warning = false;
            const observer = new MutationObserver(() => {
                if (document.querySelector('.agent-tool-row.warning')?.textContent.includes('501')) window.__agentSaw501Warning = true;
            });
            observer.observe(document.getElementById('messages-wrapper'), { childList: true, subtree: true });
            window.fetch = async url => {
                requests.push(String(url));
                if (requests.length === 1) return new Response('501 Not Implemented', { status: 501 });
                const encoder = new TextEncoder();
                const stream = new ReadableStream({
                    start(controller) {
                        const text = '已通过备用接口完成。\n{"tool_call":{"name":"finish_task","arguments":{}}}';
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`));
                        controller.close();
                    }
                });
                return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
            };
            await requestAgentLoop("deepseek-v4-flash", chat);
            observer.disconnect();
            window.__agentFallbackRequests = requests;
            window.__agentFallbackHasProtocolError = chat.messages.some(message => message?.toolName === 'agent_protocol');
        });
        const result = { main, settings, active, mixedProtocol, fallback, consoleErrors };
        console.log(JSON.stringify(result, null, 2));
        if (!main.state.hasProtocol || !main.state.hasAgentEntry || !main.state.hasCommandMode || main.state.hasLegacyApprovalPrefixInput || !settings.state.hasAgentSettings || !settings.state.hasAgentDiffSetting || !settings.state.hasAgentDetailBehaviorSetting || !settings.state.hasAgentTimeoutSetting) {
            process.exitCode = 1;
        }
        if (main.state.bodyWidth > main.state.viewportWidth + 2 || settings.state.bodyWidth > settings.state.viewportWidth + 2) {
            process.exitCode = 1;
        }
        if (main.state.canvasDisplay !== "none" || main.state.inputTopRightRadius === "0px") {
            process.exitCode = 1;
        }
        if (!active.state.commandModeVisible || active.state.workspaceText !== "D:\\workspace\\demo" || active.state.canvasDisplay !== "none" || active.state.inputTopRightRadius !== "0px" || active.state.agentToolRows !== 4 || active.state.agentSegmentRows !== 3 || active.state.agentPreviewLines !== 12 || !active.state.agentToolCollapsed || active.state.visibleHasToolJson || active.state.visibleHasJsonWrapper || !active.state.finishInsideFinal || !active.state.finishBeforeFooter || !active.state.agentShowsMilliseconds || !active.state.agentShowsChineseOutput || active.state.agentCompletedTaskTurns !== 2 || Math.abs(active.state.agentToolIconSize - active.state.agentToolFontSize) > 1) {
            process.exitCode = 1;
        }
        if (mixedProtocol.state.agentMockApiCalls !== 4 || !mixedProtocol.state.agentMockStructuredInput || !mixedProtocol.state.agentMockVisibleClean || !mixedProtocol.state.agentMockHasFinalAnswer || mixedProtocol.state.agentMockHasInternalNarration || mixedProtocol.state.agentMockReasoningRenderCount < 8 || !mixedProtocol.state.agentMockHasThinkingStrong || !mixedProtocol.state.agentMockThinkingWasLimited || mixedProtocol.state.agentToolRows !== 7 || mixedProtocol.state.agentSegmentRows !== 2 || !mixedProtocol.state.finishInsideFinal || !mixedProtocol.state.finishBeforeFooter) {
            process.exitCode = 1;
        }
        if (fallback.state.agentFallbackRequests.length !== 2 || !fallback.state.agentFallbackRequests[0].endsWith('/responses') || !fallback.state.agentFallbackRequests[1].endsWith('/chat/completions') || !fallback.state.agentSaw501Warning || fallback.state.agentFallbackHasProtocolError) {
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
