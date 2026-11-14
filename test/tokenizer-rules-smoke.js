'use strict';
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const profile = path.join(os.tmpdir(), `aiui-rules-e2e-${process.pid}`);
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-gpu');
require('../main');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(cb, label) {
    const end = Date.now() + 30000;
    while (Date.now() < end) { const v = await cb(); if (v) return v; await sleep(120); }
    throw new Error('timeout ' + label);
}
const run = (win, src) => win.webContents.executeJavaScript(src, true);
setTimeout(() => { console.error('watchdog'); app.exit(1); }, 150000).unref();

const WORD_LEVEL = JSON.stringify({
    version: '1.0', truncation: null, padding: null, added_tokens: [],
    normalizer: null, pre_tokenizer: { type: 'Whitespace' }, post_processor: null, decoder: null,
    model: { type: 'WordLevel', vocab: { '[UNK]': 0, hello: 1, '你好': 2, world: 3 }, unk_token: '[UNK]' }
});

app.whenReady().then(async () => {
    try {
        const main = await until(() => BrowserWindow.getAllWindows().find(w => /index\.html$/.test(w.webContents.getURL())), 'main');
        await run(main, "closeSetupGuide(); localStorage.setItem('first_setup_guide_shown','1'); window.electronAPI.openPreferences()");
        const prefs = await until(() => BrowserWindow.getAllWindows().find(w => /preferences=1/.test(w.webContents.getURL())), 'prefs');
        await until(() => run(prefs, "Boolean(document.getElementById('tokenizer-rule-list'))"), 'ready');
        await run(prefs, "switchSettingsSection('tokenizer', document.querySelector('[data-section=tokenizer]'))");

        // Built-in rules now include a local Claude vocabulary.
        assert.equal(await run(prefs, "getTokenizerConfig().tokenizerRules.some(r => r.engine === 'builtin:anthropic')"), true);
        assert.equal(await run(prefs, "document.querySelectorAll('#tokenizer-rule-list .rule-row').length"), await run(prefs, "getTokenizerConfig().tokenizerRules.length + 1")); // rules + draft row

        // An invalid upload is rejected and never stored.
        await run(prefs, `(async () => {
            const bad = new File(['{oops'], 'bad.json', { type:'application/json' });
            await uploadTokenizerFile({ files:[bad], value:'' });
        })()`);
        assert.equal(await run(prefs, "getTokenizerConfig().files.length"), 0);
        assert.match(String(await run(prefs, "document.getElementById('tokenizer-file-status').textContent")), /JSON 解析失败/);

        // A real HuggingFace tokenizer.json is stored and preselected.
        await run(prefs, `(async () => {
            const good = new File([${JSON.stringify(WORD_LEVEL)}], 'qwen-tokenizer.json', { type:'application/json' });
            await uploadTokenizerFile({ files:[good], value:'' });
        })()`);
        await until(() => run(prefs, "getTokenizerConfig().files.length === 1"), 'file stored');
        assert.match(String(await run(prefs, "document.getElementById('tokenizer-file-status').textContent")), /已导入/);

        // Inline editor: type a new model name, the draft engine already points at the file.
        await run(prefs, `(() => { const input=document.getElementById('new-rule-pattern-tokenizer'); input.value='Qwen'; input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
        await until(() => run(prefs, "getTokenizerConfig().tokenizerRules.some(r => r.pattern === 'Qwen')"), 'tokenizer rule added');
        assert.equal(await run(prefs, "getTokenizerConfig().tokenizerRules.find(r => r.pattern === 'Qwen').engine.startsWith('file:')"), true);
        await sleep(250);

        // Drag the last rule above the first one with the grip handle.
        await run(prefs, `(() => {
            const list = document.getElementById('tokenizer-rule-list');
            const rows = [...list.querySelectorAll('.rule-row[data-id]')];
            const from = rows[rows.length - 1];
            const to = rows[0];
            from.querySelector('.rule-drag').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
            const dataTransfer = new DataTransfer();
            from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
            const rect = to.getBoundingClientRect();
            to.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer, clientY: rect.top + 2 }));
            from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
        })()`);
        await until(() => run(prefs, "getTokenizerConfig().tokenizerRules[0].pattern === 'Qwen'"), 'drag reorder applied');
        assert.equal(await run(prefs, "document.querySelector('#tokenizer-rule-list .rule-row[data-id] .rule-pattern-input').value"), 'Qwen');

        // The uploaded vocabulary now wins because the rule sits at the top.
        const counted = await run(main, "window.electronAPI.countContextBatch(['hello 你好 world'], 'Qwen3-32B')");
        assert.equal(counted.counts[0], 3, JSON.stringify(counted));
        assert.equal(counted.generic, false);

        // Context capacity: inline value + inline model name.
        await run(prefs, "switchSettingsSection('context-capacity', document.querySelector('[data-section=context-capacity]'))");
        await run(prefs, `(() => {
            const value=document.querySelector('#context-rule-list .rule-new .rule-value');
            value.value='512K'; value.dispatchEvent(new Event('input',{bubbles:true}));
            const pattern=document.getElementById('new-rule-pattern-context');
            pattern.value='MiniMax'; pattern.dispatchEvent(new Event('input',{bubbles:true})); pattern.dispatchEvent(new Event('change',{bubbles:true}));
        })()`);
        await until(() => run(prefs, "getTokenizerConfig().contextRules.some(r => r.pattern === 'MiniMax')"), 'capacity rule added');
        assert.equal(await run(prefs, "getTokenizerConfig().contextRules.find(r => r.pattern === 'MiniMax').value"), 512000);
        await sleep(250);
        assert.equal(await run(main, "getContextWindowForModel('MiniMax-M2')"), 512000);

        // The same grip handle reorders capacity rules.
        await run(prefs, `(() => {
            const list = document.getElementById('context-rule-list');
            const rows = [...list.querySelectorAll('.rule-row[data-id]')];
            const from = rows[rows.length - 1];
            const to = rows[0];
            from.querySelector('.rule-drag').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
            const dataTransfer = new DataTransfer();
            from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
            const rect = to.getBoundingClientRect();
            to.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer, clientY: rect.top + 2 }));
            from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
        })()`);
        await until(() => run(prefs, "getTokenizerConfig().contextRules[0].pattern === 'MiniMax'"), 'context drag reorder');
        assert.equal(await run(main, "getContextWindowForModel('MiniMax-M2')"), 512000);

        // The default row is a real editable rule.
        await run(prefs, `(() => { const input=document.querySelector('#context-default-row .rule-value'); input.value='256K'; input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
        await until(() => run(prefs, "getTokenizerConfig().contextDefault.value === 256000"), 'default edited');
        await sleep(250);
        assert.equal(await run(main, "getContextWindowForModel('totally-unknown-model')"), 256000);
        assert.equal(await run(prefs, "document.querySelector('#context-default-row .rule-value').value"), '256K');

        // Conflicts are surfaced for a shadowed rule.
        await run(prefs, `(() => {
            const pattern=document.getElementById('new-rule-pattern-context');
            const value=document.querySelector('#context-rule-list .rule-new .rule-value');
            value.value='200K'; value.dispatchEvent(new Event('input',{bubbles:true}));
            pattern.value='claude-opus'; pattern.dispatchEvent(new Event('input',{bubbles:true})); pattern.dispatchEvent(new Event('change',{bubbles:true}));
        })()`);
        await until(() => run(prefs, "getTokenizerConfig().contextRules.some(r => r.pattern === 'claude-opus')"), 'conflicting rule added');
        await sleep(250);
        assert.equal(await run(prefs, "document.getElementById('context-conflict-banner').classList.contains('hidden')"), false);

        // Moving it above the specific claude rules changes resolution.
        for (let guard = 0; guard < 40; guard += 1) {
            const index = await run(prefs, "getTokenizerConfig().contextRules.findIndex(r => r.pattern === 'claude-opus')");
            if (index <= 0) break;
            const id = await run(prefs, "getTokenizerConfig().contextRules.find(r => r.pattern === 'claude-opus').id");
            await run(prefs, `moveRule('context', '${id}', -1)`);
            await until(() => run(prefs, `getTokenizerConfig().contextRules.findIndex(r => r.pattern === 'claude-opus') < ${index}`), 'move applied');
        }
        await sleep(300);
        assert.equal(await run(main, "getContextWindowForModel('claude-opus-5')"), 200000);

        // Regex opt-in on the same row.
        await run(prefs, `(() => { const rule=getTokenizerConfig().contextRules.find(r => r.pattern === 'claude-opus'); toggleRuleRegex('context', rule.id); })()`);
        await until(() => run(prefs, "getTokenizerConfig().contextRules.some(r => r.regex === true)"), 'regex enabled');
        await run(prefs, `(() => {
            const row=document.querySelector('#context-rule-list .rule-row');
            const input=row.querySelector('.rule-pattern-input');
            input.value='^claude-opus-5$'; input.dispatchEvent(new Event('change',{bubbles:true}));
        })()`);
        await until(() => run(prefs, "getTokenizerConfig().contextRules[0].pattern === '^claude-opus-5$'"), 'regex pattern saved');
        await sleep(250);
        assert.equal(await run(main, "getContextWindowForModel('claude-opus-5')"), 200000);
        assert.equal(await run(main, "getContextWindowForModel('claude-opus-4-8')"), 1000000);
        assert.equal(await run(prefs, "document.querySelector('#context-rule-list .rule-row .rule-regex-btn').classList.contains('active')"), true);

        // Restore defaults wipes both custom rules and the edited default row.
        await run(prefs, "window.confirm = () => true; resetContextRules();");
        await until(() => run(prefs, "getTokenizerConfig().contextDefault.value === 128000"), 'defaults restored');
        assert.equal(await run(prefs, "getTokenizerConfig().contextRules.length"), await run(prefs, "AIUITokenizerRules.normalizeConfig(null).contextRules.length"));
        assert.equal(await run(main, "getContextWindowForModel('claude-opus-5')"), 1000000);

        // The uploaded vocabulary can be removed again, together with its rule.
        const fileId = await run(prefs, "getTokenizerConfig().files[0].id");
        await run(prefs, `deleteTokenizerFile('${fileId}')`);
        await until(() => run(prefs, "getTokenizerConfig().files.length === 0"), 'file deleted');
        assert.equal(await run(prefs, "getTokenizerConfig().tokenizerRules.some(r => r.engine.startsWith('file:'))"), false);

        // Rule changes must apply immediately even while an Agent task runs.
        await run(main, `(() => {
            const chat = chats.find(c => c.id === activeChatId);
            chat.agentEnabled = true;
            window.isAgentTaskRunning = () => true;
            window.__estimateWindows = [];
            const original = window.estimateContextAccurately;
            window.estimateContextAccurately = (messages, options) => { window.__estimateWindows.push(options.contextWindow); return original(messages, options); };
        })()`);
        await run(prefs, `(async () => {
            const config = getTokenizerConfig();
            const rules = AIUITokenizerRules.cloneRules(config.contextRules);
            rules.unshift({ id: 'ctx-midrun', pattern: '^.*$', regex: true, value: 777000, enabled: true, builtin: false });
            await persistConfig({ tokenizerRules: AIUITokenizerRules.cloneRules(config.tokenizerRules), contextRules: rules, tokenizerDefault: { ...config.tokenizerDefault }, contextDefault: { ...config.contextDefault } }, 'context', { silent: true });
        })()`);
        await until(() => run(main, "(window.__estimateWindows || []).includes(777000)"), 'rule applied during a running agent task');
        await run(main, "(() => { const chat = chats.find(c => c.id === activeChatId); chat.agentEnabled = false; delete window.isAgentTaskRunning; delete window.__estimateWindows; })()");
        await run(prefs, "window.confirm = () => true; resetContextRules();");
        const defaultContextCount = await run(prefs, "AIUITokenizerRules.normalizeConfig(null).contextRules.length");
        await until(() => run(prefs, `getTokenizerConfig().contextRules.length === ${defaultContextCount}`), 'cleanup after mid-run test');


        // Voice: the model comes from the main selector, and the TTS toggle persists.
        await run(prefs, "switchSettingsSection('voice-chat', document.querySelector('[data-section=voice-chat]'))");
        assert.equal(await run(prefs, "document.getElementById('voice-chat-model-input') === null"), true);
        assert.equal(await run(prefs, "document.getElementById('voice-tts-ignore-parentheses').checked"), true);
        await run(prefs, "(() => { const toggle=document.getElementById('voice-tts-ignore-parentheses'); toggle.checked=false; toggle.dispatchEvent(new Event('change',{bubbles:true})); })()");
        await sleep(250);
        assert.equal(await run(main, "localStorage.getItem('voice_tts_ignore_parentheses')"), 'false');
        assert.equal(await run(main, "getVoiceChatSettingsSnapshot().ttsIgnoreParentheses"), false);
        await run(prefs, "(() => { const toggle=document.getElementById('voice-tts-ignore-parentheses'); toggle.checked=true; toggle.dispatchEvent(new Event('change',{bubbles:true})); })()");
        await sleep(250);
        await run(main, "document.getElementById('model-select').value='deepseek-flash'; onModelSelectionChange();");
        assert.equal(await run(main, "getVoiceChatSettingsSnapshot().model"), 'deepseek-flash');

        // Parenthetical stripping inside the real audio window.
        await run(main, `(async () => {
            const chat = chats.find(c => c.id === activeChatId);
            await window.electronAPI.openAudioChat({ chatId: chat.id, settings: getVoiceChatSettingsSnapshot(), context: [], turns: [] });
            return true;
        })()`);
        const audio = await until(() => BrowserWindow.getAllWindows().find(w => /audiochat\.html/.test(w.webContents.getURL())), 'audio window');
        await until(() => run(audio, "typeof stripParentheticalForSpeech === 'function'"), 'audio ready');
        assert.equal(await run(audio, "stripParentheticalForSpeech('你好（笑），我们(继续)吧。')"), '你好，我们吧。');
        assert.equal(await run(audio, "shouldIgnoreParentheses({})"), true);
        assert.equal(await run(audio, "shouldIgnoreParentheses({ ttsIgnoreParentheses:false })"), false);

        console.log(JSON.stringify({ ok: true }));
    } catch (error) {
        console.error(error);
        app.exit(1);
        return;
    }
    app.exit(0);
});
