'use strict';
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.join(os.tmpdir(), `aiui-sidebar-${process.pid}`));
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
        await run(main, "closeSetupGuide(); localStorage.setItem('first_setup_guide_shown','1'); window.electronAPI.openPreferences()");
        const prefs = await until(() => BrowserWindow.getAllWindows().find(w => /preferences=1/.test(w.webContents.getURL())), 'prefs');
        await until(() => run(prefs, "Boolean(document.getElementById('agent-shell-timeout-seconds'))"), 'prefs ready');

        // Every setting control outside 使用指导/关于 must live inside a card.
        const bare = await run(prefs, `(() => {
            const issues = [];
            for (const section of document.querySelectorAll('.settings-content-section')) {
                const id = section.id.replace('section-', '');
                if (id === 'guide' || id === 'about') continue;
                for (const el of section.querySelectorAll('input,select,textarea,button')) {
                    // Header-level buttons (e.g. 恢复默认) sit next to the title,
                    // not inside a card, by design.
                    if (el.closest('h3') || el.closest('.flex.items-start.justify-between') || el.closest('#api-settings-actions')) continue;
                    let node = el.parentElement, inside = false;
                    while (node && node !== section) {
                        if (node.classList.contains('bg-[#1a1a1a]')) { inside = true; break; }
                        node = node.parentElement;
                    }
                    if (!inside) issues.push(id + ':' + (el.id || el.className.split(' ')[0]));
                }
            }
            return { issues, counts: [...document.querySelectorAll('.settings-content-section')].map(sec => sec.id.replace('section-','')) };           return issues;
        })()`);
        if (bare.issues.length) { console.error('BARE', JSON.stringify(bare)); }
        assert.deepEqual(bare.issues, [], 'controls outside a card');

        // Empty activity keeps the panel hidden.
        await run(main, `(() => {
            const chat = chats.find(c => c.id === activeChatId);
            chat.agentEnabled = true;
            document.body.classList.add('agent-mode','agent-info-open');
            delete chat.agentActivity;
            window.AIUIEnhancements.refreshAgentSidebar();
        })()`);
        await sleep(400);
        assert.equal(await run(main, "document.getElementById('agent-sidebar-diff-section').hidden"), true);
        // Panel title is now 统计信息.
        assert.equal(await run(main, "document.querySelector('#agent-sidebar-diff-section h3').textContent"), '统计信息');

        // Activity renders one row per metric with animated numbers.
        await run(main, `(() => {
            const chat = chats.find(c => c.id === activeChatId);
            chat.agentActivity = { files: 12, commands: 3, web: 2, writes: 2, added: 103, removed: 5 };
            window.AIUIEnhancements.refreshAgentSidebar();
        })()`);
        await until(() => run(main, "document.getElementById('agent-sidebar-diff-section').hidden === false"), 'panel visible');
        const labels = await run(main, "[...document.querySelectorAll('#agent-sidebar-diff .agent-sidebar-metric-label')].map(node => node.textContent)");
        assert.deepEqual(labels, ['探索文件', '运行指令', '浏览网页', '文件变更', '代码变更']);
        await until(() => run(main, "document.querySelector('[data-metric=\"files\"]').dataset.value === '12'"), 'files settled');
        assert.equal(await run(main, "document.querySelector('[data-metric=\"files\"] .metric-roll-cell:first-child').textContent"), '12');
        await until(() => run(main, "document.querySelector('[data-metric=\"added\"]').dataset.value === '103'"), 'added settled');
        await until(() => run(main, "document.querySelector('[data-metric=\"removed\"]').dataset.value === '5'"), 'removed settled');
        assert.equal(await run(main, "document.querySelector('[data-metric=\"added\"] .metric-roll-cell:first-child').textContent"), '+103');
        assert.equal(await run(main, "document.querySelector('[data-metric=\"removed\"] .metric-roll-cell:first-child').textContent"), '-5');
        assert.equal(await run(main, "getComputedStyle(document.querySelector('[data-metric=\"added\"]')).color"), 'rgb(52, 211, 153)');
        assert.equal(await run(main, "getComputedStyle(document.querySelector('[data-metric=\"removed\"]')).color"), 'rgb(248, 113, 113)');

        // Only the populated rows survive.
        await run(main, `(() => {
            const chat = chats.find(c => c.id === activeChatId);
            chat.agentActivity = { files: 0, commands: 4, web: 0, writes: 0, added: 0, removed: 0 };
            window.AIUIEnhancements.refreshAgentSidebar();
        })()`);
        await until(() => run(main, "document.querySelectorAll('#agent-sidebar-diff .agent-sidebar-metric').length === 1"), 'single row');
        assert.deepEqual(await run(main, "[...document.querySelectorAll('#agent-sidebar-diff .agent-sidebar-metric-label')].map(node => node.textContent)"), ['运行指令']);

        // Counters survive the agent chat persistence path.
        await run(main, `(() => {
            const chat = chats.find(c => c.id === activeChatId);
            chat.agentActivity = { files: 4, commands: 1, web: 0, writes: 1, added: 20, removed: 6 };
            window.persistAgentChats ? window.persistAgentChats() : null;
        })()`);
        await sleep(500);
        const stored = await run(main, "(() => { const raw = JSON.parse(localStorage.getItem('ai_chats') || '[]'); const chat = raw.find(c => c.id === activeChatId); return chat && chat.agentActivity; })()");
        assert.deepEqual(stored, { files: 4, commands: 1, web: 0, writes: 1, added: 20, removed: 6 });

        // Roll animation: 2 → 4 steps directly (the tape only ever holds 2 and 4,
        // never an intermediate 3).
        await run(main, `(() => { const chat=chats.find(c=>c.id===activeChatId); chat.agentActivity={files:2,commands:0,web:0,writes:0,added:0,removed:0}; window.AIUIEnhancements.refreshAgentSidebar(); })()`);
        await until(() => run(main, "document.querySelector('[data-metric=\"files\"]')?.dataset.value === '2'"), 'files set to 2');
        await run(main, `(() => { const chat=chats.find(c=>c.id===activeChatId); chat.agentActivity={files:4,commands:0,web:0,writes:0,added:0,removed:0}; window.AIUIEnhancements.refreshAgentSidebar(); })()`);
        assert.deepEqual(await run(main, "[...document.querySelectorAll('[data-metric=\"files\"] .metric-roll-cell')].map(c => c.textContent)"), ['4', '2']);
        await until(() => run(main, "document.querySelector('[data-metric=\"files\"]').dataset.value === '4'"), 'files rolled to 4');
        assert.equal(await run(main, "document.querySelector('[data-metric=\"files\"] .metric-roll-cell:first-child').textContent"), '4');

        console.log(JSON.stringify({ ok: true }));
    } catch (error) {
        console.error(error);
        app.exit(1);
        return;
    }
    app.exit(0);
});
