"use strict";

// Opt-in only: AIUI_AGENT_LIVE_TEST=1 electron test/agent-live-smoke.js
// Uses the user's existing connection settings, in an isolated copied profile.
// It does not mock fetch, tool IPC, preload, model responses or Agent execution.
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { AgentWorkspaceStore } = require("../agent-tools");

if (process.env.AIUI_AGENT_LIVE_TEST !== "1") {
    console.log("Live Agent smoke test is opt-in. Set AIUI_AGENT_LIVE_TEST=1 to run.");
    app.exit(0);
} else {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aiui-agent-live-"));
    const profile = path.join(testRoot, "sensitive-profile");
    const workspace = path.join(testRoot, "中文 空格 工作区");
    const reportPath = path.join(testRoot, "report.json");
    const sourceProfile = process.env.AIUI_AGENT_LIVE_SOURCE_PROFILE || path.join(process.env.APPDATA || "", "AIUI");
    const chatId = `live-smoke-${process.pid}-${Date.now()}`;
    const report = { model: "deepseek-flash", endpoint: "Responses", startedAt: new Date().toISOString(), passed: false, rounds: [], assertions: [] };
    let mainWindow;
    let finished = false;
    let globalTimer;
    let lastToolCount = 0;
    const diagnosticJobs = new Set();
    let stdoutAvailable = true;
    // Detached Windows GUI launches can lose their inherited stdio handles at
    // any point. Logging is optional; the durable report is the source of truth.
    process.stdout.on("error", () => { stdoutAvailable = false; });
    process.stderr.on("error", () => {});
    const safeLog = value => {
        if (!stdoutAvailable || process.stdout.destroyed) return;
        try { process.stdout.write(String(value) + "\n"); }
        catch { stdoutAvailable = false; }
    };
    // The imported desktop process must never print connection details or bodies.
    console.warn = () => {};
    console.error = () => {};
    console.log = () => {};
    app.disableHardwareAcceleration();
    app.setPath("userData", profile);
    fs.mkdirSync(profile, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });

    const evaluate = (fn, ...args) => mainWindow.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function until(read, description, timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const value = await read();
            if (value) return value;
            await delay(100);
        }
        throw new Error(description);
    }
    function scheduleCleanup() {
        // Electron holds LevelDB locks until process exit. A Node-mode child
        // removes only this run's private profile/workspace after its parent exits.
        const cleanup = `const fs=require('fs/promises');const path=require('path');const base=process.argv[1];const parent=Number(process.argv[2]);let attempts=0;const tick=async()=>{let alive=true;try{process.kill(parent,0)}catch{alive=false}if(alive){if(attempts++<1200)setTimeout(tick,1000);return}for(let n=0;n<40;n++){try{for(const name of ['sensitive-profile','中文 空格 工作区'])await fs.rm(path.join(base,name),{recursive:true,force:true});return}catch{await new Promise(r=>setTimeout(r,250))}}};tick();`;
        const child = spawn(process.execPath, ["-e", cleanup, testRoot, String(process.pid)], { detached: true, windowsHide: true, stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
        child.unref();
    }
    function safeFailure(error) {
        // Controlled assertion labels only; never retain arbitrary provider errors.
        if (error?.code === "ERR_ASSERTION") return "A live result assertion failed; see assertion flags and round summaries.";
        const message = String(error?.message || "");
        if (/^Controlled (?:total live test|live round) timeout(?:: [a-z-]+)?$/.test(message)) return message;
        return "Live setup or execution failed; inspect local runtime diagnostics.";
    }
    async function finish(exitCode, error) {
        if (finished) return;
        finished = true;
        clearTimeout(globalTimer);
        if (error) report.failure = safeFailure(error);
        report.passed = exitCode === 0;
        report.finishedAt = new Date().toISOString();
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                await evaluate(async () => { stopAgentTask(); await window.electronAPI.stopAllAgentProcesses(); localStorage.clear(); });
            }
        } catch { report.cleanupIPCFailed = true; }
        await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
        safeLog(JSON.stringify({ passed: report.passed, rounds: report.rounds.length, tools: report.rounds.flatMap(round => round.tools.map(tool => tool.name)), reportPath }));
        for (const win of BrowserWindow.getAllWindows()) win.destroy();
        app.exit(exitCode);
    }
    async function check(name, pass) {
        report.assertions.push({ name, passed: Boolean(pass) });
        assert(pass, name);
        await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    }

    function summarizeResponse(raw, endpoint, httpStatus) {
        const redact = value => [getAPIKey(), getBaseURL()].filter(secret => typeof secret === "string" && secret.length > 3).reduce((text, secret) => text.split(secret).join("[redacted connection setting]"), String(value || "")).replace(/https?:\/\/[^\s<>"']+/g, "[URL omitted]");
        const events = new Map();
        const completions = [];
        let deltaText = "";
        let doneText = "";
        let completedText = "";
        let reasoning = "";
        let parsedEvents = 0;
        let unparsedEvents = 0;
        const shape = output => (Array.isArray(output) ? output : []).map(item => ({ type: item.type, role: item.role,
            content: (Array.isArray(item.content) ? item.content : []).map(part => ({ type: part.type, textChars: typeof part.text === "string" ? part.text.length : 0 })),
            summary: (Array.isArray(item.summary) ? item.summary : []).map(part => ({ type: part.type, textChars: typeof part.text === "string" ? part.text.length : 0 })) }));
        const outputText = output => (Array.isArray(output) ? output : []).filter(item => item.type === "message").flatMap(item => Array.isArray(item.content) ? item.content : []).filter(part => ["output_text", "text"].includes(part.type)).map(part => part.text || "").join("");
        const records = String(raw || "").split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n")).filter(Boolean);
        if (!records.length && String(raw).trim().startsWith("{")) records.push(String(raw));
        for (const data of records) {
            if (data === "[DONE]") continue;
            let event;
            try { event = JSON.parse(data); parsedEvents++; } catch { unparsedEvents++; continue; }
            const type = String(event.type || (event.choices ? "chat.choices" : event.error ? "error" : "untyped")).slice(0, 100);
            const entry = events.get(type) || { type, count: 0, textDeltaChars: 0, reasoningDeltaChars: 0 };
            entry.count++;
            if (typeof event.delta === "string") {
                if (/reasoning/.test(type)) { reasoning += event.delta; entry.reasoningDeltaChars += event.delta.length; }
                else if (/output_text/.test(type)) { deltaText += event.delta; entry.textDeltaChars += event.delta.length; }
            }
            if (type === "response.output_text.done" && typeof event.text === "string") doneText += event.text;
            for (const choice of event.choices || []) {
                const part = choice.delta || choice.message || {};
                if (typeof part.content === "string") { deltaText += part.content; entry.textDeltaChars += part.content.length; }
                const thought = part.reasoning_content || part.reasoning;
                if (typeof thought === "string") { reasoning += thought; entry.reasoningDeltaChars += thought.length; }
                if (choice.finish_reason) completions.push({ status: choice.finish_reason });
            }
            if (type === "response.output_item.done") entry.output = shape([event.item]);
            const response = event.response || (Array.isArray(event.output) ? event : null);
            if (response && /completed|incomplete|failed/.test(type + " " + response.status)) {
                const text = outputText(response.output) || response.output_text || "";
                if (text) completedText = text;
                completions.push({ type, status: response.status, incompleteReason: response.incomplete_details?.reason, output: shape(response.output) });
                for (const item of response.output || []) if (item.type === "reasoning" && !reasoning) reasoning = (item.summary || []).map(part => part.text || "").join("\n");
            }
            if (event.error) entry.errorType = String(event.error.type || event.error.code || "provider_error").slice(0, 80);
            events.set(type, entry);
        }
        const actualText = completedText || doneText || deltaText;
        return { endpoint, httpStatus, responseBytes: new TextEncoder().encode(String(raw)).length, parsedEvents, unparsedEvents,
            events: [...events.values()], completions, actualTextChars: actualText.length, actualTextTail: redact(actualText.slice(-2000)),
            reasoningChars: reasoning.length };
    }

    async function observeRealResponses() {
        const debuggerAPI = mainWindow.webContents.debugger;
        debuggerAPI.attach("1.3");
        await debuggerAPI.sendCommand("Network.enable", { maxTotalBufferSize: 32 * 1024 * 1024, maxResourceBufferSize: 16 * 1024 * 1024 });
        const requests = new Map();
        debuggerAPI.on("message", (_event, method, params) => {
            if (method === "Network.responseReceived") {
                let endpoint;
                try {
                    const pathname = new URL(params.response.url).pathname;
                    endpoint = /\/responses\/?$/.test(pathname) ? "Responses" : /\/chat\/completions\/?$/.test(pathname) ? "ChatCompletions" : /\/messages\/?$/.test(pathname) ? "Messages" : "";
                } catch { return; }
                if (endpoint) requests.set(params.requestId, { endpoint, status: params.response.status });
            }
            if (method === "Network.loadingFinished" && requests.has(params.requestId)) {
                const metadata = requests.get(params.requestId);
                requests.delete(params.requestId);
                const job = (async () => {
                    try {
                        const body = await debuggerAPI.sendCommand("Network.getResponseBody", { requestId: params.requestId });
                        const raw = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
                        const summary = await mainWindow.webContents.executeJavaScript(`(${summarizeResponse.toString()})(...${JSON.stringify([raw, metadata.endpoint, metadata.status])})`);
                        report.responseDiagnostics ||= [];
                        report.responseDiagnostics.push(summary);
                        report.responseDiagnostics = report.responseDiagnostics.slice(-3);
                        await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
                    } catch { report.responseDiagnosticUnavailable = true; }
                })();
                diagnosticJobs.add(job);
                job.finally(() => diagnosticJobs.delete(job));
            }
        });
    }

    async function runRound(label, prompt, timeoutMs = 300000, { allowImageCapabilityError = false } = {}) {
        const startedAt = Date.now();
        await evaluate(async () => {
            const changing = onAgentCommandModeChange("yolo");
            resolveAgentYoloWarning(true);
            await changing;
        });
        await evaluate((id, text) => {
            const chat = chats.find(item => String(item.id) === id);
            window.__liveSmokeRound = { done: false, failed: false, startIndex: chat.messages.length };
            chat.messages.push({ role: "user", content: text });
            appendMessageToUI("user", text);
            localStorage.setItem("ai_chats", JSON.stringify(chats));
            window.requestAgentLoop("deepseek-flash", chat).then(() => { window.__liveSmokeRound.done = true; }, () => { window.__liveSmokeRound.failed = true; window.__liveSmokeRound.done = true; });
        }, chatId, prompt);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const progress = await evaluate(id => {
                const chat = chats.find(item => String(item.id) === id);
                const state = window.__liveSmokeRound;
                const messages = chat.messages.slice(state.startIndex);
                const redact = value => [getAPIKey(), getBaseURL()].filter(secret => typeof secret === "string" && secret.length > 3).reduce((text, secret) => text.split(secret).join("[redacted connection setting]"), String(value || "")).replace(/https?:\/\/[^\s<>"']+/g, "[URL omitted]");
                return { done: state.done, failed: state.failed, running: isAgentTaskRunning(),
                    tools: messages.filter(message => message.role === "tool").map(message => ({ name: message.toolName || message.name, status: message.status, success: message.result?.success !== false, exitCode: message.result?.exitCode,
                        ...(typeof message.result?.stdout === "string" ? { verificationMarker: message.result.stdout.includes("VERIFY_OK"), workerReadyMarker: message.result.stdout.includes("WORKER_READY") } : {}),
                        ...(typeof message.result?.error === "string" ? { error: redact(message.result.error).slice(0, 300) } : {}),
                        ...(Array.isArray(message.result?.results) ? { resultCount: message.result.results.length,
                            electronResult: message.result.results.some(item => /electron/i.test(String(item.title || "") + " " + String(item.snippet || ""))) } : {}),
                        ...(typeof message.result?.text === "string" ? { outputChars: message.result.text.length,
                            exampleDomainText: message.result.text.includes("Example Domain") } : {}) })),
                    finals: messages.filter(message => message.role === "assistant" && !message.hidden && !message.agentRecovery && message.agentFinal).map(message => ({ content: redact(message.content), failed: message.failed === true })),
                    recoveryCount: messages.filter(message => message.agentRecovery).length,
                    lastMessages: messages.slice(-8).map(message => ({ role: message.role, hidden: message.hidden === true, agentFinal: message.agentFinal === true, agentRecovery: message.agentRecovery === true, failed: message.failed === true,
                        ...(message.role === "assistant" ? { content: redact(String(message.content || "").slice(-2000)) } : message.toolName === "agent_protocol" ? { diagnostic: redact(String(message.result?.error || message.content || "").slice(-3000)) } : {}) })),
                    assistantCount: messages.filter(message => message.role === "assistant" && !message.hidden).length };
            }, chatId);
            if (progress.tools.length !== lastToolCount) {
                lastToolCount = progress.tools.length;
                report.currentProgress = { label, elapsedMs: Date.now() - startedAt, tools: progress.tools };
                await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
                safeLog(JSON.stringify({ round: label, tools: progress.tools.map(tool => ({ name: tool.name, status: tool.status })) }));
            }
            if (progress.done && !progress.running) {
                await Promise.allSettled([...diagnosticJobs]);
                const round = { label, durationMs: Date.now() - startedAt, tools: progress.tools, finals: progress.finals, recoveryCount: progress.recoveryCount, assistantCount: progress.assistantCount, lastMessages: progress.lastMessages,
                    responseDiagnostics: JSON.parse(JSON.stringify(report.responseDiagnostics || [])) };
                report.rounds.push(round);
                const imageCapabilityError = allowImageCapabilityError && progress.finals.some(final => final.failed && /(?:image|vision|multimodal|图片|图像)/i.test(final.content) && /(?:unsupported|not support|不支持|400|invalid)/i.test(final.content));
                if (imageCapabilityError) { round.capabilityLimitation = "The configured model/provider rejected image input; actual view_image succeeded and the loop returned an explicit nonempty error."; }
                else {
                    const nonemptyFinal = !progress.failed && progress.finals.some(final => final.content.trim() && !final.failed) && progress.tools.some(tool => tool.name === "finish_task" && tool.status === "done");
                    const proseFinal = progress.finals.length > 0 && progress.finals.every(final => !/DSML|<\/?tool_call|"tool_call"|"tool_calls"/.test(final.content));
                    report.assertions.push({ name: `${label}: nonempty final and completed loop`, passed: nonemptyFinal }, { name: `${label}: final contains prose rather than tool protocol`, passed: proseFinal });
                    round.validFinal = nonemptyFinal && proseFinal;
                }
                return round;
            }
            await delay(1000);
        }
        throw new Error(`Controlled live round timeout: ${label}`);
    }

    async function prepare() {
        const storage = path.join(sourceProfile, "Local Storage");
        assert(fs.existsSync(storage), "Existing AIUI Local Storage is required");
        await fsp.cp(storage, path.join(profile, "Local Storage"), { recursive: true, filter: source => path.basename(source) !== "LOCK" });
        await fsp.mkdir(path.join(workspace, "src"), { recursive: true });
        await fsp.writeFile(path.join(workspace, "src", "计算器.cjs"), "exports.add = (a, b) => a - b;\nexports.label = '未完成';\nexports.version = 0;\n", "utf8");
        await fsp.writeFile(path.join(workspace, "verify.cjs"), "const a=require('node:assert/strict');const fs=require('node:fs');const c=require('./src/计算器.cjs');a.equal(c.add(2,3),5);a.equal(c.add(-2,2),0);a.equal(c.label,'已验证🙂');a.equal(c.version,1);a.equal(fs.readFileSync('docs/结果.md','utf8').includes('验证通过'),true);console.log('VERIFY_OK');", "utf8");
        await fsp.writeFile(path.join(workspace, "worker.cjs"), "console.log('WORKER_READY');setInterval(()=>console.log('WORKER_TICK'),350);", "utf8");
        // Generate a valid, nontrivial PNG rather than relying on a tiny fixture
        // that some model providers reject before attempting vision inference.
        const pixels = Buffer.alloc(64 * 64 * 4);
        for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
            const index = (y * 64 + x) * 4;
            pixels[index] = x < 32 ? 0 : 255;
            pixels[index + 1] = 0;
            pixels[index + 2] = x < 32 ? 255 : 0;
            pixels[index + 3] = 255;
        }
        const image = nativeImage.createFromBitmap(pixels, { width: 64, height: 64 });
        assert(!image.isEmpty(), "Generated image is empty");
        await fsp.writeFile(path.join(workspace, "像素.png"), image.toPNG());
        const store = new AgentWorkspaceStore(path.join(profile, "agent-workspaces.json"));
        await store.bind(chatId, workspace);
        app.on("browser-window-created", (_event, win) => {
            win.on("show", () => win.hide()); win.setSkipTaskbar(true); win.hide();
            win.webContents.on("console-message", (_event, level, message, line) => {
                if (level >= 3 && /(?:SyntaxError|ReferenceError|TypeError):/.test(message)) {
                    report.rendererErrors ||= [];
                    report.rendererErrors.push({ type: message.match(/(?:SyntaxError|ReferenceError|TypeError):/)?.[0], line, missingIdentifier: message.match(/ReferenceError: ([A-Za-z_$][\w$]*) is not defined/)?.[1] });
                }
            });
        });
        require("../main");
        await app.whenReady();
        mainWindow = await until(() => BrowserWindow.getAllWindows().find(win => /index\.html(?:$|\?)/.test(win.webContents.getURL())), "Main window did not initialize");
        // main's relative loadFile resolves against Electron's entry directory;
        // this opt-in entry lives in test/, so point the same real main window
        // at the production HTML explicitly without replacing any IPC handler.
        await mainWindow.loadFile(path.resolve(__dirname, "..", "index.html"));
        await until(async () => {
            const state = await evaluate(() => ({ hasLoop: typeof window.requestAgentLoop === "function", hasElectron: window.electronAPI?.isElectron === true, readyState: document.readyState, protocol: Boolean(window.AgentProtocol), hasInput: Boolean(document.getElementById("user-input")) }));
            report.rendererReadiness = state;
            return state.hasLoop && state.hasElectron && state.readyState === "complete";
        }, "Agent renderer did not initialize");
        const config = await evaluate((id, boundWorkspace) => {
            const configured = Boolean(localStorage.getItem("api_key")?.trim() && localStorage.getItem("base_url")?.trim());
            if (!configured) return { configured: false };
            localStorage.setItem("request_endpoint", "/responses");
            localStorage.setItem("record_logs", "false");
            localStorage.setItem("developer_mode", "false");
            localStorage.setItem("auto_update", "false");
            localStorage.setItem("agent_shell_timeout_seconds", "30");
            localStorage.setItem("agent_view_image_detail", "original");
            const testChat = { id, title: "隔离真实 Agent 回归", messages: [], createdAt: Date.now(), updatedAt: Date.now(), agentEnabled: true, agentWorkspace: boundWorkspace, agentWorkspaceAvailable: true, agentSystemPrompt: "你是正在隔离工作区执行真实软件测试的智能体。文件操作仅限已绑定工作区；只有用户明确要求时才访问指定公开网页或公开搜索，绝不读取其他文件夹。严格调用已定义工具，不要伪称完成。必须给出经工具验证的非空最终答复，然后调用 finish_task。" };
            chats.splice(0, chats.length, testChat);
            activeChatId = id;
            window.queuedAgentMessages = [];
            currentAttachments = [];
            localStorage.setItem("ai_chats", JSON.stringify(chats));
            const select = document.getElementById("model-select");
            if (![...select.options].some(option => option.value === "deepseek-flash")) select.add(new Option("deepseek-flash", "deepseek-flash"));
            select.value = "deepseek-flash";
            renderChatHistory(); renderMessages([]); updateAgentUIForChat(testChat);
            const changing = onAgentCommandModeChange("yolo");
            resolveAgentYoloWarning(true);
            return changing.then(() => ({ configured: true }));
        }, chatId, workspace);
        assert(config.configured, "Existing API configuration was unavailable in the isolated profile");
        await observeRealResponses();
    }

    scheduleCleanup();
    globalTimer = setTimeout(() => finish(1, new Error("Controlled total live test timeout")), 14 * 60000);
    prepare().then(async () => {
        const first = await runRound("file-refactor", "这是实际工具回归，请确实完成，禁止只描述。仅操作当前工作区。先使用 list_dir、glob_files、grep_files 与 read_file_range 探索 src/计算器.cjs 和 verify.cjs。用 edit_file 修复 add 的加法错误，再用 multi_edit_file 同时将 label 改为'已验证🙂'、version改为1。用 apply_patch 新建 docs/补丁记录.md（内容包含PATCH_OK）；本地支持apply_patch，调用格式为独立JSON对象 {\"tool_call\":{\"name\":\"apply_patch\",\"arguments\":{\"input\":\"*** Begin Patch\\n*** Add File: docs/补丁记录.md\\n+PATCH_OK\\n*** End Patch\"}}}，不要用write_file代替这个补丁步骤。再用 write_file 新建 docs/结果.md（包含'验证通过'）。然后 run_shell 执行 node verify.cjs，必须得到VERIFY_OK和exitCode0；失败则修复再验证。最后给出中文简短最终总结，然后finish_task。", 360000);
        const calculator = await fsp.readFile(path.join(workspace, "src", "计算器.cjs"), "utf8");
        await check("calculator persisted required refactor", /a\s*\+\s*b/.test(calculator) && calculator.includes("已验证🙂") && /version\s*=\s*1/.test(calculator));
        await check("patch artifact exists", (await fsp.readFile(path.join(workspace, "docs", "补丁记录.md"), "utf8")).includes("PATCH_OK"));
        await check("write artifact exists", (await fsp.readFile(path.join(workspace, "docs", "结果.md"), "utf8")).includes("验证通过"));
        await check("first round executed a successful shell verification", first.tools.some(tool => tool.name === "run_shell" && tool.status === "done" && tool.exitCode === 0 && tool.verificationMarker));
        await check("first round executed actual apply_patch", first.tools.some(tool => ["apply_patch", "_codex_apply_patch"].includes(tool.name) && tool.status === "done"));
        const second = await runRound("process-followup", "继续上一轮真实回归，文件改动必须保留。这一轮不要调用view_image。用start_process启动 node worker.cjs，process_id='live-worker'；用read_process_output读取到WORKER_READY，可再次轮询，使用list_processes确认运行，再stop_process停止，最后再次list_processes确认没有运行中的后台进程。再使用copy_path将docs/结果.md复制为docs/副本.md，move_path改名为docs/归档.md，read_file_range确认内容，然后delete_path删除docs/归档.md。请确实调用这些工具。用write_file创建followup.json，内容为JSON {\"processStopped\":true,\"previousResult\":\"VERIFY_OK\"}；最后给出非空中文最终答复并finish_task。", 360000);
        await check("followup metadata persisted", JSON.parse(await fsp.readFile(path.join(workspace, "followup.json"), "utf8")).processStopped === true);
        await check("temporary archive removed", !fs.existsSync(path.join(workspace, "docs", "归档.md")));
        for (const name of ["start_process", "read_process_output", "list_processes", "stop_process", "copy_path", "move_path", "delete_path"]) await check(`followup executed ${name}`, second.tools.some(tool => tool.name === name && tool.status === "done"));
        await check("background worker readiness actually observed", second.tools.some(tool => tool.name === "read_process_output" && tool.workerReadyMarker));
        const active = await evaluate(() => window.electronAPI.listAgentProcesses());
        await check("no background processes remain", !active.processes.some(process => process.running));
        const webRound = await runRound("public-web-tools", "继续进行两种真实联网工具测试（本轮明确授权访问公开网络）。实际调用web_search搜索'Electron BrowserWindow docs'，并实际调用browse_web读取https://example.com，max_chars=2000。只根据真实工具返回说明搜索是否成功，以及example.com页面写了什么；如任一网络工具失败、超时或无结果，最终回答必须诚实写明失败，不能编造结果。禁止用run_shell替代这两个工具。给出非空中文最终回答并finish_task。", 180000);
        for (const name of ["web_search", "browse_web"]) {
            const tool = webRound.tools.find(item => item.name === name);
            await check(`public network invoked ${name}`, Boolean(tool));
            if (tool.status === "error" || tool.success === false) {
                await check(`${name} failure explicitly acknowledged`, webRound.finals.some(final => /失败|无法|超时|未能|没有.*结果|无结果|未找到|受限|不可用|failure|failed|unable/i.test(final.content)));
                report.networkLimitations ||= [];
                report.networkLimitations.push({ name, error: tool.error || "The tool did not return a successful result." });
            } else await check(`${name} returned actual content`, name === "web_search" ? tool.resultCount > 0 && tool.electronResult : tool.outputChars > 0 && tool.exampleDomainText);
        }
        const imageRound = await runRound("image-inspection", "最后一轮：实际调用view_image查看像素.png，它是64x64的双色PNG，只有左右两块实色。请根据实际图片回答左侧与右侧分别是什么颜色，禁止凭文件名猜测。如果服务明确不支持图像，请如实说明能力限制，不要编造颜色。给出非空最终回答并finish_task。", 180000, { allowImageCapabilityError: true });
        await check("image round invoked actual view_image", imageRound.tools.some(tool => tool.name === "view_image" && tool.status === "done"));
        if (!imageRound.capabilityLimitation) {
            await check("image answer identifies both colored regions", imageRound.finals.some(final => /红|red/i.test(final.content) && /蓝|blue/i.test(final.content)));
        }
        await finish(report.assertions.every(item => item.passed) ? 0 : 1);
    }).catch(error => finish(1, error));
}
