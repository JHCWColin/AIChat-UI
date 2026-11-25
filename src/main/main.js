const {
    app,
    BrowserWindow,
    ipcMain,
    dialog,
    session,
    Tray,
    Menu,
    globalShortcut,
    desktopCapturer,
    screen,
    nativeImage,
    Notification
} = require("electron");
const { autoUpdater } = require("electron-updater");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { pathToFileURL } = require("node:url");
const https = require("https");
const http = require("http");
const WebSocket = require("ws");
const FishAudio = require("../shared/fish-audio");
const { createDiskMemoryStore } = require("./user-memory-store");
const { normalizeActivity: normalizeMemoryActivity } = require("../renderer/user-memory");
const { AgentShellClient } = require("./agent-shell-client");
const {
    AgentWorkspaceStore,
    readFileRange,
    writeFile: writeAgentFile,
    editFile: editAgentFile,
    multiEditFile: multiEditAgentFile,
    applyPatch,
    globFiles,
    deletePath,
    movePath,
    copyPath,
    listDir,
    grepFiles,
    viewImage,
    loadAllowedCommands,
    saveUserAllowedCommands,
    findAllowedCommandPrefix,
    deriveAllowedCommandPrefix,
    getEnvironmentDescription
} = require("./agent-tools");
const AgentSearch = require("./agent-search");
const { registerAgentGateway } = require("./gateway-electron");

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
let autoUpdateCheckStarted = false;
let availableUpdateVersion = "";
let currentVersionConfirmedLatest = false;
let updateDownloadRequested = false;
let agentWorkspaceStore = null;
const pendingAgentWorkspaceSelections = new Map();
const agentShell = new AgentShellClient();
const pendingAgentShells = new Map();
let agentBackgroundStartGeneration = 0;
let agentShellShutdown;
let rendererRuntimeState = {};
let userMemoryStore;
const desktopEnhancements = require('./desktop-enhancements').registerDesktopEnhancements({
    app, BrowserWindow, ipcMain, Notification, getMainWindow: () => mainWindow, isMainSender,
    getRuntimeState: () => ({ ...rendererRuntimeState, audio: Boolean(audioSession), desktop: Boolean(audioSession?.mode === 'desktop') })
});

const FETCH_PUBLIC_TIMEOUT_MS = 60000; // 1 分钟无响应即视为连接重置
const FETCH_PUBLIC_MAX_BYTES = 2000000;

const agentGateway = registerAgentGateway({
    app, BrowserWindow, ipcMain,
    getMainWindow: () => mainWindow,
    isMainSender,
    isRendererReady: () => mainRendererReady,
    hasConversationWindow
});

/**
 * Fetches a public URL with a browser-like User-Agent, following redirects.
 * Supports both http:// and https:// schemes. Search engines and most sites
 * reject unknown clients, so the UA matters here. A shared `deadline` (absolute
 * ms timestamp) can be passed in so that the whole request — including every
 * redirect hop and the response body — is aborted within a single time budget
 * instead of resetting the clock on each hop.
 */
function fetchPublicText(url, options = {}) {
    const target = String(url || '');
    const useHttps = /^https:\/\//i.test(target);
    if (!/^https?:\/\//i.test(target)) {
        return Promise.reject(new Error(`不支持的协议：${target}`));
    }
    const redirectsRemaining = Number.isFinite(options.redirects) ? Number(options.redirects) : 5;
    const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : FETCH_PUBLIC_MAX_BYTES;
    const deadline = Number.isFinite(options.deadline) ? Number(options.deadline) : (Date.now() + FETCH_PUBLIC_TIMEOUT_MS);
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs <= 0) {
        return Promise.reject(Object.assign(
            new Error(`Connection Reset（请求 ${Math.round(FETCH_PUBLIC_TIMEOUT_MS / 1000)} 秒内无响应）：${target}`),
            { code: 'ECONNRESET' }
        ));
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (error) reject(error);
            else resolve(value);
        };
        let request;
        try {
            request = (useHttps ? https : http).get(target, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
                },
                timeout: remainingMs
            }, response => {
                intakePublicResponse(response, { ...options, deadline }, redirectsRemaining, maxBytes).then(
                    value => finish(null, value),
                    error => finish(error)
                );
            });
        } catch (error) {
            finish(error);
            return;
        }
        const abort = () => request.destroy(Object.assign(
            new Error(`Connection Reset（请求 ${Math.round(FETCH_PUBLIC_TIMEOUT_MS / 1000)} 秒内无响应）：${target}`),
            { code: 'ECONNRESET' }
        ));
        // 硬性兜底：即使 DNS/连接阶段卡住（socket 尚未建立），也按 1 分钟预算强制中止。
        request.on('timeout', abort);
        request.on('error', error => finish(error));
        timer = setTimeout(abort, remainingMs);
    });
}

async function intakePublicResponse(response, options, redirectsRemaining, maxBytes) {
    const status = Number(response.statusCode) || 0;
    const location = response.headers?.location;
    if (status >= 300 && status < 400 && location && redirectsRemaining > 0) {
        response.resume();
        const nextUrl = new URL(location, options.baseUrl || response.headers?.referer || undefined).toString();
        if (!/^https?:\/\//i.test(nextUrl)) throw new Error(`不支持的重定向地址：${nextUrl}`);
        return fetchPublicText(nextUrl, { ...options, baseUrl: nextUrl, redirects: redirectsRemaining - 1, maxBytes });
    }
    if (options.raw === true) {
        // Callers that need headers (Bing's API) read the body themselves.
        return { status, headers: response.headers, body: await readPublicBody(response, maxBytes) };
    }
    if (status < 200 || status >= 300) {
        response.resume();
        throw new Error(`HTTP ${status}`);
    }
    return readPublicBody(response, maxBytes);
}

function readPublicBody(response, maxBytes) {
    return new Promise((resolve, reject) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
            data += chunk;
            if (data.length > maxBytes) response.destroy();
        });
        response.on('end', () => resolve(data));
        response.on('error', reject);
    });
}

function stripHtmlText(html) { return String(html || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); }

/**
 * Runs a keyless web search through the selected engine's public HTML endpoint and
 * falls back to the other engine when the first one yields nothing usable, so a
 * single blocked provider cannot silently break the agent's research ability.
 */
async function runAgentWebSearch(args = {}) {
    const query = String(args.query || '').trim();
    if (!query) return { success: false, error: 'query is required' };
    const requestedEngine = AgentSearch.normalizeEngine(args.engine);
    const limit = AgentSearch.normalizeLimit(args.limit);
    const attempts = [requestedEngine, ...AgentSearch.SEARCH_ENGINES.map(engine => engine.id).filter(id => id !== requestedEngine)];
    const failures = [];
    const deadline = Date.now() + FETCH_PUBLIC_TIMEOUT_MS;
    for (const engine of attempts) {
        if (Date.now() >= deadline) {
            failures.push(`${engine}: 一分钟内无响应`);
            break;
        }
        try {
            const html = await fetchPublicText(AgentSearch.buildSearchUrl(engine, query, {
                market: args.market,
                language: args.language
            }), { baseUrl: engine === 'duckduckgo' ? 'https://duckduckgo.com' : 'https://www.bing.com', deadline });
            const results = AgentSearch.parseSearchHtml(engine, html, limit);
            if (results.length) {
                return {
                    success: true,
                    query,
                    engine,
                    requestedEngine,
                    fellBack: engine !== requestedEngine,
                    resultCount: results.length,
                    results
                };
            }
            failures.push(`${engine}: 没有解析到结果`);
        } catch (error) {
            failures.push(`${engine}: ${error.message}`);
        }
    }
    return {
        success: false,
        query,
        engine: requestedEngine,
        error: `搜索失败或没有返回结果（${failures.join('；')}）`,
        hint: 'Try a shorter or differently worded query, or pass a different engine argument.'
    };
}

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowPrerelease = true;

function isInstalledWindowsBuild() {
    const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);
    return process.platform === "win32" && app.isPackaged && !isPortable;
}

function formatDisplayVersion(version) {
    const text = String(version || "").trim();
    if (!text) return "";
    const canaryMatch = text.match(/^(\d+\.\d+\.\d+)-canary\.(\d+)$/i);
    if (canaryMatch) return `V${canaryMatch[1]} Canary ${canaryMatch[2]}`;
    const match = text.match(/^(\d+\.\d+\.\d+)(?:-release)?$/i);
    return match ? `V${match[1]} Release` : `V${text}`;
}

function sendUpdateStatus() {
    if (!mainWindow || mainWindow.isDestroyed() || !mainRendererReady) return;
    if (availableUpdateVersion) {
        mainWindow.webContents.send("app:update-available", {
            version: availableUpdateVersion,
            displayVersion: formatDisplayVersion(availableUpdateVersion)
        });
    } else if (currentVersionConfirmedLatest) {
        mainWindow.webContents.send("app:update-not-available", {
            version: app.getVersion(),
            displayVersion: formatDisplayVersion(app.getVersion())
        });
    }
}

async function showNativeMessage(options) {
    if (mainWindow && !mainWindow.isDestroyed()) return dialog.showMessageBox(mainWindow, options);
    return dialog.showMessageBox(options);
}

async function checkForAppUpdates() {
    if (autoUpdateCheckStarted || !isInstalledWindowsBuild()) return;
    autoUpdateCheckStarted = true;
    try {
        await autoUpdater.checkForUpdates();
    } catch (error) {
        console.warn(`[AutoUpdate] 检查更新失败: ${error.message}`);
    }
}

ipcMain.handle("app:check-for-updates", async (event) => {
    if (!isMainSender(event) && !desktopEnhancements.isPreferences(event)) throw new Error("非法的更新检查请求");
    try {
        await autoUpdater.checkForUpdates();
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

autoUpdater.on("update-available", async (info) => {
    currentVersionConfirmedLatest = false;
    availableUpdateVersion = String(info && info.version || "").trim();
    sendUpdateStatus();
    const displayVersion = formatDisplayVersion(availableUpdateVersion) || "新版本";
    const result = await showNativeMessage({
        type: "info",
        title: "AIUI 更新",
        message: `发现可用更新：${displayVersion}`,
        detail: "是否现在下载更新？Setup 版本将使用差分更新数据以减少下载量。",
        buttons: ["立即更新", "暂不更新"],
        defaultId: 0,
        cancelId: 1,
        noLink: true
    });
    if (result.response !== 0) return;
    updateDownloadRequested = true;
    autoUpdater.downloadUpdate().catch(error => {
        updateDownloadRequested = false;
        console.warn(`[AutoUpdate] 下载更新失败: ${error.message}`);
    });
});

autoUpdater.on("update-not-available", () => {
    availableUpdateVersion = "";
    currentVersionConfirmedLatest = true;
    sendUpdateStatus();
});

autoUpdater.on("update-downloaded", async (info) => {
    if (!updateDownloadRequested) return;
    const displayVersion = formatDisplayVersion(info && info.version) || "新版本";
    const result = await showNativeMessage({
        type: "info",
        title: "AIUI 更新已下载",
        message: `${displayVersion} 已准备完成`,
        detail: "立即重启应用并完成安装，或在本次退出应用时自动安装。",
        buttons: ["立即重启安装", "退出时安装"],
        defaultId: 0,
        cancelId: 1,
        noLink: true
    });
    if (result.response === 0) {
        isQuitting = true;
        autoUpdater.quitAndInstall(false, true);
    }
});

autoUpdater.on("error", error => {
    console.warn(`[AutoUpdate] ${error.message}`);
});

function createWindow(htmlFile = "index.html", options = {}) {
    const win = new BrowserWindow({
        width: options.width || 1200,
        height: options.height || 800,
        minWidth: options.minWidth || 380,
        minHeight: options.minHeight || 540,
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
        icon: path.join(__dirname, "..", "assets", "icons", "favicon.ico"),
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            additionalArguments: ["--aiui-memory-store"],
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            nativeWindowOpen: true,
            webSecurity: options.webSecurity !== false,
            allowRunningInsecureContent: options.allowRunningInsecureContent === true
        }
    });

    win.loadFile(path.resolve(__dirname, "..", htmlFile));
    win.webContents.setWindowOpenHandler(() => ({ action: "allow" }));
    return win;
}

function getAgentWorkspaceStore() {
    if (!agentWorkspaceStore) {
        agentWorkspaceStore = new AgentWorkspaceStore(path.join(app.getPath("userData"), "agent-workspaces.json"));
    }
    return agentWorkspaceStore;
}

function getAgentCommandPaths() {
    return {
        defaultFile: path.join(__dirname, "alwaysAllowedCommand.txt"),
        userFile: path.join(app.getPath("userData"), "alwaysAllowedCommand.user.txt")
    };
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
            if (Number.isFinite(Number(item.completedAt)) && Number(item.completedAt) > 0) clean.completedAt = Number(item.completedAt);
            if (item.role === "assistant" && typeof item.voiceRecordId === "string" && item.voiceRecordId.trim()) {
                clean.voiceRecordId = item.voiceRecordId.trim();
            }
            if (item.role === "assistant") {
                const counts = normalizeMemoryActivity(item.memoryActivity);
                if (counts) clean.memoryActivity = counts;
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
        .filter((item) => item.content.trim().length > 0 || item.memoryActivity)
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

function handleMemoryRequest(event, operation, payload) {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return null;
    const page = event.senderFrame.url.split(/[?#]/, 1)[0];
    const isPage = name => page === pathToFileURL(path.join(__dirname, "..", name)).href;
    const chat = isMainSender(event) && isPage("index.html");
    const preferences = desktopEnhancements.isPreferences(event) && isPage("index.html");
    const collaboration = audioSession && isAudioSender(event) && isPage("audiochat.html");
    if (!chat && !preferences && !collaboration) return null;
    const changed = () => BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) win.webContents.send("memory:changed");
    });
    try {
        const store = userMemoryStore ??= createDiskMemoryStore(app.getPath("userData"));
        if (operation === "isEnabled") return store.isEnabled();
        if (operation === "getContext" && (chat || collaboration)) {
            const id = collaboration ? audioSession.targetChatId : payload?.chatId;
            return store.getContext({ id }, { estimateOnly: payload?.estimateOnly === true });
        }
        if (operation === "applyCalls" && (chat || collaboration) && Array.isArray(payload)) {
            const results = store.applyCalls(payload);
            if (results.some(({ result }) => result.ok && !result.unchanged)) changed();
            return results;
        }
        if (operation === "list" && (preferences || chat)) return store.list();
        if (operation === "setEnabled" && (preferences || chat)) {
            store.setEnabled(payload);
            changed();
            return true;
        }
        if (operation === "deleteRecord" && (preferences || chat)) {
            const result = store.deleteRecord(payload);
            if (result.ok) changed();
            return result;
        }
        if (operation === "removeSnapshot" && chat) store.removeSnapshot(payload);
    } catch {
        // The reply remains usable if the local store cannot be read or saved.
    }
    return null;
}
ipcMain.on("memory:request", (event, operation, payload) => {
    event.returnValue = handleMemoryRequest(event, operation, payload);
});

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
    agentGateway.bindMainWindow(mainWindow);
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

function presetDirectoryKey({ apiBase, voiceId, endpoint, model }) {
    return crypto.createHash("sha256").update(`${apiBase}|${voiceId}|${endpoint}|${model}`).digest("hex").slice(0, 24);
}

async function requestFishAudio(text, config, cancelSignal) {
    const { url, headers, body } = FishAudio.buildRequest(text, config);
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
        cancelSignal?.throwIfAborted();
        console.info(`[FishAudio][TTS] request attempt=${attempt + 1} url=${url} chars=${String(text || '').length}`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 90000);
        try {
            // Electron's session network stack follows Chromium/system proxy rules (for example Clash).
            const response = await session.defaultSession.fetch(url, {
                method: "POST",
                headers,
                body,
                signal: cancelSignal ? AbortSignal.any([cancelSignal, controller.signal]) : controller.signal
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
            cancelSignal?.throwIfAborted();
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
    const settings = FishAudio.normalizeConfig(config);
    const { apiBase, apiKey, voiceId, model, endpoint } = settings;
    if (!apiKey || !voiceId) throw new Error("请先填写 Fish Audio API Key 和音色 ID");

    const dir = path.join(app.getPath("userData"), "voice-presets", presetDirectoryKey(settings));
    await fs.mkdir(dir, { recursive: true });
    const manifest = { apiBase, voiceId, model, endpoint, groupA: [], groupB: [], groupC: [], updatedAt: Date.now() };

    for (let index = 0; index < PRESET_TEXTS_A.length; index += 1) {
        const filename = `a-${index}.mp3`;
        await fs.writeFile(path.join(dir, filename), await requestFishAudio(PRESET_TEXTS_A[index], settings));
        manifest.groupA.push(filename);
    }
    for (let index = 0; index < PRESET_TEXTS_B.length; index += 1) {
        const filename = `b-${index}.mp3`;
        await fs.writeFile(path.join(dir, filename), await requestFishAudio(PRESET_TEXTS_B[index], settings));
        manifest.groupB.push(filename);
    }
    for (let index = 0; index < PRESET_TEXTS_C.length; index += 1) {
        const filename = `c-${index}.mp3`;
        await fs.writeFile(path.join(dir, filename), await requestFishAudio(PRESET_TEXTS_C[index], settings));
        manifest.groupC.push(filename);
    }
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    return { ok: true, count: manifest.groupA.length + manifest.groupB.length + manifest.groupC.length };
}

async function readVoicePreset(config) {
    const settings = FishAudio.normalizeConfig(config);
    if (!settings.voiceId) return null;
    const dir = path.join(app.getPath("userData"), "voice-presets", presetDirectoryKey(settings));
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
        const payload = {
            dataUrl,
            displayId: String(display.id),
            quality: audioSession.settings.desktopImageQuality || "balanced"
        };
        audioWindow.webContents.send("desktop-work:screenshot-captured", payload);
        return payload;
    }
    return { dataUrl, displayId: String(display.id), quality: audioSession.settings.desktopImageQuality || "balanced" };
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

ipcMain.handle("desktop-work:capture-screenshot", async (event) => {
    if (!isAudioSender(event) || !audioSession || audioSession.mode !== "desktop") {
        throw new Error("桌面协作会话不存在");
    }
    return captureCurrentDisplayScreenshot();
});

ipcMain.handle("app:get-update-log", async (event) => {
    if (!isMainSender(event) && !desktopEnhancements.isPreferences(event)) throw new Error("非法的更新日志请求");
    return fs.readFile(path.join(__dirname, "..", "..", "UPDATE.md"), "utf8");
});

ipcMain.handle("agent:select-workspace", async (event, chatId) => {
    if (!isMainSender(event)) throw new Error("非法的 Agent 工作区请求");
    const store = getAgentWorkspaceStore();
    const existing = await store.get(chatId);
    if (existing.bound) {
        return {
            ...existing,
            environment: existing.path ? getEnvironmentDescription(existing.path) : ""
        };
    }
    const result = await dialog.showOpenDialog(mainWindow, {
        title: "选择 Agent 工作区",
        properties: ["openDirectory", "createDirectory"],
        buttonLabel: "绑定此工作区"
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const workspacePath = await fs.realpath(result.filePaths[0]);
    const stats = await fs.stat(workspacePath);
    if (!stats.isDirectory()) throw new Error("工作区必须是目录");
    const selectionId = crypto.randomUUID();
    for (const [pendingId, pending] of pendingAgentWorkspaceSelections) {
        if (pending.chatId !== String(chatId || "")) continue;
        clearTimeout(pending.expirationTimer);
        pendingAgentWorkspaceSelections.delete(pendingId);
    }
    const expirationTimer = setTimeout(() => {
        pendingAgentWorkspaceSelections.delete(selectionId);
    }, 10 * 60 * 1000);
    expirationTimer.unref?.();
    pendingAgentWorkspaceSelections.set(selectionId, {
        chatId: String(chatId || ""),
        workspacePath,
        expirationTimer
    });
    return {
        bound: false,
        exists: true,
        path: workspacePath,
        selectionId,
        canceled: false,
        requiresConfirmation: true,
        environment: getEnvironmentDescription(workspacePath)
    };
});

ipcMain.handle("agent:confirm-workspace", async (event, chatId, workspacePath, selectionId) => {
    if (!isMainSender(event)) throw new Error("非法的 Agent 工作区确认请求");
    const pending = pendingAgentWorkspaceSelections.get(String(selectionId || ""));
    if (!pending || pending.chatId !== String(chatId || "") || pending.workspacePath !== workspacePath) {
        throw new Error("工作区选择已失效，请重新选择");
    }
    clearTimeout(pending.expirationTimer);
    pendingAgentWorkspaceSelections.delete(String(selectionId));
    const binding = await getAgentWorkspaceStore().bind(chatId, workspacePath);
    return {
        ...binding,
        confirmed: true,
        environment: binding.path ? getEnvironmentDescription(binding.path) : ""
    };
});

ipcMain.handle("agent:get-workspace", async (event, chatId) => {
    if (!isMainSender(event)) throw new Error("非法的 Agent 工作区请求");
    const binding = await getAgentWorkspaceStore().get(chatId);
    return {
        ...binding,
        environment: binding.path ? getEnvironmentDescription(binding.path) : ""
    };
});

ipcMain.handle("agent:remove-workspace", async (event, chatId) => {
    if (!isMainSender(event)) throw new Error("非法的 Agent 工作区请求");
    return { removed: await getAgentWorkspaceStore().remove(chatId) };
});

ipcMain.handle("agent:get-command-settings", async (event) => {
    if (!isMainSender(event) && !desktopEnhancements.isPreferences(event)) throw new Error("非法的 Agent 命令设置请求");
    const paths = getAgentCommandPaths();
    return loadAllowedCommands(paths.defaultFile, paths.userFile);
});

ipcMain.handle("agent:save-command-additions", async (event, commands) => {
    if (!isMainSender(event) && !desktopEnhancements.isPreferences(event)) throw new Error("非法的 Agent 命令设置请求");
    const paths = getAgentCommandPaths();
    const additions = await saveUserAllowedCommands(paths.userFile, commands);
    return { success: true, additions };
});

ipcMain.handle("agent:add-allowed-command", async (event, prefix) => {
    if (!isMainSender(event)) throw new Error("非法的 Agent 命令设置请求");
    const paths = getAgentCommandPaths();
    const policy = await loadAllowedCommands(paths.defaultFile, paths.userFile);
    const nextPrefix = String(prefix || "").trim();
    const additions = await saveUserAllowedCommands(paths.userFile, [...policy.additions, nextPrefix]);
    return { success: true, additions };
});

ipcMain.handle("agent:check-command", async (event, command) => {
    if (!isMainSender(event)) throw new Error("非法的 Agent 命令请求");
    const paths = getAgentCommandPaths();
    const policy = await loadAllowedCommands(paths.defaultFile, paths.userFile);
    const matchedPrefix = findAllowedCommandPrefix(command, policy.all);
    return {
        allowed: Boolean(matchedPrefix),
        matchedPrefix,
        suggestedPrefix: deriveAllowedCommandPrefix(command)
    };
});

async function executeAgentShell(sender, source, args) {
    const executionId = String(source.executionId || "").trim();
    const failure = stderr => ({ stdout: "", stderr, exitCode: 1, success: false });
    if (!executionId) return failure("executionId is required");
    if (pendingAgentShells.has(executionId)) return failure(`execution id already in use: ${executionId}`);
    const pending = { cancelled: false, dispatched: false };
    pendingAgentShells.set(executionId, pending);
    try {
        const binding = await getAgentWorkspaceStore().get(source.chatId);
        if (pending.cancelled || isQuitting) return { stdout: "", stderr: "", exitCode: 1, cancelled: true };
        if (!binding.bound || !binding.exists) return { success: false, error: "bound workspace is unavailable" };
        const requestedTimeoutMs = Number(source.timeoutMs);
        const timeoutMs = Number.isFinite(requestedTimeoutMs)
            ? Math.min(Math.max(Math.round(requestedTimeoutMs), 5000), 3600000)
            : undefined;
        pending.dispatched = true;
        return await agentShell.call("run", [{ executionId, command: args.command, cwd: binding.realPath || binding.path, timeoutMs }], progress => {
            if (!sender.isDestroyed()) sender.send("agent:shell-progress", progress);
        });
    } catch (error) {
        return failure(error.message);
    } finally {
        pendingAgentShells.delete(executionId);
    }
}

ipcMain.handle("agent:execute-tool", async (event, request) => {
    if (!isMainSender(event)) throw new Error("非法的 Agent 工具请求");
    const source = request && typeof request === "object" ? request : {};
    const name = String(source.name || "");
    const args = source.arguments && typeof source.arguments === "object" ? source.arguments : {};
    if (name === "web_search") return runAgentWebSearch(args);
    if (name === "browse_web") {
        const url = String(args.url || '').trim();
        if (!/^https?:\/\//i.test(url)) return { success: false, error: 'valid http(s) url is required' };
        try {
            const html = await fetchPublicText(url, { baseUrl: url });
            return {
                success: true,
                url,
                text: stripHtmlText(html).slice(0, Math.min(Number(args.max_chars) || 12000, 50000))
            };
        } catch (error) {
            return { success: false, url, error: `抓取失败：${error.message}` };
        }
    }
    if (name === "run_shell") return executeAgentShell(event.sender, source, args);
    try {
        // A background process starts in its bound workspace and stays pollable
        // for the rest of the session, even after switching chats.
        if (name === "start_process") {
            const generation = agentBackgroundStartGeneration;
            const binding = await getAgentWorkspaceStore().get(source.chatId);
            if (generation !== agentBackgroundStartGeneration || isQuitting) return { success: false, cancelled: true };
            if (!binding.bound || !binding.exists) return { success: false, error: "bound workspace is unavailable" };
            return await agentShell.call("start", [{
                command: args.command,
                processId: args.process_id,
                cwd: binding.realPath || binding.path
            }]);
        }
        if (name === "read_process_output") return await agentShell.call("read", [args.process_id, { tail_bytes: args.tail_bytes }]);
        if (name === "list_processes") return await agentShell.call("list");
        if (name === "stop_process") return await agentShell.call("stop", [args.process_id]);
    } catch (error) {
        return { success: false, error: error.message };
    }
    const binding = await getAgentWorkspaceStore().get(source.chatId);
    if (!binding.bound || !binding.exists) {
        return { success: false, error: "bound workspace is unavailable" };
    }
    if (name === "read_file_range") return readFileRange(binding.realPath || binding.path, args);
    if (name === "write_file") return writeAgentFile(binding.realPath || binding.path, args);
    if (name === "edit_file") return editAgentFile(binding.realPath || binding.path, args);
    if (name === "multi_edit_file") return multiEditAgentFile(binding.realPath || binding.path, args);
    if (name === "apply_patch") return applyPatch(binding.realPath || binding.path, args);
    if (name === "glob_files") return globFiles(binding.realPath || binding.path, args);
    if (name === "delete_path") return deletePath(binding.realPath || binding.path, args);
    if (name === "move_path") return movePath(binding.realPath || binding.path, args);
    if (name === "copy_path") return copyPath(binding.realPath || binding.path, args);
    if (name === "list_dir") return listDir(binding.realPath || binding.path, args);
    if (name === "grep_files") return grepFiles(binding.realPath || binding.path, args);
    if (name === "view_image") {
        const result = await viewImage(binding.realPath || binding.path, args);
        const detail = String(args.detail || "medium").toLowerCase();
        if (!result?.success || !result.dataUrl || detail === "original") return result;
        const maxWidths = { low: 800, medium: 1400, high: 2200 };
        const maxWidth = maxWidths[detail] || maxWidths.medium;
        try {
            const image = nativeImage.createFromDataURL(result.dataUrl);
            const size = image.getSize();
            if (size.width > maxWidth) {
                const resized = image.resize({ width: maxWidth });
                result.dataUrl = `data:image/png;base64,${resized.toPNG().toString("base64")}`;
                result.width = maxWidth;
                result.height = Math.round(size.height * maxWidth / size.width);
                result.detail = detail;
            }
        } catch (_) { /* preserve original result if resize is unavailable */ }
        return result;
    }
    return { success: false, error: `unknown tool: ${name}` };
});

ipcMain.handle("agent:cancel-execution", async (event, executionId) => {
    if (!isMainSender(event)) throw new Error("非法的 Agent 工具请求");
    const id = String(executionId || "").trim();
    const pending = pendingAgentShells.get(id);
    if (!pending) return { canceled: false };
    if (pending.dispatched) return { canceled: await agentShell.call("cancel", [id]) };
    pending.cancelled = true;
    return { canceled: true };
});

ipcMain.handle("agent:list-processes", async (event) => {
    if (!isMainSender(event)) throw new Error("非法的 Agent 工具请求");
    return agentShell.call("list");
});

ipcMain.handle("agent:stop-all-processes", async (event) => {
    if (!isMainSender(event)) throw new Error("非法的 Agent 工具请求");
    agentBackgroundStartGeneration++;
    return { stopped: await agentShell.call("stopAll") };
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
    if (!isMainSender(event) && !desktopEnhancements.isPreferences(event)) throw new Error("非法的预制语音请求");
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
    const audio = await requestFishAudio(String(source.text || "").slice(0, 1000), source);
    return audio.toString("base64");
});
ipcMain.handle("desktop-work:tts", async (event, request) => {
    if (!isAudioSender(event)) throw new Error("非法的 Fish Audio 请求");
    const source = request && typeof request === "object" ? request : {};
    const audio = await requestFishAudio(String(source.text || "").slice(0, 1000), source);
    return audio.toString("base64");
});

const textSpeechRequests = new Map();

function isTextSpeechSender(event) {
    return isMainSender(event) && event.senderFrame && event.senderFrame === event.sender.mainFrame
        && event.senderFrame.url.split(/[?#]/, 1)[0] === pathToFileURL(path.join(__dirname, "..", "index.html")).href;
}

ipcMain.handle("text-speech:tts", async (event, request) => {
    if (!isTextSpeechSender(event)) throw new Error("非法的 Fish Audio 请求");
    const { id, text } = request || {};
    if (typeof id !== "string" || !id || textSpeechRequests.has(id) || typeof text !== "string" || !text.trim() || text.length > 1000) {
        throw new Error("无效的朗读请求");
    }
    const controller = new AbortController();
    const onDestroy = () => controller.abort();
    textSpeechRequests.set(id, controller);
    event.sender.once("destroyed", onDestroy);
    try {
        const audio = await requestFishAudio(text, request, controller.signal);
        return audio.toString("base64");
    } finally {
        textSpeechRequests.delete(id);
        if (!event.sender.isDestroyed()) event.sender.removeListener("destroyed", onDestroy);
    }
});

ipcMain.handle("text-speech:cancel", (event, id) => {
    if (isTextSpeechSender(event)) textSpeechRequests.get(id)?.abort();
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
    sendUpdateStatus();
});

ipcMain.on("app-state:update", (event, state) => {
    if (!isMainSender(event)) return;
    rendererRuntimeState = { agentRunning: state?.agentRunning === true, generating: state?.generating === true, compaction: state?.compaction === true };
    if (state && Object.prototype.hasOwnProperty.call(state, "developerMode")) {
        developerModeEnabled = Boolean(state.developerMode);
    }
    if (state && state.autoUpdateEnabled === true) checkForAppUpdates();
    refreshTrayMenu();
});

function trayTemplate() {
    const collaborationDisabled = hasConversationWindow();
    return [
        { label: "打开主页面", click: showMainWindow },
        { label: "Agent 网关", click: () => agentGateway.openConsole().catch(error => console.warn(`[AgentGateway] ${error.message}`)) },
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
    const icon = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "icons", "favicon.ico"));
    tray = new Tray(icon);
    tray.setToolTip("AIUI");
    refreshTrayMenu();
    tray.on("click", () => tray.popUpContextMenu());
}

/*app.whenReady().then(() => {
    createMainWindow();
    createTray();

    app.on("activate", () => {
        showMainWindow();
    });
});
*/

// 1. 请求单实例锁
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    // 如果获取锁失败，说明已有实例在运行，直接退出当前新启动的实例
    app.quit();
} else {
    // 2. 当第二个实例尝试启动时，触发此回调，调出已存在的第一个实例
    app.on("second-instance", (event, commandLine, workingDirectory) => {
        showMainWindow();
    });

    // 3. 正常初始化应用
    app.whenReady().then(() => {
        createMainWindow();
        createTray();

        app.on("activate", () => {
            showMainWindow();
        });
    });
}

app.on("before-quit", () => {
    isQuitting = true;
    agentGateway.dispose();
    clearDesktopShortcut();
});

app.on("will-quit", event => {
    if (agentShellShutdown === null) return;
    if (!agentShellShutdown) {
        agentShellShutdown = agentShell.shutdown();
        if (!agentShellShutdown) return;
        agentShellShutdown.finally(() => {
            agentShellShutdown = null;
            app.quit();
        });
    }
    event.preventDefault();
});

app.on("window-all-closed", () => {});
