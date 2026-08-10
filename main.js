const {
    app,
    BrowserWindow,
    ipcMain,
    session,
    Tray,
    Menu,
    globalShortcut,
    desktopCapturer,
    screen,
    nativeImage
} = require("electron");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const WebSocket = require("ws");

const PRESET_TEXTS_A = ["嗯……", "哦？", "欸？", "哦！"];
const PRESET_TEXTS_B = ["我想想……", "等一下啊……"];
const PRESET_TEXTS_C = ["让我看一下啊……", "稍等，我看看……", "欸？我看到了……"];

let mainWindow = null;
let audioWindow = null;
let audioSession = null;
let audioCompletionSent = false;
let xunfeiSession = null;
let tray = null;
let isQuitting = false;
let developerModeEnabled = false;
let mainRendererReady = false;
let pendingMainCommands = [];
let desktopShortcut = "";
let desktopMouseInteractive = false;

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function createWindow(htmlFile = "index.html", options = {}) {
    const win = new BrowserWindow({
        width: options.width || 1200,
        height: options.height || 800,
        minWidth: options.minWidth,
        minHeight: options.minHeight,
        maxWidth: options.maxWidth,
        maxHeight: options.maxHeight,
        parent: options.parent,
        modal: false,
        show: options.show !== false,
        backgroundColor: options.backgroundColor || "#212121",
        frame: options.frame !== false,
        transparent: options.transparent === true,
        alwaysOnTop: options.alwaysOnTop === true,
        skipTaskbar: options.skipTaskbar === true,
        resizable: options.resizable !== false,
        focusable: options.focusable !== false,
        x: options.x,
        y: options.y,
        icon: path.join(__dirname, "favicon.ico"),
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            nativeWindowOpen: true,
            webSecurity: options.webSecurity !== false,
            allowRunningInsecureContent: options.allowRunningInsecureContent === true
        }
    });

    win.loadFile(htmlFile);
    win.webContents.setWindowOpenHandler(() => ({ action: "allow" }));
    return win;
}

function sanitizeTurns(turns) {
    if (!Array.isArray(turns)) return [];
    return turns
        .filter((item) => item && (item.role === "user" || item.role === "assistant"))
        .map((item) => {
            const clean = {
                role: item.role,
                content: String(item.content || "").slice(0, 200000)
            };
            if (item.role === "assistant" && typeof item.voiceRecordId === "string" && item.voiceRecordId.trim()) {
                clean.voiceRecordId = item.voiceRecordId.trim();
            }
            if (item.role === "user" && Array.isArray(item.attachments)) {
                clean.attachments = item.attachments
                    .filter((attachment) => attachment && attachment.isImage && typeof attachment.fullDataUrl === "string")
                    .map((attachment) => ({
                        name: String(attachment.name || "desktop-screenshot.jpg").slice(0, 200),
                        type: String(attachment.type || "image/jpeg").slice(0, 100),
                        size: Number(attachment.size) || 0,
                        originalSize: Number(attachment.originalSize) || Number(attachment.size) || 0,
                        isImage: true,
                        isText: false,
                        fullDataUrl: attachment.fullDataUrl.slice(0, 30 * 1024 * 1024)
                    }))
                    .slice(-1);
            }
            return clean;
        })
        .filter((item) => item.content.trim().length > 0)
        .slice(-500);
}

function sanitizeSettings(settings) {
    const source = settings && typeof settings === "object" ? settings : {};
    const clean = {};
    for (const [key, value] of Object.entries(source)) {
        if (typeof value === "string") clean[key] = value.slice(0, 200000);
        else if (typeof value === "number" || typeof value === "boolean") clean[key] = value;
    }
    return clean;
}

function isMainSender(event) {
    return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender.id === mainWindow.webContents.id);
}

function isAudioSender(event) {
    return Boolean(audioWindow && !audioWindow.isDestroyed() && event.sender.id === audioWindow.webContents.id);
}

function hasConversationWindow() {
    return Boolean(audioWindow && !audioWindow.isDestroyed());
}

function sendMainCommand(action, payload = {}) {
    const command = { action, ...payload };
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow(false);
    if (mainWindow && !mainWindow.isDestroyed() && mainRendererReady) {
        mainWindow.webContents.send("tray:action", command);
    } else {
        pendingMainCommands.push(command);
    }
}

function flushMainCommands() {
    if (!mainWindow || mainWindow.isDestroyed() || !mainRendererReady) return;
    const commands = pendingMainCommands.splice(0);
    commands.forEach((command) => mainWindow.webContents.send("tray:action", command));
}

function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createMainWindow();
        return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

function createMainWindow(show = true) {
    mainRendererReady = false;
    mainWindow = createWindow("index.html", { show });
    mainWindow.on("close", (event) => {
        if (isQuitting) return;
        event.preventDefault();
        mainWindow.hide();
    });
    mainWindow.on("closed", () => {
        mainWindow = null;
        mainRendererReady = false;
    });
    return mainWindow;
}

function emitAudioCompletion(reason, turnsOverride) {
    if (!audioSession || audioCompletionSent) return;
    audioCompletionSent = true;
    const turns = sanitizeTurns(turnsOverride || audioSession.pendingTurns);
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("audio-chat:completed", {
            sessionId: audioSession.sessionId,
            mode: audioSession.mode || "audio",
            targetChatId: audioSession.targetChatId,
            reason,
            turns
        });
    }
}

function closeAudioResources() {
    if (xunfeiSession) {
        xunfeiSession.abort();
        xunfeiSession = null;
    }
}

function presetDirectoryKey(apiBase, voiceId) {
    return crypto.createHash("sha256").update(`${apiBase}|${voiceId}`).digest("hex").slice(0, 24);
}

async function requestFishAudio(text, config) {
    const base = String(config.apiBase || "https://fishaudio.org").replace(/\/$/, "");
    const apiKey = String(config.apiKey || "").trim();
    const voiceId = String(config.voiceId || "").trim();
    if (!apiKey || !voiceId) throw new Error("请先填写 Fish Audio API Key 和音色 ID");

    const url = `${base}/api/open/v1/speech/tts`;
    const body = JSON.stringify({ text, voiceId, format: "mp3", speed: 1 });
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
        console.info(`[FishAudio][TTS] request attempt=${attempt + 1} url=${url} voiceId=${voiceId} chars=${String(text || '').length}`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 90000);
        try {
            // Electron's session network stack follows Chromium/system proxy rules (for example Clash).
            const response = await session.defaultSession.fetch(url, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json"
                },
                body,
                signal: controller.signal
            });
            console.info(`[FishAudio][TTS] response status=${response.status} attempt=${attempt + 1}`);
            if (response.ok) {
                const audio = Buffer.from(await response.arrayBuffer());
                if (!audio.length) throw new Error("Fish Audio 返回了空音频");
                console.info(`[FishAudio][TTS] success bytes=${audio.length} attempt=${attempt + 1}`);
                return audio;
            }

            const detail = await response.text();
            lastError = new Error(`Fish Audio 请求失败 (${response.status}): ${detail.slice(0, 500)}`);
            if (attempt === 0 && (response.status === 401 || response.status >= 500)) continue;
            lastError.retryable = false;
            throw lastError;
        } catch (error) {
            lastError = error?.name === "AbortError"
                ? new Error("Fish Audio 请求超时")
                : error;
            if (lastError?.retryable === false) throw lastError;
            if (attempt === 0) continue;
            throw lastError;
        } finally {
            clearTimeout(timeout);
        }
    }
    throw lastError || new Error("Fish Audio 请求失败");
}

async function generateVoicePreset(config) {
    const apiBase = String(config.apiBase || "https://fishaudio.org").trim();
    const apiKey = String(config.apiKey || "").trim();
    const voiceId = String(config.voiceId || "").trim();
    if (!apiKey || !voiceId) throw new Error("请先填写 Fish Audio API Key 和音色 ID");

    const dir = path.join(app.getPath("userData"), "voice-presets", presetDirectoryKey(apiBase, voiceId));
    await fs.mkdir(dir, { recursive: true });
    const manifest = { apiBase, voiceId, groupA: [], groupB: [], groupC: [], updatedAt: Date.now() };

    for (let index = 0; index < PRESET_TEXTS_A.length; index += 1) {
        const filename = `a-${index}.mp3`;
        await fs.writeFile(path.join(dir, filename), await requestFishAudio(PRESET_TEXTS_A[index], { apiBase, apiKey, voiceId }));
        manifest.groupA.push(filename);
    }
    for (let index = 0; index < PRESET_TEXTS_B.length; index += 1) {
        const filename = `b-${index}.mp3`;
        await fs.writeFile(path.join(dir, filename), await requestFishAudio(PRESET_TEXTS_B[index], { apiBase, apiKey, voiceId }));
        manifest.groupB.push(filename);
    }
    for (let index = 0; index < PRESET_TEXTS_C.length; index += 1) {
        const filename = `c-${index}.mp3`;
        await fs.writeFile(path.join(dir, filename), await requestFishAudio(PRESET_TEXTS_C[index], { apiBase, apiKey, voiceId }));
        manifest.groupC.push(filename);
    }
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    return { ok: true, count: manifest.groupA.length + manifest.groupB.length + manifest.groupC.length };
}

async function readVoicePreset(config) {
    const apiBase = String(config.apiBase || "https://fishaudio.org").trim();
    const voiceId = String(config.voiceId || "").trim();
    if (!voiceId) return null;
    const dir = path.join(app.getPath("userData"), "voice-presets", presetDirectoryKey(apiBase, voiceId));
    try {
        const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
        const loadGroup = async (files) => Promise.all((files || []).map(async (filename) =>
            (await fs.readFile(path.join(dir, filename))).toString("base64")));
        return {
            groupA: await loadGroup(manifest.groupA),
            groupB: await loadGroup(manifest.groupB),
            groupC: await loadGroup(manifest.groupC)
        };
    } catch {
        return null;
    }
}

class XunfeiSession {
    constructor(credentials, sender) {
        this.appId = String(credentials.appId || "");
        this.apiKey = String(credentials.apiKey || "");
        this.apiSecret = String(credentials.apiSecret || "");
        this.sender = sender;
        this.ws = null;
        this.open = false;
        this.finishing = false;
        this.samples = [];
        this.latestText = "";
        this.finishPromise = null;
        this.resolveFinish = null;
        this.finishTimer = null;
        this.stableTimer = null;
    }

    buildUrl() {
        const host = "iat-api.xfyun.cn";
        const date = new Date().toUTCString();
        const requestLine = "GET /v2/iat HTTP/1.1";
        const signatureOrigin = `host: ${host}\ndate: ${date}\n${requestLine}`;
        const signature = crypto.createHmac("sha256", this.apiSecret).update(signatureOrigin).digest("base64");
        const authorizationOrigin = `api_key="${this.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
        const authorization = Buffer.from(authorizationOrigin).toString("base64");
        return `wss://${host}/v2/iat?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${host}`;
    }

    start() {
        if (!this.appId || !this.apiKey || !this.apiSecret) throw new Error("科大讯飞凭证不完整");
        this.ws = new WebSocket(this.buildUrl());
        this.ws.on("open", () => {
            this.open = true;
            this.sendFrame(0, Buffer.alloc(0));
            this.flushSamples(false);
            if (this.finishing) this.sendFinalFrame();
        });
        this.ws.on("message", (data) => this.handleMessage(data));
        this.ws.on("error", (error) => {
            this.sendToRenderer("xunfei:error", error.message || "讯飞 WebSocket 连接失败");
            this.finishNow();
        });
        this.ws.on("close", () => this.finishNow());
    }

    sendToRenderer(channel, payload) {
        if (this.sender && !this.sender.isDestroyed()) this.sender.send(channel, payload);
    }

    sendFrame(status, pcmBuffer) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({
            common: { app_id: this.appId },
            business: {
                language: "zh_cn",
                domain: "iat",
                accent: "mandarin",
                dwa: "wpgs",
                vad_eos: 60000,
                ptt: 0
            },
            data: {
                status,
                format: "audio/L16;rate=16000",
                encoding: "raw",
                audio: pcmBuffer.toString("base64")
            }
        }));
    }

    feed(input) {
        if (this.finishing) return;
        for (const value of input || []) this.samples.push(Number(value) || 0);
        this.flushSamples(false);
    }

    flushSamples(flushAll) {
        if (!this.open) return;
        const chunkSize = 640;
        while (this.samples.length >= chunkSize || (flushAll && this.samples.length > 0)) {
            const count = this.samples.length >= chunkSize ? chunkSize : this.samples.length;
            const chunk = this.samples.splice(0, count);
            const pcm = Buffer.allocUnsafe(chunk.length * 2);
            for (let index = 0; index < chunk.length; index += 1) {
                const sample = Math.max(-1, Math.min(1, chunk[index]));
                const int16 = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
                pcm.writeInt16LE(int16, index * 2);
            }
            this.sendFrame(1, pcm);
        }
    }

    handleMessage(raw) {
        try {
            const response = JSON.parse(raw.toString());
            if (response.code !== 0) {
                this.sendToRenderer("xunfei:error", response.message || `讯飞错误 ${response.code}`);
                this.finishNow();
                return;
            }
            const result = response.data && response.data.result;
            if (result && Array.isArray(result.ws)) {
                let text = "";
                for (const segment of result.ws) {
                    for (const candidate of segment.cw || []) text += candidate.w || "";
                }
                if (text.trim()) {
                    this.latestText = text;
                    this.sendToRenderer(result.pgs === "rpl" ? "xunfei:final" : "xunfei:partial", text);
                    if (this.finishing) {
                        clearTimeout(this.stableTimer);
                        this.stableTimer = setTimeout(() => this.finishNow(), 700);
                    }
                }
            }
            if (response.data && response.data.status === 2) {
                clearTimeout(this.stableTimer);
                this.stableTimer = setTimeout(() => this.finishNow(), 250);
            }
        } catch (error) {
            this.sendToRenderer("xunfei:error", `讯飞响应解析失败: ${error.message}`);
        }
    }

    sendFinalFrame() {
        if (!this.open) return;
        this.flushSamples(true);
        this.sendFrame(2, Buffer.alloc(0));
        clearTimeout(this.finishTimer);
        this.finishTimer = setTimeout(() => this.finishNow(), 3500);
    }

    finish() {
        if (this.finishPromise) return this.finishPromise;
        this.finishing = true;
        this.finishPromise = new Promise((resolve) => {
            this.resolveFinish = resolve;
        });
        if (this.open) this.sendFinalFrame();
        else {
            this.finishTimer = setTimeout(() => this.finishNow(), 4500);
        }
        return this.finishPromise;
    }

    finishNow() {
        clearTimeout(this.finishTimer);
        clearTimeout(this.stableTimer);
        if (this.resolveFinish) {
            this.resolveFinish(this.latestText || "");
            this.resolveFinish = null;
        }
        if (this.ws) {
            try { this.ws.close(); } catch {}
            this.ws = null;
        }
        this.open = false;
    }

    abort() {
        this.finishing = true;
        this.finishNow();
    }
}

function clearDesktopShortcut() {
    if (desktopShortcut) {
        globalShortcut.unregister(desktopShortcut);
        desktopShortcut = "";
    }
}

function screenshotQualitySettings(value) {
    const quality = String(value || "balanced").toLowerCase();
    if (quality === "low") return { maxEdge: 1280, jpegQuality: 72 };
    if (quality === "high") return { maxEdge: 2560, jpegQuality: 92 };
    return { maxEdge: 1920, jpegQuality: 85 };
}

async function captureCurrentDisplayScreenshot() {
    if (!audioSession || audioSession.mode !== "desktop") return;
    const captureWindow = audioWindow && !audioWindow.isDestroyed() ? audioWindow : null;
    if (captureWindow) {
        captureWindow.setOpacity(0);
        await new Promise(resolve => setTimeout(resolve, 70));
    }
    try {
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    const scale = Number(display.scaleFactor) || 1;
    const width = Math.max(1, Math.round(display.bounds.width * scale));
    const height = Math.max(1, Math.round(display.bounds.height * scale));
    const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width, height },
        fetchWindowIcons: false
    });
    const displayIndex = screen.getAllDisplays().findIndex(item => item.id === display.id);
    const source = sources.find(item => String(item.display_id) === String(display.id))
        || (displayIndex >= 0 ? sources[displayIndex] : null)
        || sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error("无法获取当前显示器截图");
    const settings = screenshotQualitySettings(audioSession.settings.desktopImageQuality);
    const imageSize = source.thumbnail.getSize();
    const maxEdge = Math.max(imageSize.width, imageSize.height);
    const resized = maxEdge > settings.maxEdge
        ? source.thumbnail.resize({
            width: Math.round(imageSize.width * settings.maxEdge / maxEdge),
            height: Math.round(imageSize.height * settings.maxEdge / maxEdge),
            quality: "best"
        })
        : source.thumbnail;
    const dataUrl = `data:image/jpeg;base64,${resized.toJPEG(settings.jpegQuality).toString("base64")}`;
    audioSession.pendingScreenshot = dataUrl;
    if (audioWindow && !audioWindow.isDestroyed()) {
        audioWindow.webContents.send("desktop-work:screenshot-captured", {
            dataUrl,
            displayId: String(display.id),
            quality: audioSession.settings.desktopImageQuality || "balanced"
        });
    }
    } finally {
        if (captureWindow && !captureWindow.isDestroyed()) captureWindow.setOpacity(1);
    }
}

function registerDesktopShortcut(settings) {
    clearDesktopShortcut();
    const accelerator = String(settings.desktopShortcut || "Control+A").trim() || "Control+A";
    if (!globalShortcut.register(accelerator, () => {
        captureCurrentDisplayScreenshot().catch(error => {
            if (audioWindow && !audioWindow.isDestroyed()) audioWindow.webContents.send("desktop-work:screenshot-error", error.message);
        });
    })) {
        throw new Error(`无法注册传图快捷键：${accelerator}`);
    }
    desktopShortcut = accelerator;
    return accelerator;
}

async function openCollaborationWindow(event, payload, mode) {
    if (!isMainSender(event)) throw new Error("非法的协作窗口请求");
    if (hasConversationWindow()) {
        audioWindow.focus();
        return { ok: true, sessionId: audioSession && audioSession.sessionId, reused: true };
    }

    audioCompletionSent = false;
    const settings = sanitizeSettings(payload && payload.settings);
    audioSession = {
        sessionId: crypto.randomUUID(),
        mode,
        targetChatId: String(payload && payload.targetChatId || ""),
        context: sanitizeTurns(payload && payload.context),
        settings,
        pendingTurns: [],
        pendingScreenshot: null
    };

    if (mode === "desktop") {
        registerDesktopShortcut(settings);
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        const width = Math.max(720, Math.round(display.workArea.width * 0.8));
        const height = 156;
        const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2);
        const y = Math.round(display.workArea.y + display.workArea.height - height - 12);
        audioWindow = createWindow("desktopwork.html", {
            width,
            height,
            minWidth: 640,
            minHeight: height,
            maxHeight: height,
            x,
            y,
            show: false,
            frame: false,
            transparent: true,
            alwaysOnTop: true,
            skipTaskbar: true,
            resizable: false,
            backgroundColor: "#00000000",
            webSecurity: false,
            allowRunningInsecureContent: true
        });
        audioWindow.setAlwaysOnTop(true, "floating");
        audioWindow.setIgnoreMouseEvents(true, { forward: true });
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    } else {
        audioWindow = createWindow("audiochat.html", {
            width: 600,
            height: 600,
            minWidth: 520,
            minHeight: 520,
            parent: mainWindow,
            show: false,
            backgroundColor: "#171717",
            webSecurity: false,
            allowRunningInsecureContent: true
        });
    }
    audioWindow.once("ready-to-show", () => audioWindow && audioWindow.show());
    audioWindow.on("close", () => {
        emitAudioCompletion("window-close");
        closeAudioResources();
        clearDesktopShortcut();
        if (audioSession && audioSession.mode === "desktop" && mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
        }
    });
    audioWindow.on("closed", () => {
        audioWindow = null;
        audioSession = null;
        audioCompletionSent = false;
        desktopMouseInteractive = false;
        refreshTrayMenu();
    });
    refreshTrayMenu();
    return { ok: true, sessionId: audioSession.sessionId, reused: false, shortcut: desktopShortcut };
}

ipcMain.handle("audio-chat:open", async (event, payload) => openCollaborationWindow(event, payload, "audio"));
ipcMain.handle("desktop-work:open", async (event, payload) => openCollaborationWindow(event, payload, "desktop"));

ipcMain.handle("audio-chat:get-session", async (event) => {
    if (!isAudioSender(event) || !audioSession) throw new Error("语音会话不存在");
    return audioSession;
});
ipcMain.handle("desktop-work:get-session", async (event) => {
    if (!isAudioSender(event) || !audioSession || audioSession.mode !== "desktop") throw new Error("桌面协作会话不存在");
    return audioSession;
});

ipcMain.handle("audio-chat:checkpoint", async (event, turns) => {
    if (!isAudioSender(event) || !audioSession) return { ok: false };
    audioSession.pendingTurns = sanitizeTurns(turns);
    return { ok: true };
});

ipcMain.handle("audio-chat:complete", async (event, turns) => {
    if (!isAudioSender(event) || !audioSession) return { ok: false };
    audioSession.pendingTurns = sanitizeTurns(turns);
    emitAudioCompletion("ended", audioSession.pendingTurns);
    closeAudioResources();
    setTimeout(() => {
        if (audioWindow && !audioWindow.isDestroyed()) audioWindow.close();
    }, 120);
    return { ok: true };
});
ipcMain.handle("desktop-work:complete", async (event, turns) => {
    if (!isAudioSender(event) || !audioSession || audioSession.mode !== "desktop") return { ok: false };
    audioSession.pendingTurns = sanitizeTurns(turns);
    emitAudioCompletion("ended", audioSession.pendingTurns);
    closeAudioResources();
    clearDesktopShortcut();
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
    setTimeout(() => {
        if (audioWindow && !audioWindow.isDestroyed()) audioWindow.close();
    }, 120);
    return { ok: true };
});

ipcMain.handle("audio-chat:generate-preset", async (event, config) => {
    if (!isMainSender(event)) throw new Error("非法的预制语音请求");
    return generateVoicePreset(config || {});
});

ipcMain.handle("audio-chat:get-preset", async (event, config) => {
    if (!isAudioSender(event)) return null;
    return readVoicePreset(config || {});
});
ipcMain.handle("desktop-work:get-preset", async (event, config) => {
    if (!isAudioSender(event)) return null;
    return readVoicePreset(config || {});
});

ipcMain.handle("audio-chat:tts", async (event, request) => {
    if (!isAudioSender(event)) throw new Error("非法的 Fish Audio 请求");
    const source = request && typeof request === "object" ? request : {};
    console.info(`[AudioChat][IPC] audio-chat:tts received chars=${String(source.text || '').length} voiceId=${String(source.voiceId || '').trim() || '(empty)'}`);
    const audio = await requestFishAudio(String(source.text || "").slice(0, 1000), {
        apiBase: source.apiBase,
        apiKey: source.apiKey,
        voiceId: source.voiceId
    });
    return audio.toString("base64");
});
ipcMain.handle("desktop-work:tts", async (event, request) => {
    if (!isAudioSender(event)) throw new Error("非法的 Fish Audio 请求");
    const source = request && typeof request === "object" ? request : {};
    const audio = await requestFishAudio(String(source.text || "").slice(0, 1000), {
        apiBase: source.apiBase,
        apiKey: source.apiKey,
        voiceId: source.voiceId
    });
    return audio.toString("base64");
});

ipcMain.handle("desktop-work:set-interactive", async (event, value) => {
    if (!isAudioSender(event) || !audioSession || audioSession.mode !== "desktop" || !audioWindow) return { ok: false };
    const next = Boolean(value);
    if (desktopMouseInteractive !== next) {
        desktopMouseInteractive = next;
        audioWindow.setIgnoreMouseEvents(!next, { forward: true });
    }
    return { ok: true, interactive: next };
});

ipcMain.handle("xunfei:start", async (event, credentials) => {
    if (!isAudioSender(event)) throw new Error("非法的讯飞请求");
    if (xunfeiSession) xunfeiSession.abort();
    xunfeiSession = new XunfeiSession(credentials || {}, event.sender);
    xunfeiSession.start();
    return { ok: true };
});

ipcMain.on("xunfei:audio", (event, samples) => {
    if (isAudioSender(event) && xunfeiSession) xunfeiSession.feed(samples);
});

ipcMain.handle("xunfei:finish", async (event) => {
    if (!isAudioSender(event) || !xunfeiSession) return "";
    const session = xunfeiSession;
    const text = await session.finish();
    if (xunfeiSession === session) xunfeiSession = null;
    return text;
});

ipcMain.handle("xunfei:abort", async (event) => {
    if (isAudioSender(event) && xunfeiSession) {
        xunfeiSession.abort();
        xunfeiSession = null;
    }
    return { ok: true };
});

ipcMain.on("renderer:ready", (event) => {
    if (!isMainSender(event)) return;
    mainRendererReady = true;
    flushMainCommands();
});

ipcMain.on("app-state:update", (event, state) => {
    if (!isMainSender(event)) return;
    developerModeEnabled = Boolean(state && state.developerMode);
    refreshTrayMenu();
});

function trayTemplate() {
    const collaborationDisabled = hasConversationWindow();
    return [
        { label: "打开主页面", click: showMainWindow },
        { label: "开启新语音聊天", enabled: !collaborationDisabled, click: () => sendMainCommand("new-audio-chat") },
        { label: "开启新桌面协作", enabled: !collaborationDisabled, click: () => sendMainCommand("new-desktop-work") },
        { label: "从最近会话开启语音聊天", enabled: !collaborationDisabled, click: () => sendMainCommand("recent-audio-chat") },
        { label: "从最近会话开启桌面协作", enabled: !collaborationDisabled, click: () => sendMainCommand("recent-desktop-work") },
        ...(developerModeEnabled ? [
            { type: "separator" },
            { label: "清除日志", click: () => sendMainCommand("clear-logs") },
            { label: "导出日志", click: () => sendMainCommand("export-logs") }
        ] : []),
        { type: "separator" },
        {
            label: "退出AIUI",
            click: () => {
                isQuitting = true;
                app.quit();
            }
        }
    ];
}

function refreshTrayMenu() {
    if (!tray || tray.isDestroyed()) return;
    tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
}

function createTray() {
    const icon = nativeImage.createFromPath(path.join(__dirname, "favicon.ico"));
    tray = new Tray(icon);
    tray.setToolTip("AIUI");
    refreshTrayMenu();
    tray.on("click", () => tray.popUpContextMenu());
}

app.whenReady().then(() => {
    createMainWindow();
    createTray();

    app.on("activate", () => {
        showMainWindow();
    });
});

app.on("before-quit", () => {
    isQuitting = true;
    clearDesktopShortcut();
});

app.on("window-all-closed", () => {});
