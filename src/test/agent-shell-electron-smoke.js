const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "aiui-agent-shell-"));
const workspace = path.join(profile, "workspace");
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(profile, "agent-workspaces.json"), JSON.stringify({ "shell-smoke": workspace }));
fs.writeFileSync(path.join(workspace, "fixture.cjs"), `
    const fs = require("node:fs");
    if (process.argv[2] === "flood") {
        const block = "日志🙂\\n".repeat(4096);
        let count = 0;
        const timer = setInterval(() => {
            process.stdout.write(block);
            if (++count === 256) {
                clearInterval(timer);
                console.error("完成🙂");
            }
        }, 8);
    } else {
        console.log("READY", process.pid);
        setTimeout(() => fs.writeFileSync(process.argv[2], "shell survived"), 8000);
    }
`);
app.setPath("userData", profile);
app.disableHardwareAcceleration();
require("../main/main");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
    const deadline = Date.now() + 10000;
    do {
        const result = await check();
        if (result) return result;
        await sleep(30);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${label}`);
}

let phase = "startup";
const watchdog = setTimeout(() => { console.error(`Agent Shell smoke test timed out during ${phase}`); app.exit(1); }, 45000);
app.on("quit", () => clearTimeout(watchdog));
process.on("uncaughtException", error => { console.error(phase, error); app.exit(1); });

app.whenReady().then(async () => {
    const agentProcess = () => app.getAppMetrics().find(process => process.name === "Agent Shell");
    try {
        const win = await until(() => BrowserWindow.getAllWindows().find(window => /index\.html$/.test(window.webContents.getURL())), "main window");
        const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`);
        await until(() => evaluate(() => Boolean(window.appendAgentToolMessageToUI)), "renderer app");
        const tool = (name, args, extra) => evaluate((name, args, extra) => window.electronAPI.executeAgentTool({
            chatId: "shell-smoke", name, arguments: args, ...extra
        }), name, args, extra);
        const command = mode => `node fixture.cjs ${mode}`;
        const start = async (id, mode) => {
            const result = await tool("start_process", { command: command(mode), process_id: id });
            assert.equal(result.success, true, result.error);
        };
        const waitForReady = id => until(async () => {
            const result = await tool("read_process_output", { process_id: id, tail_bytes: 32 });
            return result.running && Number(result.stdout.match(/READY (\d+)/)?.[1]);
        }, id);

        assert.deepEqual(await evaluate(() => window.electronAPI.listAgentProcesses()), { success: true, processes: [] });
        assert.equal(agentProcess(), undefined, "the shell service starts on demand");
        phase = "foreground output";
        let mainTicks = 0;
        const mainHeartbeat = setInterval(() => mainTicks++, 25);
        const flood = await evaluate(async command => {
            const updates = [];
            const off = window.electronAPI.onAgentShellProgress(progress => updates.push(progress));
            let ticks = 0;
            const heartbeat = setInterval(() => ticks++, 25);
            try {
                const result = await window.electronAPI.executeAgentTool({
                    chatId: "shell-smoke", name: "run_shell", arguments: { command }, executionId: "flood"
                });
                window.flood = result;
                return { exitCode: result.exitCode, bytes: result.stdoutBytes, truncated: result.stdoutTruncated,
                    stderr: result.stderr.trim(), durationMs: result.durationMs, updates, ticks };
            } finally {
                clearInterval(heartbeat);
                off();
            }
        }, command("flood")).finally(() => clearInterval(mainHeartbeat));
        assert.equal(flood.exitCode, 0);
        assert.equal(flood.bytes, Buffer.byteLength("日志🙂\n") * 4096 * 256);
        assert.equal(flood.truncated, true);
        assert.equal(flood.stderr, "完成🙂");
        assert.ok(flood.ticks > 10 && mainTicks > 10, `heartbeats during command: main=${mainTicks}, renderer=${flood.ticks}`);
        assert.ok(flood.updates.length >= 2 && flood.updates.length <= 1 + Math.ceil(flood.durationMs / 240));
        assert.ok(flood.updates.every((progress, i, all) => !i || progress.elapsedMs - all[i - 1].elapsedMs >= 240));
        const utility = agentProcess();
        assert.equal(utility?.type, "Utility");
        assert.notEqual(utility.pid, process.pid);
        assert.notEqual(utility.pid, win.webContents.getOSProcessId());

        phase = "output pagination";
        const view = await evaluate(async () => {
            localStorage.setItem("agent_diff_max_lines", "0");
            const row = window.appendAgentToolMessageToUI({ toolId: "flood", toolName: "run_shell", status: "done", result: window.flood });
            const details = row.querySelector(".agent-full-output");
            details.open = true;
            await new Promise(resolve => setTimeout(resolve, 50));
            const first = details.querySelector(".agent-shell-output").textContent;
            details.querySelector(".agent-shell-output-pages button:last-child").click();
            return {
                firstLength: first.length,
                secondPage: details.querySelector(".agent-shell-output-pages span").textContent,
                lines: details.querySelectorAll(".agent-tool-preview-line").length,
                hasBrokenChar: /[\uD800-\uDFFF]/u.test(first)
            };
        });
        assert.ok(view.firstLength <= 8193);
        assert.match(view.secondPage, /^2 \/ /);
        assert.ok(view.lines <= 2);
        assert.equal(view.hasBrokenChar, false);

        phase = "plain command preview";
        const commandPreview = await evaluate(() => {
            const command = 'Write-Output "<tag>"\n  next line';
            const row = window.appendAgentToolMessageToUI({ toolId: "plain-text", toolName: "run_shell", status: "done",
                arguments: { command }, result: { stdout: "output" } });
            const preview = row.querySelector(".agent-command-preview");
            return ["light", "dark"].map(theme => {
                setTheme(theme, false);
                const style = getComputedStyle(preview);
                return { text: preview.textContent, nodes: preview.children.length, background: style.backgroundColor,
                    whitespace: style.whiteSpace, color: style.color };
            });
        });
        const previewText = { text: '$ Write-Output "<tag>"\n  next line', nodes: 0, background: "rgba(0, 0, 0, 0)", whitespace: "pre-wrap" };
        assert.deepEqual(commandPreview, ["rgb(39, 38, 36)", "rgb(231, 231, 231)"].map(color => ({ ...previewText, color })));

        phase = "foreground cancellation";
        const cancel = async (id, wait) => evaluate(async (id, command, wait) => {
            let off;
            const started = new Promise(resolve => { off = window.electronAPI.onAgentShellProgress(progress => {
                if (progress.executionId === id) resolve();
            }); });
            try {
                const result = window.electronAPI.executeAgentTool({
                    chatId: "shell-smoke", name: "run_shell", arguments: { command }, executionId: id
                });
                if (wait) await Promise.race([started, result.then(() => { throw new Error("The command ended before reporting progress"); })]);
                const cancel = await window.electronAPI.cancelAgentExecution(id);
                return { ...cancel, result: await result };
            } finally {
                off();
            }
        }, id, command(id), wait);
        for (const wait of [false, true]) {
            const cancelled = await cancel(wait ? "active" : "early", wait);
            assert.equal(cancelled.canceled, true);
            assert.equal(cancelled.result.cancelled, true);
        }

        phase = "background process";
        await start("background", "background");
        await waitForReady("background");
        assert.equal((await evaluate(() => window.electronAPI.listAgentProcesses())).processes[0].running, true);
        assert.equal((await tool("stop_process", { process_id: "background" })).stopped, true);

        phase = "app shutdown";
        await start("shutdown", "shutdown");
        const shutdownPid = await waitForReady("shutdown");
        const quitAt = Date.now();
        app.once("quit", () => {
            assert.ok(Date.now() - quitAt < 5000, "graceful shutdown should reap the shell before its deadline");
            assert.throws(() => process.kill(shutdownPid, 0), { code: "ESRCH" });
            for (const marker of ["early", "active", "background", "shutdown"]) {
                assert.equal(fs.existsSync(path.join(workspace, marker)), false);
            }
            console.log(JSON.stringify({ ok: true, bytes: flood.bytes, progressUpdates: flood.updates.length, mainTicks, rendererTicks: flood.ticks }));
        });
        app.quit();
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
        app.once("quit", () => app.exit(1));
        app.quit();
    }
});
