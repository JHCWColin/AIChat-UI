"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, dialog } = require("electron");

const profile = path.join(os.tmpdir(), `aiui-agent-streaming-${process.pid}`);
const screenshots = process.env.AIUI_STREAMING_SCREENSHOTS || path.join(profile, "screenshots");
app.setPath("userData", profile);
app.commandLine.appendSwitch("disable-gpu");
require("../main/main");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (win, script) => win.webContents.executeJavaScript(script, true);
async function until(check, label) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const value = await check();
        if (value) return value;
        await sleep(40);
    }
    throw new Error(`Timed out: ${label}`);
}

const requestLog = [];
const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    if (req.url !== "/v1/responses") { res.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const entry = { body, res, cancelled: false };
    res.on("close", () => { entry.cancelled = !res.writableEnded; });
    requestLog.push(entry);
    if (requestLog.length === 2) {
        res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Model unavailable" } }));
    } else {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        res.flushHeaders();
    }
});

const request = count => until(() => requestLog[count - 1], `model request ${count}`);
const event = (entry, data) => entry.res.write(`data: ${JSON.stringify(data)}\n\n`);
const delta = (entry, text) => event(entry, { type: "response.output_text.delta", delta: text });
const message = text => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const tool = (name, args = {}) => JSON.stringify({ tool_call: { name, arguments: args } });
function finish(entry, output = []) {
    event(entry, { type: "response.completed", response: { status: "completed", output } });
    entry.res.end("data: [DONE]\n\n");
}

async function send(win, content) {
    await evaluate(win, `(() => {
        const input = document.getElementById('user-input');
        input.value = ${JSON.stringify(content)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('send-btn').click();
    })()`);
}

const streamText = win => evaluate(win, "document.querySelector('.agent-streaming-row .ai-content-area')?.textContent.trim() || ''");
const inputText = entry => entry.body.input.flatMap(item => (item.content || []).map(part => part.text || ""));
async function capture(win, name) {
    // Wait for the compositor and the transcript's smooth scroll to settle.
    await sleep(420);
    const image = await win.webContents.capturePage();
    assert.ok(!image.isEmpty(), name);
    await fs.writeFile(path.join(screenshots, name), image.toPNG());
}

setTimeout(() => { console.error("Agent streaming UI smoke test timed out"); app.exit(1); }, 90000).unref();

app.whenReady().then(async () => {
    let exitCode = 0;
    try {
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        await fs.mkdir(screenshots, { recursive: true });
        const workspace = path.join(profile, "workspace");
        await fs.mkdir(workspace, { recursive: true });
        await fs.writeFile(path.join(workspace, "README.md"), "# 示例项目\n入口文件位于 src/index.js。\n");
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
        const main = await until(() => BrowserWindow.getAllWindows().find(win => /index\.html$/.test(win.webContents.getURL())), "main window");
        await until(() => evaluate(main, "document.getElementById('setup-guide-modal')?.classList.contains('modal-active')"), "setup guide");
        main.webContents.debugger.attach();
        await main.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
        await evaluate(main, `(() => {
            setTheme('dark');
            localStorage.setItem('first_setup_guide_shown','1');
            localStorage.setItem('base_url', 'http://127.0.0.1:${server.address().port}/v1');
            localStorage.setItem('api_key', 'local-test');
            localStorage.setItem('request_endpoint', '/responses');
            localStorage.setItem('agent_native_notifications', 'false');
            closeSetupGuide();
            window.smokeEnterAgent = enterAgentMode();
        })()`);
        await until(() => evaluate(main, "document.getElementById('agent-workspace-trust-modal').classList.contains('visible')"), "workspace binding");
        await evaluate(main, "resolveAgentWorkspaceTrust(true); window.smokeEnterAgent");
        await evaluate(main, "hideVoiceNotification()");
        await send(main, "请先查看项目结构，告诉我从哪里开始阅读。");
        const initial = await request(1);
        assert.match(initial.body.instructions, /one or two short, user-facing sentences/);
        event(initial, { type: "response.reasoning_summary_text.delta", delta: "先阅读项目说明，再根据结果回答。" });
        delta(initial, "我先看一下");
        await until(async () => await streamText(main) === "我先看一下", "first text delta before response completes");
        const read = tool("read_file_range", { path: "README.md", start_line: 1, end_line: 2 });
        delta(initial, "项目说明。\n" + read.slice(0, 5));
        await until(async () => await streamText(main) === "我先看一下项目说明。", "second delta without partial JSON");
        delta(initial, read.slice(5));
        await sleep(100);
        assert.equal(await streamText(main), "我先看一下项目说明。");
        assert.equal(await evaluate(main, "chats.find(c => c.id === activeChatId).messages.some(m => m.toolName === 'read_file_range')"), false);
        finish(initial);

        await request(2);
        await until(() => evaluate(main, "document.querySelector('.agent-backend-retry-row')?.textContent.includes('HTTP 404')"), "transcript retry indication");
        const retryStyle = () => evaluate(main, `(() => {
            const row = document.querySelector('.agent-backend-retry-row');
            const tools = row.previousElementSibling?.querySelector('.agent-round-summary');
            const summary = row.querySelector('.agent-retry-summary');
            const label = summary.querySelector('.agent-tool-summary-text');
            const bounds = el => el.getBoundingClientRect();
            return { tools: tools?.textContent, retry: label.textContent, below: bounds(summary).top >= bounds(tools).bottom,
                aligned: bounds(summary).left === bounds(tools).left, font: getComputedStyle(summary).fontSize === getComputedStyle(tools).fontSize,
                lineHeight: getComputedStyle(summary).lineHeight === getComputedStyle(tools).lineHeight,
                color: getComputedStyle(summary).color, animation: getComputedStyle(label).animationName,
                composerNotice: Boolean(document.getElementById('queued-agent-messages')) };
        })()`);
        assert.deepEqual(await retryStyle(), { tools: "Read 1 file", retry: "后端错误：HTTP 404 未找到接口或模型 正在重试 （1/6）",
            below: true, aligned: true, font: true, lineHeight: true, color: "rgb(255, 104, 122)", animation: "agent-activity-shine", composerNotice: false });
        await capture(main, "AIUI-V10.3.0-Agent-retry-dark.png");
        await evaluate(main, "setTheme('light', false)");
        await until(() => evaluate(main, "document.body.classList.contains('theme-light')"), "light theme");
        assert.equal((await retryStyle()).color, "rgb(188, 48, 70)");
        await capture(main, "AIUI-V10.3.0-Agent-retry-light.png");
        await evaluate(main, "setTheme('dark', false)");

        const retry = await request(3);
        assert.deepEqual(retry.body.input, requestLog[1].body.input);
        delta(retry, "已经找到入口文件");
        await until(async () => await streamText(main) === "已经找到入口文件", "streaming after retry");
        const queued = "也请附上一条最简单的验证建议。";
        await send(main, queued);
        assert.equal(requestLog.length, 3);
        assert.equal(retry.cancelled, false);
        assert.equal(await evaluate(main, `document.querySelector('.user-bubble:last-child') !== null &&
            [...document.querySelectorAll('.user-bubble')].at(-1).textContent.includes(${JSON.stringify(queued)}) &&
            !chats.find(c => c.id === activeChatId).messages.some(m => m.content === ${JSON.stringify(queued)})`), true);
        await capture(main, "AIUI-V10.3.0-Agent-stream-and-queue.png");
        delta(retry, "，我会核对项目说明中的路径。\n" + read);
        finish(retry);

        const final = await request(4);
        assert.equal(inputText(final).at(-1), queued);
        assert.match(inputText(final).at(-2), /Tool Result: read_file_range/);
        const answer = "建议从 `src/index.js` 读起。先核对它在项目说明中的路径，再运行项目自带的测试确认入口能正常加载。";
        delta(final, answer);
        finish(final, [message(`${answer}\n${tool("finish_task")}`)]);
        await until(() => evaluate(main, "!isGenerating && document.querySelector('.agent-final-row .message-time')?.textContent"), "final answer committed");
        await until(() => evaluate(main, `(() => {
            const progress = [...document.querySelectorAll('.agent-segment-row')];
            const final = document.querySelector('.agent-final-row');
            return progress.length === 2 && progress.every(row => !row.querySelector('.message-footer')) &&
                final?.querySelector('[title="复制回复"]') && final?.querySelector('[data-voice-source]') &&
                !document.querySelector('.agent-backend-retry-row,.agent-streaming-row') &&
                !document.getElementById('messages-wrapper').textContent.includes('"tool_call"');
        })()`), "progress and final toolbar layout");
        const cdp = main.webContents.debugger;
        await cdp.sendCommand("DOM.enable");
        await cdp.sendCommand("CSS.enable");
        const { root } = await cdp.sendCommand("DOM.getDocument");
        const { nodeId } = await cdp.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: ".agent-final-row .message-footer" });
        await cdp.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
        await until(() => evaluate(main, "getComputedStyle(document.querySelector('.agent-final-row .copy-icon-btn')).opacity === '1'"), "visible final copy and playback buttons");
        await capture(main, "AIUI-V10.3.0-Agent-final.png");
        await cdp.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });

        await evaluate(main, "window.electronAPI.openPreferences(); true");
        const prefs = await until(() => BrowserWindow.getAllWindows().find(win => /preferences=1/.test(win.webContents.getURL())), "preferences window");
        await until(() => evaluate(prefs, "Boolean(document.querySelector('[data-section=agent] svg'))"), "settings ready");
        assert.deepEqual(await evaluate(prefs, `(() => {
            document.querySelector('[data-section=agent]').click();
            const input = document.getElementById('agent-message-insertion');
            return [input.value, ...Array.from(input.options, item => item.textContent)];
        })()`), ["queue", "排队发送（默认）", "打断发送"]);
        await sleep(200);
        await capture(prefs, "AIUI-V10.3.0-Agent-settings.png");
        await evaluate(prefs, `(() => {
            const input = document.getElementById('agent-message-insertion');
            input.value = 'interrupt';
            input.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await evaluate(main, "localStorage.getItem('agent_message_insertion')"), "interrupt");
        void evaluate(prefs, "window.electronAPI.closePreferences(); true").catch(() => {});
        await until(() => prefs.isDestroyed(), "preferences closed");

        await send(main, "先列出一份完整的阅读计划。");
        const interrupted = await request(5);
        delta(interrupted, "正在整理详细计划。\n" + read.slice(0, 20));
        await until(async () => await streamText(main) === "正在整理详细计划。", "interruptible preview");
        await send(main, "改成两句话，先给我入口文件和验证方法。");
        const replacement = await request(6);
        await until(() => interrupted.cancelled, "backend stream cancelled by inserted user message");
        assert.equal(inputText(replacement).at(-1), "改成两句话，先给我入口文件和验证方法。");
        assert.ok(!inputText(replacement).some(text => text.includes("正在整理详细计划")));
        finish(replacement, [message("入口是 src/index.js。运行项目自带的测试即可验证加载。")]);
        await until(() => evaluate(main, "!isGenerating && document.querySelectorAll('.agent-final-row').length === 2"), "interrupted task resumed");

        await evaluate(main, "createNewChat(); AIUIMemory.setEnabled(true)");
        await send(main, "请帮我记住我喜欢四格缩进。");
        const ordinary = await request(7);
        assert.match(ordinary.body.instructions, /explicit consent for that specific change/);
        assert.match(ordinary.body.instructions, /several meaningful sentences/);
        finish(ordinary, [message("我会保留你偏好四格缩进这条设置。下次提供代码示例时，我会按这个格式排版。遇到已有代码风格的项目时，我也会参考项目内的约定。")]);
        await until(() => evaluate(main, "!isGenerating && document.querySelector('.ai-content-area')?.textContent.includes('四格缩进')"), "ordinary reply");
        console.log(`Agent streaming UI smoke test passed. Screenshots: ${screenshots}`);
    } catch (error) {
        exitCode = 1;
        console.error(error);
    } finally {
        server.closeAllConnections();
        server.close();
        app.exit(exitCode);
    }
});
