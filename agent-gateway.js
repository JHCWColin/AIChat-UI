const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const net = require("net");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const VIRTUAL_INTERFACE = /radmin|vmware|virtual|vbox|vpn|tap|tun\d|tailscale|zerotier|wireguard|hyper-v|vethernet|docker|wsl|loopback|模拟|虚拟/i;
const ASSETS = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/index.html", ["index.html", "text/html; charset=utf-8"]],
    ["/style.css", ["style.css", "text/css; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/marked.js", [path.resolve(__dirname, "marked.js"), "text/javascript; charset=utf-8"]],
    ["/dompurify.min.js", [path.resolve(__dirname, "dompurify.min.js"), "text/javascript; charset=utf-8"]]
]);
// Keep a transport cap independently of the 8000-character message limit.
const MAX_BODY_BYTES = 64 * 1024;
const SESSION_COOKIE = "aiui_gateway_session";
const DEVICE_COOKIE = "aiui_gateway_device";
const DEFAULT_CONFIG = Object.freeze({ host: "", port: 18789, pollIntervalMs: 1000, sessionTtlMinutes: 480, maxDevices: 12, allowWrite: false });

async function loadAdapterMetadata() {
    if (process.platform !== "win32") return [];
    try {
        const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()\nGet-NetAdapter -IncludeHidden | Select-Object Name,InterfaceDescription,HardwareInterface | ConvertTo-Json -Compress"],
        { timeout: 3000, windowsHide: true, maxBuffer: 256 * 1024, encoding: "utf8" });
        const result = JSON.parse(stdout.trim().replace(/^\uFEFF/, ""));
        return Array.isArray(result) ? result : result ? [result] : [];
    } catch {
        // Old Windows, missing NetAdapter module, or restricted shells retain name-based detection.
        return [];
    }
}

function networkAddresses(interfaces = os.networkInterfaces(), metadata = []) {
    const adapters = new Map((Array.isArray(metadata) ? metadata : []).filter(item => item && typeof item.Name === "string").map(item => [item.Name.toLocaleLowerCase("en-US"), item]));
    const addresses = [];
    for (const [name, entries] of Object.entries(interfaces)) {
        const adapter = adapters.get(name.toLocaleLowerCase("en-US"));
        const description = typeof adapter?.InterfaceDescription === "string" ? adapter.InterfaceDescription : "";
        const virtual = adapter?.HardwareInterface === false || VIRTUAL_INTERFACE.test(`${name} ${description}`);
        const physical = adapter?.HardwareInterface === true && !virtual;
        for (const entry of entries || []) {
            const family = entry.family === 4 || entry.family === "IPv4" ? "IPv4" : "IPv6";
            if (!net.isIP(entry.address)) continue;
            // Link-local IPv6 needs a zone ID and is not a usable, portable browser URL.
            if (family === "IPv6" && /^fe80:/i.test(entry.address)) continue;
            addresses.push({ name, address: entry.address, family, internal: Boolean(entry.internal), virtual, physical, description,
                label: `${name} · ${entry.address}${virtual ? "（虚拟 / VPN）" : entry.internal ? "（仅本机）" : ""}` });
        }
    }
    addresses.sort((a, b) => {
        const score = item => (item.internal ? 100 : 0) + (item.virtual ? 20 : 0) - (item.physical ? 10 : 0) + (item.family === "IPv6" ? 5 : 0);
        return score(a) - score(b) || a.name.localeCompare(b.name) || a.address.localeCompare(b.address);
    });
    if (!addresses.some(item => item.address === "127.0.0.1")) addresses.push({ name: "Loopback", address: "127.0.0.1", family: "IPv4", internal: true, virtual: false, label: "仅本机 · 127.0.0.1" });
    addresses.push({ name: "所有 IPv4 网卡", address: "0.0.0.0", family: "IPv4", internal: false, virtual: false, label: "所有 IPv4 网卡 · 0.0.0.0" });
    addresses.push({ name: "所有 IPv6 网卡", address: "::", family: "IPv6", internal: false, virtual: false, label: "所有 IPv6 网卡 · ::" });
    return addresses;
}

function limitedText(value, max) { return typeof value === "string" ? value.slice(0, max) : ""; }
function makeCode() { return crypto.randomBytes(12).toString("base64url"); }
function secretEqual(a, b) {
    const hash = value => crypto.createHash("sha256").update(String(value)).digest();
    return crypto.timingSafeEqual(hash(a), hash(b));
}
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
function parseCookies(header) {
    const cookies = {};
    for (const part of String(header || "").split(";")) {
        const index = part.indexOf("=");
        if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return cookies;
}
function normalizeIP(address) { return String(address || "").replace(/^::ffff:/, ""); }
function urlHost(host) { return net.isIP(host) === 6 ? `[${host}]` : host; }

function sanitizeSnapshot(input = {}) {
    if (!input || typeof input !== "object") input = {};
    const messages = [];
    // Snapshots originate from the trusted desktop renderer. Keep the complete
    // projected conversation: remote users must not silently lose older steps
    // or the end of a long answer. Only thinking is intentionally summarized.
    const source = Array.isArray(input.messages) ? input.messages : [];
    for (let i = 0; i < source.length; i++) {
        const message = source[i];
        if (!message || !["user", "assistant", "activity", "tool", "thinking"].includes(message.role)) continue;
        const kind = ["message", "tool", "thinking"].includes(message.kind) ? message.kind
            : message.role === "tool" ? "tool" : message.role === "thinking" ? "thinking" : "message";
        const rawContent = typeof message.content === "string" ? message.content : "";
        const content = kind === "thinking" && rawContent.length > 12000
            ? rawContent.slice(0, 5900) + "\n…（思考摘要过长，已省略中间部分）…\n" + rawContent.slice(-5900)
            : rawContent;
        const projected = { id: limitedText(String(message.id ?? i), 100), role: message.role, content, kind,
            status: ["running", "done", "error"].includes(message.status) ? message.status : "" };
        if (typeof message.toolName === "string") projected.toolName = limitedText(message.toolName, 100);
        if (typeof message.detail === "string") projected.detail = limitedText(message.detail, 240);
        if (Number.isFinite(message.durationMs)) projected.durationMs = Math.max(0, message.durationMs);
        if (Number.isFinite(message.omittedLines)) projected.omittedLines = Math.max(0, Math.floor(message.omittedLines));
        messages.push(projected);
    }
    return { chatId: limitedText(input.chatId, 160), title: limitedText(input.title, 180),
        agentEnabled: input.agentEnabled === true, running: input.running === true,
        status: limitedText(input.status, 120), activity: limitedText(input.activity, 300), messages,
        queuedCount: Math.max(0, Math.min(1000, Number(input.queuedCount) || 0)), updatedAt: Date.now() };
}

class AgentGateway extends EventEmitter {
    constructor({ settingsPath, assetsDir = path.join(__dirname, "remote-control"), onMessage = async () => { throw new Error("桌面会话尚未就绪"); }, getInterfaces = () => os.networkInterfaces(), getAdapters = loadAdapterMetadata } = {}) {
        super();
        this.settingsPath = settingsPath;
        this.assetsDir = assetsDir;
        this.onMessage = onMessage;
        this.getInterfaces = getInterfaces;
        this.getAdapters = getAdapters;
        this.adapterMetadata = [];
        this.config = { ...DEFAULT_CONFIG };
        this.credentials = { readCode: makeCode(), writeCode: makeCode() };
        this.server = null;
        this.startedAt = null;
        this.lastError = "";
        this.revision = 0;
        this.snapshot = sanitizeSnapshot();
        this.snapshotReceivedAt = 0;
        this.devices = new Map();
        this.sessions = new Map();
        this.loginAttempts = new Map();
        this.messageRequests = new Map();
        this.sockets = new Set();
        this.inflight = 0;
        this._operations = Promise.resolve();
        this._initialize = null;
        this._statusTimer = null;
    }

    initialize() {
        if (!this._initialize) this._initialize = this._loadSettings();
        return this._initialize;
    }

    async _loadSettings() {
        // Cache hardware metadata once; frequent status/poll requests only enumerate IPs.
        try { this.adapterMetadata = await this.getAdapters(); } catch { this.adapterMetadata = []; }
        const interfaces = this._interfaces();
        this.config.host = interfaces.find(item => !["0.0.0.0", "::"].includes(item.address))?.address || "127.0.0.1";
        if (this.settingsPath) {
            try {
                const saved = JSON.parse(await fs.readFile(this.settingsPath, "utf8"));
                this.config = this._validateConfig({ ...this.config, ...saved });
                if (!interfaces.some(item => item.address === this.config.host)) this.config.host = interfaces[0]?.address || "127.0.0.1";
            } catch (error) {
                if (error.code !== "ENOENT") this.lastError = "网关设置无效，已使用默认配置：" + error.message;
            }
        }
        return this.getStatus();
    }

    _interfaces() { return networkAddresses(this.getInterfaces(), this.adapterMetadata); }
    _queue(operation) {
        const result = this._operations.then(operation);
        this._operations = result.catch(() => {});
        return result;
    }

    _validateConfig(config) {
        const normalized = {};
        if (typeof config.host !== "string" || !net.isIP(config.host)) throw new Error("请选择有效的本机 IP 地址");
        normalized.host = config.host;
        for (const [key, min, max] of [["port", 1, 65535], ["pollIntervalMs", 500, 2000], ["sessionTtlMinutes", 5, 10080], ["maxDevices", 1, 64]]) {
            const number = Number(config[key]);
            if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${key} 必须为 ${min}–${max} 之间的整数`);
            normalized[key] = number;
        }
        normalized.allowWrite = config.allowWrite === true;
        return normalized;
    }

    configure(patch = {}) {
        return this._queue(async () => {
            await this.initialize();
            const config = this._validateConfig({ ...this.config, ...patch });
            if (this.server && (config.host !== this.config.host || config.port !== this.config.port)) throw new Error("请先关闭网关，再修改监听地址或端口");
            if (!this._interfaces().some(item => item.address === config.host)) throw new Error("该 IP 不属于当前设备，请刷新网卡列表");
            if (this.settingsPath) {
                await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
                const tempPath = this.settingsPath + ".tmp";
                await fs.writeFile(tempPath, JSON.stringify(config, null, 2), { mode: 0o600 });
                await fs.rename(tempPath, this.settingsPath);
            }
            this.config = config;
            this._emitStatus();
            return this.getStatus();
        });
    }

    start() {
        return this._queue(async () => {
            await this.initialize();
            if (this.server) return this.getStatus();
            if (!this._interfaces().some(item => item.address === this.config.host)) throw new Error("监听 IP 已不可用，请重新选择网卡");
            const server = http.createServer((request, response) => this._handleRequest(request, response));
            server.requestTimeout = 15000;
            server.headersTimeout = 10000;
            server.keepAliveTimeout = 3000;
            server.maxHeadersCount = 48;
            server.on("connection", socket => {
                if (this.sockets.size >= 128) { socket.destroy(); return; }
                this.sockets.add(socket);
                socket.on("close", () => this.sockets.delete(socket));
            });
            server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
            try {
                await new Promise((resolve, reject) => {
                    const failed = error => { server.off("listening", ready); reject(error); };
                    const ready = () => { server.off("error", failed); resolve(); };
                    server.once("error", failed);
                    server.once("listening", ready);
                    server.listen({ host: this.config.host, port: this.config.port, ipv6Only: this.config.host.includes(":") });
                });
            } catch (error) {
                this.lastError = error.code === "EADDRINUSE" ? "端口已被占用，请选择其他端口" : `网关启动失败：${error.message}`;
                this._emitStatus();
                throw new Error(this.lastError);
            }
            server.on("error", error => { this.lastError = error.message; this._emitStatus(); });
            this.server = server;
            this.startedAt = Date.now();
            this.lastError = "";
            this._statusTimer = setInterval(() => { this._prune(); this._emitStatus(); }, 5000);
            this._statusTimer.unref?.();
            this._emitStatus();
            return this.getStatus();
        });
    }

    stop() {
        return this._queue(async () => {
            clearInterval(this._statusTimer);
            this._statusTimer = null;
            const server = this.server;
            this.server = null;
            this.sessions.clear();
            this.messageRequests.clear();
            for (const device of this.devices.values()) device.lastSeenAt = 0;
            if (server) {
                const closed = new Promise(resolve => server.close(resolve));
                for (const socket of this.sockets) socket.destroy();
                await closed;
            }
            this.startedAt = null;
            this._emitStatus();
            return this.getStatus();
        });
    }

    updateSnapshot(input) {
        const next = sanitizeSnapshot(input);
        this.snapshotReceivedAt = Date.now();
        const comparable = item => JSON.stringify({ ...item, updatedAt: 0 });
        if (comparable(next) !== comparable(this.snapshot)) { this.snapshot = next; this.revision++; }
        else this.snapshot.updatedAt = next.updatedAt;
    }

    getStatus() {
        const interfaces = this._interfaces();
        const host = this.config.host;
        const addresses = ["0.0.0.0", "::"].includes(host)
            ? interfaces.filter(item => !["0.0.0.0", "::"].includes(item.address) && item.family === (host === "::" ? "IPv6" : "IPv4")).map(item => item.address)
            : [host];
        return { running: Boolean(this.server), config: { ...this.config }, interfaces,
            urls: this.server ? addresses.map(address => `http://${urlHost(address)}:${this.config.port}`) : [],
            devices: [...this.devices.values()].map(device => ({ id: device.id, name: device.name, role: device.role, ip: device.ip, blocked: device.blocked, connectedAt: device.connectedAt, lastSeenAt: device.lastSeenAt, online: !device.blocked && Date.now() - device.lastSeenAt < 10000 && [...this.sessions.values()].some(session => session.deviceId === device.id && session.expiresAt > Date.now()) })),
            credentials: { ...this.credentials }, snapshot: this.snapshot, revision: this.revision, error: this.lastError, startedAt: this.startedAt };
    }

    kickDevice(id) {
        const device = this.devices.get(id);
        if (!device) throw new Error("设备不存在");
        device.blocked = true;
        for (const [token, session] of this.sessions) if (session.deviceId === id) this.sessions.delete(token);
        this._emitStatus();
        return this.getStatus();
    }

    unblockDevice(id) {
        const device = this.devices.get(id);
        if (!device) throw new Error("设备不存在");
        device.blocked = false;
        this._emitStatus();
        return this.getStatus();
    }

    setDeviceRole(id, role) {
        if (!["read", "write"].includes(role)) throw new Error("无效的设备权限");
        const device = this.devices.get(id);
        if (!device || device.blocked) throw new Error("设备不存在或已被强制下线");
        device.role = role;
        device.roleOverride = role;
        this._emitStatus();
        return this.getStatus();
    }

    rotateCredentials() {
        this.credentials = { readCode: makeCode(), writeCode: makeCode() };
        this.sessions.clear();
        this.messageRequests.clear();
        this._emitStatus();
        return this.getStatus();
    }

    _emitStatus() { this.emit("status", this.getStatus()); }
    _deviceView(device) { return { id: device.id, name: device.name, role: device.role, canWrite: device.role === "write" && this.config.allowWrite }; }
    _prune() {
        const now = Date.now();
        for (const [token, session] of this.sessions) if (session.expiresAt < now || !this.devices.has(session.deviceId)) this.sessions.delete(token);
        for (const [ip, rate] of this.loginAttempts) if (rate.resetAt < now) this.loginAttempts.delete(ip);
        for (const [key, request] of this.messageRequests) if (request.expiresAt < now) this.messageRequests.delete(key);
        if (this.devices.size > 256) for (const [id, device] of this.devices) {
            if (!device.blocked && ![...this.sessions.values()].some(session => session.deviceId === id)) this.devices.delete(id);
            if (this.devices.size <= 256) break;
        }
    }

    _checkHost(request) {
        let parsed;
        try { parsed = new URL(`http://${request.headers.host}`); } catch { throw httpError(403, "无效的网关地址"); }
        if (parsed.username || parsed.password || parsed.pathname !== "/") throw httpError(403, "无效的网关地址");
        const host = parsed.hostname.replace(/^\[|\]$/g, "");
        const port = parsed.port || "80";
        const wildcard = ["0.0.0.0", "::"].includes(this.config.host);
        const allowed = new Set(wildcard ? this._interfaces().filter(item => !["0.0.0.0", "::"].includes(item.address) && item.family === (this.config.host === "::" ? "IPv6" : "IPv4")).map(item => item.address) : [this.config.host]);
        if (allowed.has("127.0.0.1") || allowed.has("::1")) allowed.add("localhost");
        if (!allowed.has(host) || Number(port) !== this.config.port) throw httpError(403, "请通过本机 IP 和网关端口访问");
        if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) throw httpError(403, "禁止跨来源访问网关");
        if (request.headers["sec-fetch-site"] === "cross-site") throw httpError(403, "禁止跨站访问网关");
        if (request.method === "POST" && request.headers.origin !== `http://${request.headers.host}`) throw httpError(403, "请求缺少有效的同源验证");
    }

    _session(request, optional = false) {
        const cookies = parseCookies(request.headers.cookie);
        const token = cookies[SESSION_COOKIE];
        const session = token && this.sessions.get(token);
        const device = session && this.devices.get(session.deviceId);
        if (!session || !device || device.blocked || session.expiresAt <= Date.now() || cookies[DEVICE_COOKIE] !== device.id) {
            if (token) this.sessions.delete(token);
            if (optional) return null;
            const knownDevice = device || this.devices.get(cookies[DEVICE_COOKIE]);
            throw httpError(401, knownDevice?.blocked ? "设备已被桌面端强制下线" : "连接已过期，请重新验证");
        }
        device.lastSeenAt = Date.now();
        return { session, device, token };
    }

    async _readBody(request) {
        if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers["content-type"] || ""))) throw httpError(415, "请使用 JSON 请求");
        if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) throw httpError(413, "请求内容过大");
        let length = 0;
        const chunks = [];
        for await (const chunk of request) {
            length += chunk.length;
            if (length > MAX_BODY_BYTES) throw httpError(413, "请求内容过大");
            chunks.push(chunk);
        }
        try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
            return body;
        } catch { throw httpError(400, "请求 JSON 无效"); }
    }

    _json(response, status, data, headers = {}) {
        response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
        response.end(JSON.stringify(data));
    }

    async _login(request, response) {
        const ip = normalizeIP(request.socket.remoteAddress);
        const now = Date.now();
        this._prune();
        let rate = this.loginAttempts.get(ip);
        if (!rate || rate.resetAt <= now) { rate = { count: 0, resetAt: now + 60000 }; this.loginAttempts.set(ip, rate); }
        if (rate.count >= 8) throw httpError(429, "验证尝试过多，请稍后重试");
        if (this.loginAttempts.size > 1000) throw httpError(429, "网关繁忙，请稍后重试");
        const body = await this._readBody(request);
        const code = limitedText(body.code, 256);
        const role = secretEqual(code, this.credentials.writeCode) ? "write" : secretEqual(code, this.credentials.readCode) ? "read" : "";
        if (!role) { rate.count++; throw httpError(401, "访问码无效"); }
        const cookies = parseCookies(request.headers.cookie);
        const previous = this.devices.get(cookies[DEVICE_COOKIE]);
        if (previous?.blocked) throw httpError(403, "设备已被桌面端强制下线，请先由桌面端解除限制");
        const activeDevices = new Set([...this.sessions.values()].filter(session => session.expiresAt > now).map(session => session.deviceId));
        if (activeDevices.size >= this.config.maxDevices && !activeDevices.has(previous?.id)) throw httpError(429, "网关已达到连接设备数量上限");
        const device = previous || { id: crypto.randomBytes(24).toString("base64url"), connectedAt: now, blocked: false };
        device.name = limitedText(body.deviceName, 60).trim() || "远程浏览器";
        device.role = device.roleOverride || role;
        device.ip = ip;
        device.lastSeenAt = now;
        this.devices.set(device.id, device);
        for (const [token, session] of this.sessions) if (session.deviceId === device.id) this.sessions.delete(token);
        const token = crypto.randomBytes(32).toString("base64url");
        const session = { deviceId: device.id, csrfToken: crypto.randomBytes(24).toString("base64url"), expiresAt: now + this.config.sessionTtlMinutes * 60000 };
        this.sessions.set(token, session);
        this._emitStatus();
        this._json(response, 200, { authenticated: true, device: this._deviceView(device), csrfToken: session.csrfToken, pollIntervalMs: this.config.pollIntervalMs }, {
            "Set-Cookie": [`${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${this.config.sessionTtlMinutes * 60}`,
                `${DEVICE_COOKIE}=${device.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`]
        });
    }

    _writeSession(request) {
        const auth = this._session(request);
        if (!secretEqual(request.headers["x-gateway-csrf"] || "", auth.session.csrfToken)) throw httpError(403, "安全验证无效，请刷新页面");
        if (!this._deviceView(auth.device).canWrite) throw httpError(403, "此设备仅有只读权限");
        return auth;
    }

    async _sendMessage(request, response) {
        this._writeSession(request);
        const body = await this._readBody(request);
        // Uploading a body yields to desktop controls. Revocation, credential rotation,
        // permission changes and expiry must be checked again before any dispatch.
        const { device } = this._writeSession(request);
        if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 8000) throw httpError(400, "消息须为 1–8000 个字符");
        if (typeof body.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.requestId)) throw httpError(400, "无效的消息请求标识");
        const key = `${device.id}:${body.requestId}`;
        const previous = this.messageRequests.get(key);
        if (previous) {
            if (previous.text !== body.text || previous.chatId !== body.chatId) throw httpError(409, "请求标识已用于其他消息");
            const result = await previous.promise;
            this._json(response, 200, result);
            return;
        }
        if (!this.snapshot.chatId || !this.snapshot.agentEnabled || body.chatId !== this.snapshot.chatId) throw httpError(409, "当前激活会话已改变，或未启用 Agent，请刷新后重试");
        if (!this.snapshotReceivedAt || Date.now() - this.snapshotReceivedAt > 5000) throw httpError(409, "桌面会话暂未响应，请稍后重试");
        if (this.messageRequests.size >= 2000) throw httpError(429, "消息请求过多，请稍后重试");
        device.messageTimes = (device.messageTimes || []).filter(time => Date.now() - time < 60000);
        if (device.messageTimes.length >= 20) throw httpError(429, "发送过于频繁，请稍后重试");
        device.messageTimes.push(Date.now());
        // Reserve the id before dispatch so concurrent retries cannot append twice.
        const record = { text: body.text, chatId: body.chatId, expiresAt: Date.now() + 60 * 60000 };
        record.promise = Promise.resolve().then(() => this.onMessage({ text: body.text, chatId: body.chatId, requestId: body.requestId, device: this._deviceView(device) })).then(result => {
            if (result?.accepted === false || result?.error) throw httpError(409, limitedText(result.error, 300) || "桌面端未接受消息");
            return { accepted: true, queued: Boolean(result?.queued), requestId: body.requestId };
        });
        this.messageRequests.set(key, record);
        try { this._json(response, 200, await record.promise); }
        catch (error) {
            // Keep failures as well: an acknowledgement can be lost after desktop acceptance.
            throw error;
        }
    }

    async _handleRequest(request, response) {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("X-Frame-Options", "DENY");
        response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        this.inflight++;
        try {
            if (this.inflight > 32) throw httpError(503, "网关繁忙，请稍后重试");
            this._checkHost(request);
            const url = new URL(request.url, `http://${request.headers.host}`);
            if (request.method === "GET" && ASSETS.has(url.pathname)) {
                const [file, type] = ASSETS.get(url.pathname);
                let data;
                try { data = await fs.readFile(path.isAbsolute(file) ? file : path.join(this.assetsDir, file)); } catch { throw httpError(404, "远程页面资源不存在"); }
                response.writeHead(200, { "Content-Type": type });
                response.end(data);
            } else if (request.method === "GET" && url.pathname === "/api/session") {
                const auth = this._session(request, true);
                this._json(response, 200, { authenticated: Boolean(auth), ...(auth ? { device: this._deviceView(auth.device), csrfToken: auth.session.csrfToken } : {}), pollIntervalMs: this.config.pollIntervalMs });
            } else if (request.method === "POST" && url.pathname === "/api/login") {
                await this._login(request, response);
            } else if (request.method === "GET" && url.pathname === "/api/state") {
                const { session, device } = this._session(request);
                const unchanged = url.searchParams.get("revision") === String(this.revision);
                this._json(response, 200, { revision: this.revision, unchanged, ...(unchanged ? {} : { snapshot: this.snapshot }), device: this._deviceView(device), csrfToken: session.csrfToken, allowWrite: this.config.allowWrite, pollIntervalMs: this.config.pollIntervalMs });
            } else if (request.method === "POST" && url.pathname === "/api/messages") {
                await this._sendMessage(request, response);
            } else if (request.method === "POST" && url.pathname === "/api/logout") {
                const { session, token } = this._session(request);
                if (!secretEqual(request.headers["x-gateway-csrf"] || "", session.csrfToken)) throw httpError(403, "安全验证无效");
                this.sessions.delete(token);
                this._emitStatus();
                this._json(response, 200, { success: true }, { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
            } else throw httpError(404, "接口不存在");
        } catch (error) {
            if (!response.headersSent && !response.destroyed) this._json(response, error.status || 500, { error: error.status ? error.message : "网关请求失败，请稍后重试" });
            else if (!response.writableEnded) response.end();
        } finally { this.inflight--; }
    }
}

module.exports = { AgentGateway, networkAddresses, sanitizeSnapshot, DEFAULT_CONFIG };
