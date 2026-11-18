'use strict';
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.join(os.tmpdir(), `aiui-round-${process.pid}`));
app.commandLine.appendSwitch('disable-gpu');
require('../main/main');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(cb, label) {
    const end = Date.now() + 30000;
    while (Date.now() < end) { const v = await Promise.resolve().then(cb).catch(() => null); if (v) return v; await sleep(120); }
    throw new Error('timeout ' + label);
}
const run = (win, src) => win.webContents.executeJavaScript(src, true);
setTimeout(() => { console.error('watchdog'); app.exit(1); }, 90000).unref();

app.whenReady().then(async () => {
    try {
        const main = await until(() => BrowserWindow.getAllWindows().find(w => /index\.html$/.test(w.webContents.getURL())), 'main');
        await run(main, "closeSetupGuide(); localStorage.setItem('first_setup_guide_shown','1')");
        await until(() => run(main, "Boolean(window.appendAgentRoundSummaryUI && window.AgentActivity)"), 'api ready');

        await run(main, `(() => {
            const chat = chats.find(c => c.id === activeChatId);
            chat.agentEnabled = true;
            chat.messages = [
                { role: 'user', content: '帮我改代码' },
                { role: 'assistant', content: '', reasoning: '先读文件再决定', hidden: true, agentThinking: true, agentToolResponse: true, thinkingDurationMs: 1200 },
                { role: 'tool', name: 'read_file_range', toolName: 'read_file_range', arguments: { path: 'a.js', start_line: 1, end_line: 10 }, status: 'done', result: { success: true, path: 'a.js', actualStartLine: 1, actualEndLine: 10, returnedLines: 10 }, toolId: 't-read', taskDurationMs: 80 },
                { role: 'tool', name: 'run_shell', toolName: 'run_shell', arguments: { command: 'node -v' }, status: 'done', result: { success: true, exitCode: 0, stdout: 'v22', durationMs: 60 }, toolId: 't-shell', taskDurationMs: 60 },
                { role: 'tool', name: 'write_file', toolName: 'write_file', arguments: { path: 'b.js', content: 'x' }, status: 'done', result: { success: true, charactersWritten: 1 }, displayDiff: { addedLines: 3, removedLines: 0 }, toolId: 't-write' },
                { role: 'assistant', content: '已完成修改', agentFinal: true, agentDisplayOnly: true, completedAt: Date.now(), model: 'gpt-5.6-terra' },
                { role: 'tool', name: 'finish_task', toolName: 'finish_task', arguments: {}, status: 'done', result: { success: true }, content: '{}', toolId: 't-finish' }
            ];
        })()`);

        await run(main, "renderMessagesWithResolvedRefs(chats.find(c=>c.id===activeChatId).messages)");
        await sleep(400);

        const state = await run(main, `(() => ({
            summaries: document.querySelectorAll('.agent-round-summary-wrapper').length,
            summaryLabel: document.querySelector('.agent-round-summary .agent-tool-summary-text')?.textContent || '',
            toolRows: document.querySelectorAll('.chat-row.agent-tool-row-wrapper').length,
            finalRows: document.querySelectorAll('.agent-final-row').length,
            detailOpen: document.querySelector('.agent-round-detail')?.classList.contains('is-open') || false
        }))()`);
        assert.equal(state.summaries, 1);
        assert.match(state.summaryLabel, /探索 1 个文件/);
        assert.match(state.summaryLabel, /运行 1 条指令/);
        assert.match(state.summaryLabel, /编辑 1 处文件/);
        assert.equal(state.toolRows, 0, 'intermediates must be collapsed on load');
        assert.equal(state.finalRows, 1);
        assert.equal(state.detailOpen, false);

        // Expand -> intermediates render lazily.
        await run(main, "document.querySelector('.agent-round-summary').click()");
        await sleep(300);
        const expanded = await run(main, `(() => ({
            detailOpen: document.querySelector('.agent-round-detail')?.classList.contains('is-open') || false,
            toolRows: document.querySelectorAll('.agent-round-detail .chat-row.agent-tool-row-wrapper:not(.agent-thinking-row)').length,
            thinking: document.querySelectorAll('.agent-round-detail .agent-thinking-row').length
        }))()`);
        assert.equal(expanded.detailOpen, true);
        assert.equal(expanded.toolRows, 3);
        assert.equal(expanded.thinking, 1);

        console.log(JSON.stringify({ ok: true }));
    } catch (error) {
        console.error(error);
        app.exit(1);
        return;
    }
    app.exit(0);
});
