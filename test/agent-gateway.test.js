const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const net = require("net");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { AgentGateway, networkAddresses, sanitizeSnapshot } = require("../agent-gateway");

async function freePort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function fixture(t, onMessage) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiui-gateway-test-"));
    await fs.writeFile(path.join(directory, "index.html"), "<!doctype html><title>Remote control</title>");
    await fs.writeFile(path.join(directory, "app.js"), "console.log('remote');");
    await fs.writeFile(path.join(directory, "secret.json"), '{"key":"never-expose"}');
    const settingsPath = path.join(directory, "settings.json");
    const gateway = new AgentGateway({ settingsPath, assetsDir: directory, onMessage, getAdapters: async () => [] });
    await gateway.initialize();
    await gateway.configure({ host: "127.0.0.1", port: await freePort(), allowWrite: true });
    await gateway.start();
    t.after(async () => { await gateway.stop(); await fs.rm(directory, { recursive: true, force: true }); });
    const origin = `http://127.0.0.1:${gateway.config.port}`;
    const request = (route, { method = "GET", body, headers = {}, cookie = "", csrfToken = "" } = {}) => new Promise((resolve, reject) => {
        const data = method !== "POST" || body === undefined ? undefined : JSON.stringify(body);
        const req = http.request(origin + route, { method, headers: { ...(method === "POST" ? { Origin: origin, "Content-Type": "application/json" } : {}), ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrfToken ? { "X-Gateway-CSRF": csrfToken } : {}), ...headers } }, res => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", chunk => text += chunk);
            res.on("end", () => {
                let parsed;
                try { parsed = JSON.parse(text); } catch { parsed = text; }
                resolve({ status: res.statusCode, body: parsed, headers: res.headers, cookie: (res.headers["set-cookie"] || []).map(value => value.split(";")[0]).join("; ") });
            });
        });
        req.on("error", reject);
        req.end(data);
    });
    const login = async (role = "read", cookie = "") => {
        const result = await request("/api/login", { method: "POST", body: { code: gateway.credentials[`${role}Code`], deviceName: "测试手机" }, cookie });
        assert.equal(result.status, 200, JSON.stringify(result.body));
        return { ...result, responseHeaders: result.headers, headers: undefined, csrfToken: result.body.csrfToken };
    };
    return { gateway, directory, settingsPath, request, login };
}

function snapshot(overrides = {}) {
    return { chatId: "current-agent", title: "当前任务", agentEnabled: true, running: true, status: "running", activity: "搜索网页", messages: [{ id: "a", role: "assistant", content: "正在整理资料。" }], ...overrides };
}

test("physical adapters precede VPNs, virtual adapters and loopback; IPv6 is supported", () => {
    const entries = networkAddresses({
        "Radmin VPN": [{ family: "IPv4", address: "26.1.2.3", internal: false }],
        "VMware Network Adapter": [{ family: "IPv4", address: "192.168.88.1", internal: false }],
        "Wi-Fi": [{ family: "IPv6", address: "2001:db8::1", internal: false }, { family: "IPv4", address: "192.168.1.8", internal: false }],
        "Loopback": [{ family: "IPv4", address: "127.0.0.1", internal: true }]
    });
    assert.equal(entries[0].address, "192.168.1.8");
    assert.equal(entries[1].address, "2001:db8::1");
    assert(entries.find(item => item.address === "26.1.2.3").virtual);
    assert(entries.find(item => item.address === "0.0.0.0"));
    assert(entries.find(item => item.address === "::"));
});

test("default settings select a physical adapter and never start a server implicitly", async () => {
    const gateway = new AgentGateway({ getAdapters: async () => [], getInterfaces: () => ({ "VMware": [{ family: "IPv4", address: "192.168.8.1" }], "Ethernet": [{ family: "IPv4", address: "192.168.1.4" }] }) });
    const status = await gateway.initialize();
    assert.equal(status.running, false);
    assert.equal(status.config.host, "192.168.1.4");
    assert.equal(status.config.allowWrite, false);
    assert.notEqual(status.credentials.readCode, status.credentials.writeCode);
    assert(status.credentials.readCode.length >= 16);
});

test("Windows hardware metadata detects renamed virtual adapters and prioritizes physical hardware", async () => {
    const getInterfaces = () => ({
        "以太网 2": [{ family: "IPv4", address: "26.1.2.3", internal: false }],
        "以太网 3": [{ family: "IPv4", address: "192.168.88.1", internal: false }],
        "A 未知接口": [{ family: "IPv4", address: "192.168.44.1", internal: false }],
        "Wi-Fi": [{ family: "IPv4", address: "192.168.1.8", internal: false }]
    });
    const metadata = [
        { Name: "以太网 2", InterfaceDescription: "Famatech Radmin VPN Ethernet Adapter", HardwareInterface: true },
        { Name: "以太网 3", InterfaceDescription: "Custom network driver", HardwareInterface: false },
        { Name: "Wi-Fi", InterfaceDescription: "Intel(R) Wi-Fi 6 AX201", HardwareInterface: true }
    ];
    const addresses = networkAddresses(getInterfaces(), metadata);
    assert.equal(addresses[0].address, "192.168.1.8");
    assert.equal(addresses[0].physical, true);
    assert.equal(addresses.find(item => item.name === "以太网 2").virtual, true, "description still identifies a renamed Radmin adapter");
    assert.equal(addresses.find(item => item.name === "以太网 3").virtual, true, "non-hardware adapter is virtual despite an unrecognizable name");
    let reads = 0;
    const gateway = new AgentGateway({ getInterfaces, getAdapters: async () => { reads++; return metadata; } });
    await Promise.all([gateway.initialize(), gateway.initialize()]);
    assert.equal(gateway.config.host, "192.168.1.8");
    gateway.getStatus();
    gateway.getStatus();
    await gateway.configure({ pollIntervalMs: 1500 });
    assert.equal(reads, 1, "hardware enumeration is cached instead of spawning a shell for status calls");
});

test("unavailable hardware metadata falls back to name-based sorting", async () => {
    const gateway = new AgentGateway({ getAdapters: async () => { throw new Error("Get-NetAdapter unavailable"); },
        getInterfaces: () => ({ "Radmin VPN": [{ family: "IPv4", address: "26.1.2.3" }], "Wi-Fi": [{ family: "IPv4", address: "192.168.1.5" }] }) });
    assert.equal((await gateway.initialize()).config.host, "192.168.1.5");
});

test("only the dedicated remote assets are served, with restrictive browser headers", async t => {
    const { request } = await fixture(t);
    const page = await request("/");
    assert.equal(page.status, 200);
    assert.match(page.body, /Remote control/);
    assert.equal(page.headers["x-frame-options"], "DENY");
    assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert(!page.headers["content-security-policy"].includes("unsafe-inline"));
    assert(!page.headers["content-security-policy"].includes("unsafe-eval"));
    assert.equal((await request("/app.js")).status, 200);
    for (const file of ["marked.js", "dompurify.min.js"]) {
        const vendor = await request(`/${file}`);
        assert.equal(vendor.status, 200);
        assert.match(vendor.headers["content-type"], /^text\/javascript/);
        assert.equal(vendor.body, await fs.readFile(path.resolve(__dirname, "..", file), "utf8"));
    }
    for (const route of ["/secret.json", "/main.js", "/../secret.json", "/api/state", "/api/messages"]) {
        const result = await request(route);
        assert([401, 404].includes(result.status), route);
        assert(!JSON.stringify(result.body).includes("never-expose"));
    }
});

test("read users can poll sanitized current-session snapshots but cannot write", async t => {
    let calls = 0;
    const { gateway, request, login } = await fixture(t, async () => { calls++; });
    gateway.updateSnapshot(snapshot({ workspace: "C:/secret", apiKey: "private-key", messages: [
        { id: "a", role: "assistant", content: "输出", apiKey: "private-key" },
        { id: "b", role: "tool", content: "运行指令", kind: "tool", arguments: { command: "secret" }, result: "secret" }
    ] }));
    const auth = await login();
    assert.equal(auth.body.device.role, "read");
    assert.equal(auth.body.device.canWrite, false);
    assert.match(auth.responseHeaders["set-cookie"][0], /HttpOnly; SameSite=Strict/);
    const state = await request("/api/state", auth);
    assert.equal(state.status, 200);
    assert.equal(state.body.snapshot.chatId, "current-agent");
    assert.equal(state.body.snapshot.messages[1].content, "运行指令");
    assert(!JSON.stringify(state.body).includes("private-key"));
    assert(!JSON.stringify(state.body).includes("arguments"));
    const cached = await request(`/api/state?revision=${state.body.revision}`, auth);
    assert.equal(cached.body.unchanged, true);
    assert.equal(cached.body.snapshot, undefined);
    const denied = await request("/api/messages", { ...auth, method: "POST", body: { text: "继续", chatId: "current-agent", requestId: "request-0001" } });
    assert.equal(denied.status, 403);
    assert.equal(calls, 0);
});

test("writes require CSRF, the active Agent session, and a fresh desktop heartbeat", async t => {
    const calls = [];
    const { gateway, request, login } = await fixture(t, async message => { calls.push(message); return { queued: true }; });
    gateway.updateSnapshot(snapshot());
    const auth = await login("write");
    const body = { text: "继续下一步", chatId: "current-agent", requestId: "request-0001" };
    assert.equal((await request("/api/messages", { cookie: auth.cookie, method: "POST", body })).status, 403);
    assert.equal((await request("/api/messages", { ...auth, method: "POST", body: { ...body, chatId: "different" } })).status, 409);
    gateway.snapshotReceivedAt = Date.now() - 6000;
    assert.equal((await request("/api/messages", { ...auth, method: "POST", body })).status, 409);
    gateway.updateSnapshot(snapshot({ agentEnabled: false }));
    assert.equal((await request("/api/messages", { ...auth, method: "POST", body })).status, 409);
    gateway.updateSnapshot(snapshot());
    const sent = await request("/api/messages", { ...auth, method: "POST", body });
    assert.deepEqual(sent.body, { accepted: true, queued: true, requestId: body.requestId });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].device.name, "测试手机");
    assert.equal(calls[0].text, body.text);
    const chinese = "中".repeat(8000);
    const longChinese = await request("/api/messages", { ...auth, method: "POST", body: { ...body, text: chinese, requestId: "request-0002" } });
    assert.equal(longChinese.status, 200, "the byte limit must accommodate 8000 Chinese characters");
    assert.equal(calls[1].text, chinese);
});

test("concurrent retries append once, reuse the acknowledgement, and reject changed payloads", async t => {
    let calls = 0;
    let release;
    const { gateway, request, login } = await fixture(t, async () => { calls++; await new Promise(resolve => release = resolve); return { queued: false }; });
    gateway.updateSnapshot(snapshot());
    const auth = await login("write");
    const options = { ...auth, method: "POST", body: { text: "继续", chatId: "current-agent", requestId: "retry-request-1" } };
    const first = request("/api/messages", options);
    // Wait on the actual dispatch rather than a fixed race-prone delay.
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const second = request("/api/messages", options);
    release();
    const results = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.deepEqual(results[0].body, results[1].body);
    assert.equal((await request("/api/messages", { ...options, body: { ...options.body, text: "other" } })).status, 409);
});

test("desktop permission overrides and global write disable apply immediately", async t => {
    let calls = 0;
    const { gateway, request, login } = await fixture(t, async () => { calls++; });
    gateway.updateSnapshot(snapshot());
    const auth = await login("write");
    await gateway.configure({ allowWrite: false, pollIntervalMs: 2000 });
    let state = await request("/api/state", auth);
    assert.equal(state.body.device.canWrite, false);
    assert.equal(state.body.pollIntervalMs, 2000);
    await gateway.configure({ allowWrite: true });
    gateway.setDeviceRole(auth.body.device.id, "read");
    state = await request("/api/state", auth);
    assert.equal(state.body.device.role, "read");
    const reauth = await login("write", auth.cookie);
    assert.equal(reauth.body.device.role, "read", "re-entering a write code cannot undo desktop's per-device restriction");
    assert.equal((await request("/api/messages", { ...reauth, method: "POST", body: { text: "continue", chatId: "current-agent", requestId: "restrict-01" } })).status, 403);
    assert.equal(calls, 0);
});

test("revocation during a partially uploaded message prevents desktop dispatch", async t => {
    const scenarios = [
        { name: "kick", status: 401, revoke: (gateway, id) => gateway.kickDevice(id) },
        { name: "disable writes", status: 403, revoke: gateway => gateway.configure({ allowWrite: false }) },
        { name: "rotate credentials", status: 401, revoke: gateway => gateway.rotateCredentials() },
        { name: "downgrade role", status: 403, revoke: (gateway, id) => gateway.setDeviceRole(id, "read") }
    ];
    for (const scenario of scenarios) await t.test(scenario.name, async subtest => {
        let calls = 0;
        const { gateway, login } = await fixture(subtest, async () => { calls++; return { accepted: true }; });
        gateway.updateSnapshot(snapshot());
        const auth = await login("write");
        let signalBodyStarted;
        const bodyStarted = new Promise(resolve => { signalBodyStarted = resolve; });
        const originalReadBody = gateway._readBody.bind(gateway);
        gateway._readBody = request => {
            if (request.url === "/api/messages") signalBodyStarted();
            return originalReadBody(request);
        };
        const origin = `http://127.0.0.1:${gateway.config.port}`;
        const body = JSON.stringify({ text: "继续", chatId: "current-agent", requestId: "slow-request-01" });
        let request;
        const result = new Promise((resolve, reject) => {
            request = http.request(origin + "/api/messages", { method: "POST", headers: {
                Origin: origin, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
                Cookie: auth.cookie, "X-Gateway-CSRF": auth.csrfToken
            } }, response => {
                let text = "";
                response.setEncoding("utf8");
                response.on("data", chunk => { text += chunk; });
                response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
            });
            request.on("error", reject);
            request.write(body.slice(0, 10));
        });
        await bodyStarted;
        await scenario.revoke(gateway, auth.body.device.id);
        request.end(body.slice(10));
        const response = await result;
        assert.equal(response.status, scenario.status, JSON.stringify(response.body));
        assert.equal(calls, 0, "an upload begun before revocation must not be dispatched afterward");
        assert.equal(gateway.messageRequests.size, 0);
    });
});

test("kicking revokes a device and blocks its reauthentication until desktop unblocks it", async t => {
    const { gateway, request, login } = await fixture(t);
    const auth = await login();
    const id = auth.body.device.id;
    gateway.kickDevice(id);
    const kicked = await request("/api/state", auth);
    assert.equal(kicked.status, 401);
    assert.match(kicked.body.error, /强制下线/);
    const blocked = await request("/api/login", { method: "POST", cookie: auth.cookie, body: { code: gateway.credentials.readCode } });
    assert.equal(blocked.status, 403);
    assert.equal(gateway.getStatus().devices.find(device => device.id === id).blocked, true);
    gateway.unblockDevice(id);
    const returned = await login("read", auth.cookie);
    assert.equal(returned.body.device.id, id);
    assert.equal((await request("/api/state", returned)).status, 200);
});

test("cross-origin requests, DNS rebinding hosts and oversized bodies are rejected", async t => {
    const { request, login, gateway } = await fixture(t);
    const auth = await login("write");
    assert.equal((await request("/api/login", { method: "POST", headers: { Origin: "http://evil.example" }, body: { code: gateway.credentials.readCode } })).status, 403);
    assert.equal((await request("/api/session", { headers: { Host: `evil.example:${gateway.config.port}` } })).status, 403);
    assert.equal((await request("/api/session", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await request("/api/login", { method: "POST", body: { code: "x".repeat(80000) } })).status, 413);
    assert.equal((await request("/api/messages", { ...auth, method: "POST", body: { text: "x".repeat(8001), chatId: "current-agent", requestId: "too-large-1" } })).status, 400);
});

test("failed authentication is rate limited without admitting a session", async t => {
    const { request } = await fixture(t);
    for (let attempt = 0; attempt < 8; attempt++) assert.equal((await request("/api/login", { method: "POST", body: { code: "wrong" } })).status, 401);
    assert.equal((await request("/api/login", { method: "POST", body: { code: "wrong" } })).status, 429);
    assert.equal((await request("/api/session")).body.authenticated, false);
});

test("connection limits, credential rotation, logout and server restart invalidate sessions", async t => {
    const { gateway, request, login } = await fixture(t);
    await gateway.configure({ maxDevices: 1 });
    const first = await login();
    assert.equal((await request("/api/login", { method: "POST", body: { code: gateway.credentials.readCode } })).status, 429);
    assert.equal((await request("/api/logout", { ...first, method: "POST" })).status, 200);
    assert.equal((await request("/api/state", first)).status, 401);
    const second = await login();
    const previousCode = gateway.credentials.readCode;
    gateway.rotateCredentials();
    assert.notEqual(gateway.credentials.readCode, previousCode);
    assert.equal((await request("/api/state", second)).status, 401);
    const third = await login();
    await gateway.stop();
    assert.equal(gateway.getStatus().running, false);
    await gateway.start();
    assert.equal((await request("/api/state", third)).status, 401);
});

test("settings persist without access secrets and binding changes require a stopped gateway", async t => {
    const { gateway, settingsPath } = await fixture(t);
    await assert.rejects(gateway.configure({ port: await freePort() }), /先关闭/);
    await assert.rejects(gateway.configure({ pollIntervalMs: 3000 }), /pollIntervalMs/);
    await assert.rejects(gateway.configure({ host: "example.com" }), /IP/);
    await gateway.configure({ pollIntervalMs: 750, allowWrite: false });
    const saved = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    assert.equal(saved.pollIntervalMs, 750);
    assert.equal(saved.allowWrite, false);
    assert(!JSON.stringify(saved).includes(gateway.credentials.readCode));
    const restored = new AgentGateway({ settingsPath, getAdapters: async () => [] });
    await restored.initialize();
    assert.equal(restored.config.pollIntervalMs, 750);
    assert.equal(restored.getStatus().running, false);
    assert.notEqual(restored.credentials.readCode, gateway.credentials.readCode);
});

test("snapshot projection preserves complete long answers and every historical tool step", () => {
    assert.equal(sanitizeSnapshot(null).agentEnabled, false);
    const longAnswer = "完整回复。".repeat(12000) + "回复末尾不能丢失。";
    const result = sanitizeSnapshot(snapshot({ secret: "hidden", messages: [
        { role: "system", content: "system instructions" },
        { id: "long-answer", role: "assistant", kind: "message", content: longAnswer, raw: "hidden" },
        ...Array.from({ length: 300 }, (_, index) => ({ id: String(index), role: "tool", kind: "tool", content: `工具步骤 ${index}`, toolName: "read_file", detail: "读取文件", status: "done", raw: "hidden", arguments: { secret: true }, result: "private" }))
    ] }));
    assert.equal(result.messages.length, 301);
    assert.equal(result.messages[0].content, longAnswer);
    assert.equal(result.messages[1].id, "0");
    assert.equal(result.messages.at(-1).id, "299");
    assert(result.messages.every(message => !message.raw && !message.arguments && !message.result));
    assert.equal(result.secret, undefined);
});

test("snapshot projection preserves safe thinking and tool summary fields only", () => {
    const result = sanitizeSnapshot(snapshot({ messages: [
        { id: "thinking", role: "assistant", kind: "thinking", content: "首行\n摘要\n尾行", status: "done", durationMs: 1234, omittedLines: 80, rawReasoning: "private" },
        { id: "tool", role: "tool", kind: "tool", content: "执行工具", toolName: "x".repeat(150), detail: "d".repeat(500), status: "running", durationMs: 90, arguments: { command: "secret" } },
        { id: "bounded-thinking", role: "thinking", kind: "thinking", content: "HEAD" + "x".repeat(20000) + "TAIL", durationMs: -1, omittedLines: -10 },
        { id: "unknown-fields", role: "assistant", kind: "unknown", content: "正文", status: "<script>", durationMs: Infinity, omittedLines: NaN }
    ] }));
    assert.deepEqual(result.messages[0], { id: "thinking", role: "assistant", kind: "thinking", content: "首行\n摘要\n尾行", status: "done", durationMs: 1234, omittedLines: 80 });
    assert.equal(result.messages[1].toolName.length, 100);
    assert.equal(result.messages[1].detail.length, 240);
    assert.equal(result.messages[1].status, "running");
    assert.equal(result.messages[1].arguments, undefined);
    assert(result.messages[2].content.length <= 12000);
    assert(result.messages[2].content.startsWith("HEAD"));
    assert(result.messages[2].content.endsWith("TAIL"));
    assert.match(result.messages[2].content, /已省略中间部分/);
    assert.equal(result.messages[2].durationMs, 0);
    assert.equal(result.messages[2].omittedLines, 0);
    assert.equal(result.messages[3].kind, "message");
    assert.equal(result.messages[3].status, "");
    assert.equal(result.messages[3].durationMs, undefined);
    assert.equal(result.messages[3].omittedLines, undefined);
});
