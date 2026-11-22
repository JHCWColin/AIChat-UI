'use strict';
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
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
function openingAnimation(win, panelSelector, click) {
    return run(win, `(() => {
        const panel = document.querySelector(${JSON.stringify(panelSelector)});
        const collapsed = panel.getBoundingClientRect().height;
        ${click};
        void panel.offsetHeight;
        const transition = panel.getAnimations().find(item => item.transitionProperty === 'grid-template-rows');
        if (!transition) return { collapsed, animating: false };
        transition.pause();
        transition.currentTime = 30;
        const early = panel.getBoundingClientRect().height;
        transition.currentTime = 160;
        const late = panel.getBoundingClientRect().height;
        transition.play();
        return { collapsed, animating: late > early };
    })()`);
}
setTimeout(() => { console.error('watchdog'); app.exit(1); }, 90000).unref();

app.whenReady().then(async () => {
    try {
        const main = await until(() => BrowserWindow.getAllWindows().find(w => /index\.html$/.test(w.webContents.getURL())), 'main');
        await until(() => run(main, "Boolean(window.appendAgentRoundSummaryUI && window.AgentActivity)"), 'api ready');
        await until(() => run(main, "document.getElementById('setup-guide-modal').classList.contains('modal-active')"), 'first-run guide');
        await run(main, "localStorage.setItem('first_setup_guide_shown','1'); closeSetupGuide()");

        await run(main, `(() => {
            setTheme('dark');
            localStorage.setItem('agent_diff_max_lines','10');
            localStorage.setItem('agent_detail_default_behavior','expanded');
            const chat = chats.find(c => c.id === activeChatId);
            chat.agentEnabled = true;
            updateAgentUIForChat(chat);
            chat.messages = [
                { role: 'user', content: Array.from({ length: 14 }, (_, i) => (i + 1) + '．请帮我检查这次代码变更，并在运行完测试后总结结果。').join('\\n') },
                { role: 'assistant', content: '我先看一下项目结构。', agentSegment: true },
                { role: 'assistant', content: '', reasoning: '先读文件再决定', hidden: true, agentThinking: true, agentToolResponse: true, thinkingDurationMs: 1200 },
                { role: 'tool', name: 'read_file_range', toolName: 'read_file_range', arguments: { path: 'src/a.js', start_line: 1, end_line: 15 }, status: 'done', result: { success: true, path: 'src/a.js', actualStartLine: 1, actualEndLine: 15, content: Array.from({ length: 15 }, (_, i) => 'const value' + i + ' = ' + i + ';').join('\\n') }, toolId: 't-read' },
                { role: 'tool', name: 'run_shell', toolName: 'run_shell', arguments: { command: 'node -v' }, status: 'done', result: { success: true, exitCode: 0, stdout: 'v22', durationMs: 60 }, toolId: 't-shell' },
                { role: 'assistant', content: '我会调整初始化逻辑，再运行测试。', agentSegment: true },
                { role: 'tool', name: 'write_file', toolName: 'write_file', arguments: { path: 'b.js', content: 'x' }, status: 'done', result: { success: true, charactersWritten: 1 }, displayDiff: { addedLines: 3, removedLines: 2 }, toolId: 't-write' },
                { role: 'tool', name: 'run_shell', toolName: 'run_shell', arguments: { command: 'npm test' }, status: 'error', result: { success: false, exitCode: 1, stderr: 'AssertionError', durationMs: 99 }, toolId: 't-error' },
                { role: 'assistant', content: '已完成修改', agentFinal: true, agentDisplayOnly: true, completedAt: Date.now(), model: 'gpt-5.6-terra' },
                { role: 'tool', name: 'finish_task', toolName: 'finish_task', arguments: {}, status: 'done', result: { success: true }, content: '{}', toolId: 't-finish', taskDurationMs: 62800 }
            ];
        })()`);

        await run(main, "renderMessagesWithResolvedRefs(chats.find(c=>c.id===activeChatId).messages)");
        await sleep(400);

        const state = await run(main, `(() => ({
            summaries: document.querySelectorAll('.agent-round-summary-wrapper').length,
            labels: Array.from(document.querySelectorAll('.agent-round-summary .agent-tool-summary-text'), el => el.textContent),
            diff: Array.from(document.querySelectorAll('.agent-round-summary :is(.agent-diff-add,.agent-diff-remove)'), el => el.textContent).filter(Boolean),
            prose: Array.from(document.querySelectorAll('#messages-wrapper > .agent-segment-row .ai-content-area'), el => el.textContent.trim()),
            toolRows: document.querySelectorAll('.chat-row.agent-tool-row-wrapper').length,
            finalRows: document.querySelectorAll('.agent-final-row').length,
            detailOpen: document.querySelector('.agent-round-detail')?.classList.contains('is-open') || false
        }))()`);
        assert.equal(state.summaries, 2);
        assert.deepEqual(state.labels, ['Ran 1 command, read 1 file', 'Edited 1 file, 1 failed']);
        assert.deepEqual(state.diff, ['+3', '−2']);
        assert.deepEqual(state.prose, ['我先看一下项目结构。', '我会调整初始化逻辑，再运行测试。']);
        assert.equal(state.toolRows, 0, 'intermediates must be collapsed on load');
        assert.equal(state.finalRows, 1);
        assert.equal(state.detailOpen, false);
        const surfaces = await run(main, `(() => {
            const wrapper = document.getElementById('messages-wrapper').getBoundingClientRect();
            const bubble = document.querySelector('.user-bubble');
            const user = getComputedStyle(bubble);
            const input = getComputedStyle(document.querySelector('.input-area'));
            return { background: getComputedStyle(document.body).backgroundImage,
                column: getComputedStyle(document.getElementById('chat-column')).backgroundColor,
                user: [user.backgroundColor, user.backdropFilter], input: [input.backgroundColor, input.backdropFilter],
                userInset: bubble.getBoundingClientRect().left - wrapper.left };
        })()`);
        assert.match(surfaces.background, /assets\/backgrounds\//);
        assert.equal(surfaces.column, 'rgba(0, 0, 0, 0)');
        assert.match(surfaces.user[0], /^rgba/);
        assert.match(surfaces.user[1], /blur/);
        assert.match(surfaces.input[0], /^rgba/);
        assert.match(surfaces.input[1], /blur/);
        assert.deepEqual(surfaces.user, surfaces.input);
        assert.ok(surfaces.userInset > 36);
        const footerAppearance = await run(main, `(() => {
            const duration = document.querySelector('.response-worked-duration');
            const footer = duration.parentElement;
            const size = getComputedStyle(document.querySelector('.agent-round-summary')).fontSize;
            const time = getComputedStyle(footer.querySelector('.message-time'));
            const icon = getComputedStyle(footer.querySelector('.message-icon-btn svg'));
            return [duration.textContent, footer.previousElementSibling.classList.contains('ai-bubble'),
                !footer.querySelector('.message-model') && duration === footer.firstElementChild && duration.nextElementSibling.matches('.message-time'),
                getComputedStyle(duration).fontSize === size && time.fontSize === size && Math.abs(parseFloat(icon.width) - parseFloat(size)) < .1];
        })()`);
        assert.deepEqual(footerAppearance, ['Worked for 1m 2s', true, true, true]);
        assert.equal(await run(main, `(() => {
            const transcript = document.getElementById('messages-wrapper');
            const spacer = document.createElement('div');
            spacer.style.height = '400px';
            transcript.append(spacer);
            try {
                transcript.scrollTo({ top: 0, behavior: 'instant' });
                showVoiceNotification('Syncing…', false, 800);
                return transcript.scrollHeight > transcript.clientHeight &&
                    Math.abs(transcript.scrollTop + transcript.clientHeight - transcript.scrollHeight) < 2;
            } finally {
                spacer.remove();
            }
        })()`), true);

        const userToggle = "document.querySelector('.user-message-toggle')";
        assert.equal(await run(main, `${userToggle}.textContent`), 'Show more');
        assert.equal(await run(main, 'document.querySelector(".user-message-clip").classList.contains("is-clipped")'), true);
        await run(main, `${userToggle}.click()`);
        assert.equal(await run(main, `${userToggle}.textContent`), 'Show less');
        assert.equal(await run(main, 'document.querySelector(".user-message-clip").classList.contains("is-clipped")'), false);
        await run(main, `${userToggle}.click()`);

        // Expand -> intermediates render lazily.
        assert.deepEqual(await openingAnimation(main, '.agent-round-detail',
            "document.querySelector('.agent-round-summary').click()"), { collapsed: 0, animating: true });
        await sleep(300);
        const expanded = await run(main, `(() => ({
            detailOpen: document.querySelector('.agent-round-detail')?.classList.contains('is-open') || false,
            toolRows: document.querySelectorAll('.agent-round-detail .chat-row.agent-tool-row-wrapper:not(.agent-thinking-row)').length,
            thinking: document.querySelectorAll('.agent-round-detail .agent-thinking-row').length
        }))()`);
        assert.equal(expanded.detailOpen, true);
        assert.equal(expanded.toolRows, 2);
        assert.equal(expanded.thinking, 1);
        assert.match(await run(main, "getComputedStyle(document.querySelector('.agent-round-detail')).transitionProperty"), /grid-template-rows/);
        const readStep = "document.querySelector('[data-agent-tool-id=t-read] .agent-tool-summary')";
        assert.equal(await run(main, "document.querySelectorAll('.agent-round-detail .agent-tool-summary[aria-expanded=true]').length"), 0);
        assert.deepEqual(await openingAnimation(main, '[data-agent-tool-id=t-read] .agent-tool-preview',
            `${readStep}.click()`), { collapsed: 0, animating: true });
        assert.match(await run(main, "getComputedStyle(document.querySelector('[data-agent-tool-id=t-read] .agent-tool-preview')).transitionProperty"), /grid-template-rows/);
        assert.equal(await run(main, "document.querySelector('.agent-full-output').open"), false);
        await run(main, "document.querySelector('.agent-full-output summary').click()");
        await until(() => run(main, "document.querySelectorAll('.agent-full-output .agent-tool-preview-line').length === 15"), 'full output');
        await run(main, "renderMessagesWithResolvedRefs(chats.find(c=>c.id===activeChatId).messages)");
        assert.equal(await run(main, "document.querySelector('.agent-full-output').open"), true);
        await run(main, "const groupSummary = document.querySelector('.agent-round-summary'); groupSummary.click(); groupSummary.click()");
        assert.equal(await run(main, `${readStep}.getAttribute('aria-expanded')`), 'false');
        assert.equal(await run(main, "document.querySelector('.agent-full-output').open"), false);

        const copy = "document.querySelector('.agent-final-row .message-footer > .copy-icon-btn')";
        assert.deepEqual(await run(main, `(() => {
            const button = ${copy}, style = getComputedStyle(button);
            return [button === button.parentElement.lastElementChild, button.textContent, style.opacity, style.backgroundColor];
        })()`), [true, '', '0', 'rgba(0, 0, 0, 0)']);
        await run(main, "const draft = document.getElementById('user-input'); draft.value = '11111'; autoResize(draft)");
        assert.deepEqual(await run(main, `(() => {
            const send = document.getElementById('send-btn');
            return [Boolean(send.querySelector('svg.lucide-corner-down-left')), getComputedStyle(send).backgroundColor];
        })()`), [true, 'rgba(0, 0, 0, 0)']);
        const cdp = main.webContents.debugger;
        cdp.attach('1.3');
        try {
            await cdp.sendCommand('DOM.enable');
            await cdp.sendCommand('CSS.enable');
            const { root } = await cdp.sendCommand('DOM.getDocument');
            for (const selector of ['.agent-final-row .message-footer', '.agent-final-row .copy-icon-btn', '#send-btn']) {
                const { nodeId } = await cdp.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
                await cdp.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
            }
            await until(() => run(main, `getComputedStyle(${copy}).opacity === '1'`), 'copy hover animation');
            const hover = await run(main, `[getComputedStyle(${copy}).opacity, getComputedStyle(${copy}).backgroundColor,
                getComputedStyle(document.getElementById('send-btn')).backgroundColor]`);
            assert.equal(hover[0], '1');
            assert.match(hover[1], /^rgba\(\d+, \d+, \d+, 0\.\d+\)$/);
            assert.equal(hover[1], hover[2]);
        } finally {
            cdp.detach();
        }
        const copiedText = await run(main, `(async () => {
            let copied = '';
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copied = text; } } });
            try { await ${copy}.onclick(); } finally { delete navigator.clipboard; }
            return copied;
        })()`);
        await until(() => run(main, `Boolean(${copy}.querySelector('svg.lucide-check'))`), 'copy icon feedback');
        assert.equal(copiedText, '已完成修改');

        assert.equal(await run(main, `(() => {
            const [first, second] = document.querySelectorAll('.agent-round-summary');
            second.click();
            const arrow = document.querySelector('.agent-round-detail .agent-tool-row.failed .agent-tool-toggle');
            const sample = document.createElement('span');
            sample.style.color = 'var(--conversation-muted)';
            document.body.append(sample);
            const isGray = getComputedStyle(arrow).color === getComputedStyle(sample).color;
            sample.remove();
            const nodes = [first, document.querySelector('.response-worked-duration'),
                document.querySelector('.message-time'), arrow.closest('.agent-tool-row'),
                arrow.closest('.agent-tool-row').querySelector('.agent-tool-preview-content')];
            const size = () => nodes.map(node => parseFloat(getComputedStyle(node).fontSize));
            const before = size();
            setFontSize('huge', document.querySelector('.font-btn:last-child'));
            const grows = size().every((value, index) => value > before[index]);
            setFontSize('medium', null);
            second.click();
            return isGray && grows;
        })()`), true);

        if (process.env.AIUI_UI_SCREENSHOTS) {
            await run(main, "hideVoiceNotification(); document.getElementById('messages-wrapper').scrollTo({ top: 0, behavior: 'instant' })");
            await sleep(200);
            await fs.writeFile(path.join(os.tmpdir(), 'aiui-activity-view.png'), (await main.webContents.capturePage()).toPNG());
        }

        console.log(JSON.stringify({ ok: true }));
    } catch (error) {
        console.error(error);
        app.exit(1);
        return;
    }
    app.exit(0);
});
