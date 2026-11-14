'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createTokenizerConfig } = require('./tokenizer-config');
const tokenizerRules = require('./tokenizer-rules');

function registerDesktopEnhancements({ app, BrowserWindow, ipcMain, Notification, getMainWindow, isMainSender, getRuntimeState }) {
    if (process.platform === 'win32') app.setAppUserModelId('com.jhcwcolin.aiui');
    let preferences = null;
    let worker = null;
    let sequence = 0;
    let theme = { theme: 'light', accent: '#10b981' };
    const pending = new Map();
    const tokenizerConfig = createTokenizerConfig(app);
    const isPreferences = event => Boolean(preferences && !preferences.isDestroyed() && event.sender === preferences.webContents && event.senderFrame === event.sender.mainFrame);
    const allowed = event => (isMainSender(event) && event.senderFrame === event.sender.mainFrame) || isPreferences(event);
    function requireAllowed(event) { if (!allowed(event)) throw new Error('非法的窗口请求'); }
    function broadcast(channel, payload) {
        for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
    function resetWorker(error) {
        const instance = worker;
        worker = null;
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
        pending.clear();
        if (instance) instance.terminate().catch(() => {});
    }
    function getWorker() {
        if (!worker) {
            const instance = new Worker(path.join(__dirname, 'tokenizer-worker.cjs'));
            worker = instance;
            instance.on('message', result => {
                const entry = pending.get(result.id);
                if (!entry) return;
                clearTimeout(entry.timer);
                pending.delete(result.id);
                result.error && !result.counts ? entry.reject(new Error(result.error)) : entry.resolve(result);
            });
            const fail = error => { if (worker === instance) resetWorker(error); };
            instance.on('error', fail);
            instance.on('exit', code => { if (worker === instance) resetWorker(new Error(`tokenizer worker exited (${code})`)); });
        }
        return worker;
    }
    function runCount(texts, model, extra = {}) {
        const instance = getWorker();
        return new Promise((resolve, reject) => {
            const id = ++sequence;
            const timer = setTimeout(() => {
                // A user vocabulary that never returns would otherwise wedge the
                // only counting worker for the rest of the session.
                pending.delete(id);
                resetWorker(new Error('tokenizer timeout'));
                reject(new Error('tokenizer timeout'));
            }, Number(extra.timeout) > 0 ? Number(extra.timeout) : 60000);
            pending.set(id, { resolve, reject, timer });
            const config = tokenizerConfig.readConfig();
            instance.postMessage({
                id,
                texts,
                model: String(model || ''),
                rules: extra.rules || config.tokenizerRules,
                defaultEngine: config.tokenizerDefault?.engine || 'builtin:fallback',
                storageDir: tokenizerConfig.filesDir(),
                files: tokenizerConfig.listFiles().map(file => file.id),
                preview: extra.preview || null
            });
        });
    }
    ipcMain.handle('context:count', (event, texts, model) => {
        requireAllowed(event);
        if (!Array.isArray(texts) || texts.length > 20000 || texts.some(text => typeof text !== 'string')) throw new Error('无效的 token 计数请求');
        return runCount(texts, model);
    });
    ipcMain.on('tokenizer:config-sync', event => {
        const defaults = tokenizerRules.normalizeConfig(null);
        event.returnValue = allowed(event) ? tokenizerConfig.publicConfig() : { ...defaults, files: [], storageDir: '' };
    });
    ipcMain.handle('tokenizer:get-config', event => { requireAllowed(event); return tokenizerConfig.publicConfig(); });
    ipcMain.handle('tokenizer:save-config', (event, payload) => {
        requireAllowed(event);
        const validation = tokenizerRules.validateConfig(payload);
        if (!validation.ok) return { ok: false, errors: validation.errors, conflicts: validation.conflicts };
        tokenizerConfig.writeConfig(validation.config);
        const config = tokenizerConfig.publicConfig();
        broadcast('tokenizer:config-changed', config);
        return { ok: true, config, conflicts: validation.conflicts };
    });
    ipcMain.handle('tokenizer:import-file', (event, payload) => {
        requireAllowed(event);
        const result = tokenizerConfig.importFile(payload);
        if (result.ok) broadcast('tokenizer:config-changed', result.config);
        return result;
    });
    ipcMain.handle('tokenizer:delete-file', (event, id) => {
        requireAllowed(event);
        const config = tokenizerConfig.deleteFile(id);
        broadcast('tokenizer:config-changed', config);
        return { ok: true, config };
    });
    ipcMain.handle('tokenizer:preview', async (event, payload) => {
        requireAllowed(event);
        const text = String(payload?.text || '').slice(0, 20000);
        const engine = String(payload?.engine || '');
        if (!text.trim()) return { ok: false, error: '请输入用于测试的文本' };
        if (!engine) return { ok: false, error: '请先选择计算方式' };
        try {
            const result = await runCount([text], String(payload?.model || ''), { preview: { engine }, timeout: 15000 });
            return { ok: true, count: result.counts[0], label: result.label, generic: result.generic };
        } catch (error) {
            return { ok: false, error: error.message || String(error) };
        }
    });
    ipcMain.handle('preferences:open', async event => {
        if (!isMainSender(event)) throw new Error('非法的设置请求');
        if (preferences && !preferences.isDestroyed()) { preferences.focus(); return; }
        const parent = getMainWindow();
        preferences = new BrowserWindow({
            title: '偏好设置 · AIUI', parent, modal: true, width: 1060, height: 820,
            minWidth: 360, minHeight: 600, show: false, autoHideMenuBar: true,
            backgroundColor: theme.theme === 'dark' ? '#212121' : '#f8f8f8',
            icon: path.join(__dirname, 'favicon.ico'),
            webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: false }
        });
        const win = preferences;
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.webContents.on('will-navigate', e => e.preventDefault());
        win.once('ready-to-show', () => win.show());
        win.on('close', event => {
            if (win.allowPreferencesClose) return;
            event.preventDefault();
            win.webContents.send('preferences:request-close');
        });
        win.on('closed', () => { if (preferences === win) preferences = null; });
        await win.loadFile(path.join(__dirname, 'index.html'), { query: { preferences: '1' } });
    });
    ipcMain.handle('preferences:close', event => {
        if (!isPreferences(event)) return;
        preferences.allowPreferencesClose = true;
        preferences.close();
    });
    ipcMain.handle('preferences:state', event => { requireAllowed(event); return getRuntimeState(); });
    ipcMain.on('preferences:changed', event => { if (allowed(event)) broadcast('preferences:changed'); });
    ipcMain.on('appearance:update', (event, value) => {
        if (!allowed(event)) return;
        theme = { theme: value?.theme === 'dark' ? 'dark' : 'light', accent: /^#[0-9a-f]{6}$/i.test(value?.accent) ? value.accent : '#10b981' };
        broadcast('appearance:changed', theme);
    });
    ipcMain.handle('appearance:get', () => theme);
    ipcMain.handle('agent:notify', (event, payload) => {
        if (!isMainSender(event)) return false;
        const main = getMainWindow();
        if (main?.isFocused() || !Notification.isSupported() || !['completed', 'question'].includes(payload?.type)) return false;
        const notification = new Notification({ title: payload.type === 'question' ? 'Agent 需要你的回答' : 'Agent 任务已完成',
            body: String(payload.body || '').slice(0, 240), silent: false, icon: path.join(__dirname, 'icon.png') });
        notification.on('click', () => { if (main && !main.isDestroyed()) { if (main.isMinimized()) main.restore(); main.show(); main.focus(); } });
        notification.show();
        return true;
    });
    app.once('before-quit', () => { if (preferences) preferences.allowPreferencesClose = true; worker?.terminate(); });
    return { isPreferences };
}
module.exports = { registerDesktopEnhancements };
