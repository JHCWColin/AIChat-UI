'use strict';
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.join(os.tmpdir(), `aiui-archive-activity-${process.pid}`));
app.commandLine.appendSwitch('disable-gpu');
require('../main');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(cb, label) {
    const end = Date.now() + 30000;
    while (Date.now() < end) { const v = await Promise.resolve().then(cb).catch(() => null); if (v) return v; await sleep(120); }
    throw new Error('timeout ' + label);
}
const run = (win, src) => win.webContents.executeJavaScript(src, true);
setTimeout(() => { console.error('watchdog'); app.exit(1); }, 120000).unref();

app.whenReady().then(async () => {
    try {
        const main = await until(() => BrowserWindow.getAllWindows().find(w => /index\.html$/.test(w.webContents.getURL())), 'main');
        await run(main, "closeSetupGuide(); localStorage.setItem('first_setup_guide_shown','1')");
        await until(() => run(main, "Boolean(window.AIUIChatArchive && window.AgentActivity)"), 'archive ready');
        const result = await run(main, `(async () => {
            const chat = chats.find(c => c.id === activeChatId);
            chat.agentActivity = { files: 7, commands: 3, web: 1, writes: 2, added: 120, removed: 18 };
            chat.messages.push({ role: 'assistant', content: '活动统计测试', completedAt: Date.now() });
            const zip = await AIUIChatArchive.buildArchive();
            const data = JSON.parse(await zip.file('conversations.json').async('string'));
            const exported = data.chats.find(c => c.id === chat.id);
            const exportedActivity = exported && exported.agentActivity;
            // Losing the counters and re-importing the archive restores them once.
            delete chat.agentActivity;
            const file = new File([await zip.generateAsync({ type: 'uint8array' })], 'records.zip');
            await AIUIChatArchive.importChats(file);
            const afterFirst = { ...(chats.find(c => c.id === chat.id).agentActivity || {}) };
            await AIUIChatArchive.importChats(file);
            const afterSecond = { ...(chats.find(c => c.id === chat.id).agentActivity || {}) };
            return { exportedActivity, afterFirst, afterSecond };
        })()`);
        assert.deepEqual(result.exportedActivity, { files: 7, commands: 3, web: 1, writes: 2, added: 120, removed: 18 });
        assert.deepEqual(result.afterFirst, result.exportedActivity);
        assert.deepEqual(result.afterSecond, result.afterFirst, 'importing twice must not double the counters');
        console.log(JSON.stringify({ ok: true }));
    } catch (error) {
        console.error(error);
        app.exit(1);
        return;
    }
    app.exit(0);
});
