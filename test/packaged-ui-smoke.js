"use strict";

// Check the actual packaged app with an isolated profile through Chromium CDP.
const assert = require("node:assert/strict");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exe = path.resolve(__dirname, "../dist/win-unpacked/AIUI.exe");
const artifacts = path.join(os.tmpdir(), "aiui-packaged-ui-" + process.pid);
const profile = path.join(artifacts, "profile");

async function freePort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}
async function until(callback, label) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        const value = await callback().catch(() => null);
        if (value) return value;
        await sleep(150);
    }
    throw new Error("Timed out: " + label);
}
async function targets(port) {
    const response = await fetch("http://127.0.0.1:" + port + "/json/list", { signal: AbortSignal.timeout(1000) });
    assert.equal(response.ok, true);
    return response.json();
}
async function connect(target) {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
    });
    let id = 0;
    const pending = new Map();
    socket.addEventListener("message", event => {
        const message = JSON.parse(event.data);
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
    });
    return {
        send(method, params = {}) {
            return new Promise((resolve, reject) => {
                const requestId = ++id;
                pending.set(requestId, { resolve, reject });
                socket.send(JSON.stringify({ id: requestId, method, params }));
            });
        },
        close() { socket.close(); }
    };
}
async function evaluate(cdp, expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
}
async function capture(cdp, file) {
    const result = await cdp.send("Page.captureScreenshot", { format: "png" });
    const output = path.join(artifacts, file);
    await fs.writeFile(output, Buffer.from(result.data, "base64"));
    return output;
}

(async () => {
    await fs.access(exe);
    await fs.mkdir(profile, { recursive: true });
    const port = await freePort();
    const child = spawn(exe, ["--user-data-dir=" + profile, "--remote-debugging-port=" + port, "--disable-gpu"], { stdio: "ignore", windowsHide: true });
    const connections = [];
    try {
        const main = await until(async () => (await targets(port)).find(target => target.url.endsWith("/index.html")), "packaged main window");
        const mainCdp = await connect(main);
        connections.push(mainCdp);
        await until(() => evaluate(mainCdp, "(() => { const b = document.getElementById('agent-gateway-btn'); return b && !b.hidden && getComputedStyle(b).display !== 'none'; })()"), "packaged gateway button");
        const mainImage = await capture(mainCdp, "packaged-main.png");
        await evaluate(mainCdp, "document.getElementById('agent-gateway-btn').click()");
        const gateway = await until(async () => (await targets(port)).find(target => target.url.endsWith("/gateway-console.html")), "separate gateway window");
        assert.notEqual(gateway.id, main.id);
        const gatewayCdp = await connect(gateway);
        connections.push(gatewayCdp);
        await until(() => evaluate(gatewayCdp, "document.body.innerText.includes('Agent 网关')"), "packaged gateway UI");
        const gatewayImage = await capture(gatewayCdp, "packaged-gateway.png");
        console.log(JSON.stringify({ passed: true, screenshots: [mainImage, gatewayImage] }, null, 2));
    } finally {
        for (const connection of connections) connection.close();
        if (child.pid) {
            try { await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"]); }
            catch { child.kill(); }
        }
        if (profile.startsWith(artifacts + path.sep)) {
            for (let attempt = 0; attempt < 20; attempt++) {
                try { await fs.rm(profile, { recursive: true, force: true }); break; }
                catch (error) {
                    if (attempt === 19 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code)) throw error;
                    await sleep(250);
                }
            }
        }
    }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
