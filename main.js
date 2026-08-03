const { app, BrowserWindow, ipcMain, session } = require("electron");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const WebSocket = require("ws");

const PRESET_TEXTS_A = ["嗯……", "哦？", "欸？", "哦！"];
const PRESET_TEXTS_B = ["我想想……", "等一下啊……"];

let mainWindow = null;
let audioWindow = null;
let audioSession = null;
let audioCompletionSent = false;
let xunfeiSession = null;

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function createWindow(htmlFile = "index.html", options = {}) {
    const win = new BrowserWindow({
        width: options.width || 1200,
        height: options.height || 800,
        minWidth: options.minWidth,
        minHeight: options.minHeight,
        parent: options.parent,
        modal: false,
        show: options.show !== false,
        backgroundColor: options.backgroundColor || "#212121",
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

function emitAudioCompletion(reason, turnsOverride) {
    if (!audioSession || audioCompletionSent) return;
    audioCompletionSent = true;
    const turns = sanitizeTurns(turnsOverride || audioSession.pendingTurns);
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("audio-chat:completed", {
            sessionId: audioSession.sessionId,
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
    const manifest = { apiBase, voiceId, groupA: [], groupB: [], updatedAt: Date.now() };

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
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    return { ok: true, count: manifest.groupA.length + manifest.groupB.length };
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
            groupB: await loadGroup(manifest.groupB)
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

ipcMain.handle("audio-chat:open", async (event, payload) => {
    if (!isMainSender(event)) throw new Error("非法的语音窗口请求");
    if (audioWindow && !audioWindow.isDestroyed()) {
        audioWindow.focus();
        return { ok: true, sessionId: audioSession && audioSession.sessionId, reused: true };
    }

    audioCompletionSent = false;
    audioSession = {
        sessionId: crypto.randomUUID(),
        targetChatId: String(payload && payload.targetChatId || ""),
        context: sanitizeTurns(payload && payload.context),
        settings: sanitizeSettings(payload && payload.settings),
        pendingTurns: []
    };

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
    audioWindow.once("ready-to-show", () => audioWindow && audioWindow.show());
    audioWindow.on("close", () => {
        emitAudioCompletion("window-close");
        closeAudioResources();
    });
    audioWindow.on("closed", () => {
        audioWindow = null;
        audioSession = null;
        audioCompletionSent = false;
    });
    return { ok: true, sessionId: audioSession.sessionId, reused: false };
});

ipcMain.handle("audio-chat:get-session", async (event) => {
    if (!isAudioSender(event) || !audioSession) throw new Error("语音会话不存在");
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

ipcMain.handle("audio-chat:generate-preset", async (event, config) => {
    if (!isMainSender(event)) throw new Error("非法的预制语音请求");
    return generateVoicePreset(config || {});
});

ipcMain.handle("audio-chat:get-preset", async (event, config) => {
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

app.whenReady().then(() => {
    mainWindow = createWindow();
    mainWindow.on("closed", () => { mainWindow = null; });

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            mainWindow = createWindow();
            mainWindow.on("closed", () => { mainWindow = null; });
        }
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
