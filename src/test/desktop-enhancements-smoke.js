'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { app,BrowserWindow,dialog } = require('electron');
const profile = path.join(os.tmpdir(),`aiui-enhancements-${process.pid}`);
app.setPath('userData',profile);
app.commandLine.appendSwitch('disable-gpu');
require('../main/main');
setTimeout(() => { console.error('smoke test watchdog timeout'); app.exit(1); },120000).unref();
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(callback,label) {
    const deadline = Date.now()+20000;
    while (Date.now()<deadline) { const result = await callback(); if (result) return result; await sleep(100); }
    throw new Error(`Timed out: ${label}`);
}
const evaluate = async (win,source) => {
    let timer;
    try { return await Promise.race([win.webContents.executeJavaScript(source,true),new Promise((_,reject) => { timer=setTimeout(() => reject(new Error(`Renderer evaluation timed out: ${source.slice(0,180)}`)),15000); })]); }
    finally { clearTimeout(timer); }
};
function transcriptBottomState(win) {
    return evaluate(win, String.raw`(() => {
        const transcript = document.getElementById('messages-wrapper');
        const button = document.getElementById('scroll-to-bottom');
        const style = getComputedStyle(button);
        const opacityTransition = style.transitionProperty.split(',').findIndex(property => ['all','opacity'].includes(property.trim()));
        const alpha = Number(style.backgroundColor.match(/(?:rgba\(.+,|\/)\s*([0-9.]+)\)$/)?.[1]);
        return {
            overflows: transcript.scrollHeight > transcript.clientHeight + 1,
            remaining: transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight,
            hasMore: transcript.classList.contains('has-more-below'),
            fades: getComputedStyle(transcript).maskImage.includes('linear-gradient'),
            opacity: Number(style.opacity),
            interactive: !button.inert && style.pointerEvents !== 'none' && style.visibility === 'visible',
            floating: button.parentElement === transcript.parentElement && style.position === 'absolute',
            translucent: alpha > 0 && alpha < 1,
            blurred: style.backdropFilter.includes('blur('),
            transition: opacityTransition >= 0 && parseFloat(style.transitionDuration.split(',')[opacityTransition]) > 0
        };
    })()`);
}
async function waitForTranscriptBottom(win, label) {
    await until(async () => {
        const state = await transcriptBottomState(win);
        return state.overflows && Math.abs(state.remaining) < 2 && !state.hasMore;
    }, label);
}
function composerControls(win) {
    return evaluate(win, `(() => {
        const input = document.querySelector('#input-footer .input-area').getBoundingClientRect();
        const controls = ['model-selector-trigger', 'command-mode-trigger', 'context-estimate-shell']
            .map(id => document.getElementById(id).getBoundingClientRect());
        const [model, mode, metrics] = controls;
        const typography = ['model-selector-trigger', 'command-mode-trigger', 'token-estimate', 'task-metrics']
            .map(id => getComputedStyle(document.getElementById(id)));
        return metrics.right <= model.left && model.right <= mode.left
            && typography.every(style => style.fontSize === typography[0].fontSize && style.lineHeight === typography[0].lineHeight)
            && controls.every(control => control.height > 0 &&
            Math.abs(control.top - model.top) < 1 && Math.abs(control.height - model.height) < 1 &&
            control.top >= input.bottom && control.left >= input.left && control.right <= input.right);
    })()`);
}
async function assertAgentCardSurface(win, selector) {
    const matches = await evaluate(win, `(() => {
        const card = document.querySelector(${JSON.stringify(selector)});
        const reference = document.getElementById('context-breakdown');
        const previousTheme = document.body.classList.contains('theme-light') ? 'light' : 'dark';
        try {
            return Object.fromEntries(['dark','light'].map(theme => {
                setTheme(theme, false);
                const actual = getComputedStyle(card);
                const expected = getComputedStyle(reference);
                return [theme, actual.backgroundColor === expected.backgroundColor && actual.backdropFilter === expected.backdropFilter];
            }));
        } finally {
            setTheme(previousTheme, false);
        }
    })()`);
    assert.deepEqual(matches,{dark:true,light:true},selector);
}
async function openReasoningOverlay(win) {
    const modelBounds = () => evaluate(win, "document.querySelector('.model-choice-popover').getBoundingClientRect().toJSON()");
    await sleep(180);
    const before = await modelBounds();
    await evaluate(win, "document.querySelector('.reasoning-footer').click()");
    await sleep(180);
    assert.deepEqual(await modelBounds(), before);
    assert.equal(await evaluate(win, `(() => {
        const parent = document.querySelector('.model-choice-popover');
        const child = document.querySelector('.reasoning-choice-popover');
        const model = parent.getBoundingClientRect();
        const effort = child.getBoundingClientRect();
        const target = document.elementFromPoint(effort.left + effort.width / 2, effort.top + effort.height / 2);
        return parent.classList.contains('open') && child.classList.contains('open') && child.contains(target) &&
            effort.left >= 11 && effort.right <= innerWidth - 11 && effort.top >= 11 && effort.bottom < model.bottom &&
            effort.left < model.right && effort.right > model.left;
    })()`), true);
}
async function closePreferences(win) {
    // Closing the sender can discard executeJavaScript's reply before it arrives.
    void win.webContents.executeJavaScript('void window.electronAPI.closePreferences(); true',true).catch(() => {});
    await until(() => win.isDestroyed(),'preferences closed');
}
const errors = [];
app.on('web-contents-created',(_event,contents) => {
    contents.on('console-message',(_event,level,message) => { if (level>=3 && !/ERR_FILE_NOT_FOUND|ERR_NAME_NOT_RESOLVED/.test(message)) errors.push(message); });
});
app.whenReady().then(async () => {
    const artifacts = path.join(profile,'screenshots'); await fs.mkdir(artifacts,{ recursive:true });
    let server;
    try {
        const main = await until(() => BrowserWindow.getAllWindows().find(win => /index\.html$/.test(win.webContents.getURL())),'main window');
        await until(() => evaluate(main,"Boolean(window.AIUIEnhancements && document.querySelectorAll('.custom-select-trigger').length === 3)"),'initialized custom selectors');
        await sleep(450);
        await evaluate(main,"closeSetupGuide(); localStorage.setItem('first_setup_guide_shown','1');");
        assert.equal(await evaluate(main,"localStorage.getItem('auto_summary_interval')"),'0');
        await sleep(250);
        const emptyTranscript = await transcriptBottomState(main);
        assert.ok(!emptyTranscript.overflows && !emptyTranscript.hasMore && !emptyTranscript.fades && emptyTranscript.opacity === 0 && !emptyTranscript.interactive,JSON.stringify(emptyTranscript));
        assert.deepEqual(await evaluate(main,"(() => { const c=getComputedStyle(document.querySelector('#input-footer .input-area')); return [c.borderTopLeftRadius,c.borderTopRightRadius,c.borderBottomLeftRadius,c.borderBottomRightRadius]; })()"),['14px','14px','14px','14px']);
        // Real click dispatch must leave exactly one of the overlapping menus open.
        await evaluate(main, "document.getElementById('model-selector-trigger').click(); document.querySelector('.reasoning-footer').click(); document.getElementById('attach-plus-btn').click();");
        assert.deepEqual(await evaluate(main, "[document.querySelectorAll('.choice-popover.open').length,document.getElementById('model-selector-trigger').getAttribute('aria-expanded'),document.getElementById('attach-menu').classList.contains('visible') ]"),[0,'false',true]);
        for (const theme of ['theme-dark','theme-light']) {
            assert.equal(await evaluate(main, `(() => { setTheme('${theme === 'theme-dark' ? 'dark' : 'light'}', false); const menu=document.getElementById('attach-menu'); const c=getComputedStyle(document.getElementById('context-breakdown')); return [menu,...document.querySelectorAll('.model-choice-popover,.mode-choice-popover')].every(node=>{ const a=getComputedStyle(node); return a.backgroundColor===c.backgroundColor && a.borderRadius===c.borderRadius && a.backdropFilter===c.backdropFilter; }) && menu.parentElement===document.body; })()`),true);
        }
        await evaluate(main, "setTheme('dark', false); document.getElementById('model-selector-trigger').click();");
        assert.deepEqual(await evaluate(main, "[document.getElementById('attach-menu').classList.contains('visible'),document.querySelector('.model-choice-popover').classList.contains('open')]"),[false,true]);
        await evaluate(main, "document.getElementById('attach-plus-btn').click(); document.getElementById('attach-plus-btn').click();");
        assert.equal(await evaluate(main, "document.getElementById('attach-menu').classList.contains('visible')"),false);
        const attachAnimates = await evaluate(main, `(async () => {
            const menu = document.getElementById('attach-menu');
            const trigger = document.getElementById('attach-plus-btn');
            const animating = () => {
                void menu.offsetWidth;
                return menu.getAnimations().some(item=>item.transitionProperty === 'opacity');
            };
            await new Promise(resolve=>setTimeout(resolve,180));
            trigger.click();
            const entering = animating();
            await new Promise(resolve=>setTimeout(resolve,200));
            trigger.click();
            return entering && animating();
        })()`);
        assert.equal(attachAnimates, true);
        const token = await evaluate(main,"window.electronAPI.countContextBatch(['你好，世界！'],'deepseek-flash')");
        assert.equal(token.generic,false); assert.equal(token.counts[0],4);
        assert.equal((await evaluate(main,"window.electronAPI.countContextBatch(['hello'],'gemini-4-argon')")).generic,true);
        dialog.showOpenDialog = async () => ({ canceled:false,filePaths:[artifacts] });
        const initialChat = await evaluate(main,'activeChatId');
        await evaluate(main,"createNewChat(); document.getElementById('model-select').value='deepseek-flash'; onModelSelectionChange(); document.getElementById('model-select').dispatchEvent(new Event('change'));");
        await until(() => evaluate(main,"document.getElementById('context-breakdown-model').textContent==='deepseek-flash' && document.getElementById('token-estimate').style.display==='none'"),'empty ordinary chat estimate');
        await evaluate(main,"showContextBreakdown(); window.testEnterAgent=enterAgentMode(); true;");
        await until(() => evaluate(main,"document.getElementById('agent-workspace-trust-modal').classList.contains('visible')"),'new agent workspace trust');
        await evaluate(main,"resolveAgentWorkspaceTrust(true); window.testEnterAgent");
        await until(() => evaluate(main,"document.getElementById('token-estimate').textContent.startsWith('Toks:') && document.getElementById('context-breakdown-rows').textContent.includes('系统工具')"),'initial Agent tool and prompt tokens without switching chats');
        const initialUsage = await evaluate(main,"(() => { const trigger=document.getElementById('context-meter').getBoundingClientRect(); const popup=document.getElementById('context-breakdown').getBoundingClientRect(); return {text:document.getElementById('token-estimate').textContent,visible:trigger.width>0 && trigger.height>0,meter:document.getElementById('context-meter').classList.contains('visible'),left:popup.left,anchor:trigger.left,top:popup.top,bottom:popup.bottom,anchorTop:trigger.top}; })()");
        assert.ok(initialUsage.visible && initialUsage.meter && initialUsage.left<=initialUsage.anchor+1 && initialUsage.top>12 && initialUsage.bottom<=initialUsage.anchorTop,JSON.stringify(initialUsage));
        await evaluate(main,"document.getElementById('agent-info-toggle').click();"); await sleep(250);
        assert.deepEqual(await evaluate(main,"(() => {const c=getComputedStyle(document.querySelector('#agent-sidebar-context .context-breakdown'));return [c.backgroundColor,c.backdropFilter];})()"),['rgba(0, 0, 0, 0)','none']);
        await fs.writeFile(path.join(artifacts,'new-agent-context.png'),(await main.webContents.capturePage()).toPNG());
        await evaluate(main,`hideContextBreakdown(); document.getElementById('agent-info-toggle').click(); switchChat(${JSON.stringify(initialChat)}); document.getElementById('model-select').value='gpt-5.6-terra'; onModelSelectionChange(); document.getElementById('model-select').dispatchEvent(new Event('change'));`);
        assert.deepEqual(await evaluate(main,"(() => { const t=document.getElementById('user-input'); t.value=Array(14).fill('一行输入文本').join('\\n'); autoResize(t); const c=getComputedStyle(t); return { scroll:c.overflowY,lines:Math.round((t.clientHeight-parseFloat(c.paddingTop)-parseFloat(c.paddingBottom))/parseFloat(c.lineHeight)),transform:getComputedStyle(document.getElementById('input-footer')).transform }; })()"),{ scroll:'auto',lines:6,transform:'none' });
        await evaluate(main,"document.querySelector('.model-selector-container .custom-select-trigger').click()");
        await sleep(200);
        const picker = await evaluate(main,"(() => { const p=document.querySelector('.choice-popover.open'); const r=p.getBoundingClientRect(); return { top:r.top,bottom:r.bottom,height:r.height,width:r.width,screen:innerHeight,reasoning:p.innerText.includes('Reasoning depth'),itemHeight:p.querySelector('.choice-option').getBoundingClientRect().height }; })()");
        assert.ok(picker.top>=0 && picker.bottom<=picker.screen+1 && picker.height<=441 && picker.width<=341 && picker.itemHeight<30,JSON.stringify(picker)); assert.equal(picker.reasoning,true,JSON.stringify(picker));
        assert.equal(await evaluate(main,"document.querySelector('.choice-search') === null"),true);
        assert.equal(await evaluate(main,"(() => { const items=document.querySelectorAll('.choice-popover.open .choice-option');return items[1].getBoundingClientRect().top-items[0].getBoundingClientRect().bottom>=3;})()"),true);
        await fs.writeFile(path.join(artifacts,'model-picker.png'),(await main.webContents.capturePage()).toPNG());
        await openReasoningOverlay(main);
        await fs.writeFile(path.join(artifacts,'reasoning-menu.png'),(await main.webContents.capturePage()).toPNG());
        const reasoningOptions = await evaluate(main,"[...document.querySelector('.choice-popover[aria-label=\"Reasoning depth\"]').querySelectorAll('.choice-option')].map(item=>item.textContent.replace('✓','').trim())");
        assert.ok(reasoningOptions.includes('medium (default)'),JSON.stringify(reasoningOptions));
        assert.ok(reasoningOptions.every(label=>label!=='Default' && label!=='Automatic' && !/[\u4e00-\u9fff]/.test(label)),JSON.stringify(reasoningOptions));
        await evaluate(main,"document.querySelector('.choice-popover.open:last-of-type .choice-option')?.click(); document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); document.getElementById('user-input').value=''; autoResize(document.getElementById('user-input')); const chat=chats.find(c=>c.id===activeChatId); chat.agentEnabled=true; chat.agentPlan={steps:[{step:'检查侧栏数据',status:'in_progress'}]}; updateAgentUIForChat(chat); window.AIUIEnhancements.changed(); document.getElementById('agent-info-toggle').click();");
        await sleep(300);
        assert.equal(await evaluate(main,"document.getElementById('agent-info-toggle').hidden"),false);
        assert.equal(await evaluate(main,"document.getElementById('agent-sidebar-plan').textContent.includes('检查侧栏数据')"),true);
        const sidebarAnimation = await evaluate(main,`(async () => {
            const sidebar=document.getElementById('agent-info-sidebar');
            const content=sidebar.querySelector('.agent-info-sidebar-content');
            content.style.maxHeight='160px'; content.scrollTop=40;
            const measure=() => { const card=content.querySelector('section').getBoundingClientRect(); return {top:card.top,width:card.width,height:card.height,scroll:content.scrollTop}; };
            const before=measure(), frames=[];
            document.getElementById('agent-info-toggle').click();
            const start=performance.now();
            do { await new Promise(requestAnimationFrame); frames.push(measure()); }
            while(sidebar.getBoundingClientRect().width>0 && performance.now()-start<1500);
            const closedWidth=sidebar.getBoundingClientRect().width;
            document.getElementById('agent-info-toggle').click();
            await new Promise(resolve=>setTimeout(resolve,240));
            content.style.maxHeight=''; content.scrollTop=0;
            return {before,frames,closedWidth};
        })()`);
        assert.ok(sidebarAnimation.before.scroll>0,JSON.stringify(sidebarAnimation));
        assert.ok(sidebarAnimation.frames.every(frame=>Object.keys(sidebarAnimation.before).every(key=>Math.abs(frame[key]-sidebarAnimation.before[key])<1)),JSON.stringify(sidebarAnimation));
        assert.equal(sidebarAnimation.closedWidth,0);
        assert.equal(await composerControls(main), true);
        assert.equal(await evaluate(main,"document.getElementById('command-mode-trigger').textContent"),'Safe Commands Only');
        assert.equal(await evaluate(main,"document.getElementById('voice-btn') === null && typeof toggleVoiceRecording === 'undefined' && typeof transcribeAudio === 'undefined'"),true);
        assert.equal(await evaluate(main,"document.querySelectorAll('#sidebar #chat-archive-btn').length === 1 && !document.querySelector('#sidebar [onclick=\"openSetupGuide()\"]')"),true);
        await evaluate(main,"document.getElementById('chat-archive-btn').click()");
        assert.deepEqual(await evaluate(main,"[document.getElementById('chat-archive-menu').classList.contains('open'),...[...document.querySelectorAll('#chat-archive-menu [data-archive-action]')].map(button=>button.dataset.archiveAction)]"),[true,'import','export']);
        await sleep(180);
        assert.equal(await evaluate(main, `(() => {
            const menu = document.getElementById('chat-archive-menu');
            const trigger = document.getElementById('chat-archive-btn');
            const context = getComputedStyle(document.getElementById('context-breakdown'));
            const style = getComputedStyle(menu);
            return menu.getBoundingClientRect().bottom < trigger.getBoundingClientRect().top &&
                style.backgroundColor === context.backgroundColor && style.backdropFilter === context.backdropFilter;
        })()`),true);
        await fs.writeFile(path.join(artifacts,'archive-choice.png'),(await main.webContents.capturePage()).toPNG());
        await evaluate(main,"document.getElementById('chat-archive-btn').click()");
        assert.equal(await evaluate(main,"document.getElementById('chat-archive-btn').getAttribute('aria-expanded')"),'false');
        assert.equal(await evaluate(main,"(() => { const current=document.querySelector('#chat-history .history-entry.current'); return current.querySelector('.history-title[aria-current=true]')?.firstElementChild === null && getComputedStyle(current.querySelector('.delete-chat-btn')).opacity==='0'; })()"),true);
        assert.equal(await evaluate(main,"getComputedStyle(document.querySelector('#input-footer .input-area')).borderTopRightRadius"),'14px');
        await evaluate(main,"document.getElementById('command-mode-trigger').click()");
        assert.equal(await evaluate(main,"(() => {const items=document.querySelectorAll('.choice-popover.open .choice-option');return items[1].getBoundingClientRect().top-items[0].getBoundingClientRect().bottom>=3;})()"),true);
        assert.deepEqual(await evaluate(main,"[...document.querySelectorAll('.mode-choice-popover .choice-option')].map(item=>item.firstElementChild.textContent)"),['Safe Commands Only','Always Ask','YOLO Mode']);
        await sleep(180);
        await fs.writeFile(path.join(artifacts,'command-mode-picker.png'),(await main.webContents.capturePage()).toPNG());
        await evaluate(main,"document.querySelector('.mode-choice-popover .choice-option:last-child').click();");
        await until(() => evaluate(main,"document.getElementById('agent-yolo-warning-modal').classList.contains('modal-active')"),'permission confirmation');
        await evaluate(main,"resolveAgentYoloWarning(false);");
        assert.equal(await evaluate(main,"document.getElementById('command-mode-trigger').textContent"),'Safe Commands Only');
        await evaluate(main,"document.getElementById('command-mode-trigger').click(); document.querySelector('.mode-choice-popover .choice-option:last-child').click(); resolveAgentYoloWarning(true);");
        assert.equal(await evaluate(main,"document.getElementById('command-mode-trigger').textContent"),'YOLO Mode');
        assert.equal(await evaluate(main,`(() => {
            const trigger = document.getElementById('command-mode-trigger');
            trigger.click();
            const option = document.querySelector('.mode-choice-popover .choice-option:last-child');
            return getComputedStyle(trigger).color === 'rgb(255, 173, 102)' && getComputedStyle(option).color !== getComputedStyle(trigger).color;
        })()`),true);
        await evaluate(main,"document.querySelector('.mode-choice-popover .choice-option:first-child').click();");
        const headerHeight = await evaluate(main,"document.querySelector('main>header').getBoundingClientRect().height");
        assert.equal(headerHeight,48);
        await evaluate(main,"document.querySelector('.history-toolbar button:last-child').click()"); await sleep(250);
        assert.equal(await evaluate(main,"document.querySelector('main>header').getBoundingClientRect().height"),headerHeight);
        await evaluate(main,"document.getElementById('history-restore').click()"); await sleep(250);
        assert.equal(await evaluate(main,"document.querySelector('main>header').getBoundingClientRect().height"),headerHeight);
        await fs.writeFile(path.join(artifacts,'agent-sidebar.png'),(await main.webContents.capturePage()).toPNG());
        const countBefore = await evaluate(main,'chats.length');
        await evaluate(main,'toggleSettings()');
        const prefs = await until(() => BrowserWindow.getAllWindows().find(win => /preferences=1/.test(win.webContents.getURL())),'modal preferences');
        await until(() => evaluate(prefs,"Boolean(document.getElementById('input-max-lines'))"),'preference controls');
        assert.equal(await evaluate(prefs,"document.getElementById('agent-auto-scroll') === null"),true);
        assert.equal(await evaluate(prefs,"[...document.querySelectorAll('.settings-sidebar nav button')].every(button=>Boolean(button.querySelector('svg.lucide')))"),true);
        assert.equal(await evaluate(prefs,"document.getElementById('api-settings-actions').getClientRects().length"),0);
        assert.equal(await evaluate(prefs,"document.querySelector('input[name=auto-summary-interval]:checked').value"),'0');
        assert.equal(await evaluate(prefs,"document.getElementById('context-compaction-card').contains(document.getElementById('context-compaction-model-select')) && document.getElementById('context-compaction-card').contains(document.querySelector('input[name=auto-summary-interval]'))"),true);
        await evaluate(prefs,"document.querySelector('input[name=auto-summary-interval][value=\"15\"]').click()");
        assert.equal(await evaluate(prefs,"localStorage.getItem('auto_summary_interval')"),'15');
        await evaluate(prefs,"document.querySelector('input[name=auto-summary-interval][value=\"0\"]').click()");
        assert.equal(await evaluate(prefs,"document.getElementById('voice-model-select')===null && document.getElementById('voice-chat-model-input')===null && Boolean(document.getElementById('voice-tts-ignore-parentheses')) && Boolean(document.getElementById('math-render-toggle'))"),true);
        assert.equal(await evaluate(prefs,"document.getElementById('settings-back-btn')===null"),true);
        assert.deepEqual(await evaluate(prefs,`(() => {
            const endpoint = document.getElementById('voice-fish-endpoint-select');
            const initial = getSavedFishAudioSettings();
            endpoint.value = 'international';
            endpoint.dispatchEvent(new Event('change'));
            const international = getSavedFishAudioSettings();
            endpoint.value = 'domestic';
            endpoint.dispatchEvent(new Event('change'));
            return [initial.endpoint, initial.model, international.apiBase, international.model, !international.apiKey];
        })()`), ['domestic','s2.1-pro-free','https://api.fish.audio','s2.1-pro-free',true]);
        assert.deepEqual(await evaluate(prefs,"(() => { const input=document.getElementById('input-max-lines'); const buttons=input.closest('.setting-stepper').querySelectorAll('button'); input.value='6'; buttons[1].click(); const plus=input.value; buttons[0].click(); const minus=input.value; input.value='30'; buttons[1].click(); const max=input.value; input.value='1'; buttons[0].click(); const min=input.value; input.value='6'; return [plus,minus,max,min]; })()"),['7','6','30','1']);
        assert.deepEqual(await evaluate(prefs,"[...document.querySelectorAll('[id^=bg-thumb-]')].slice(0,3).map(img=>[img.id,img.alt])"),[['bg-thumb-7','Duo Light'],['bg-thumb-8','Duo Dark'],['bg-thumb-9','Golden Gate']]);
        assert.equal(await evaluate(prefs,"Promise.all([7,8,9].map(number=>document.getElementById('bg-thumb-'+number).decode())).then(()=>true)"),true);
        await evaluate(prefs,"document.getElementById('developer-mode-toggle').checked=true; onDeveloperModeToggleChange(); switchSettingsSection('advanced',document.querySelector('[data-section=advanced]'));");
        assert.equal(await evaluate(prefs,"['enhanced-tool-parser','agent-native-notifications'].every(id=>{const input=document.getElementById(id); const toggle=input.closest('.cloud-toggle'); return toggle && input.nextElementSibling.classList.contains('slider') && getComputedStyle(input).opacity==='0' && getComputedStyle(toggle.querySelector('.slider')).borderRadius===getComputedStyle(document.querySelector('#record-logs-toggle+.slider')).borderRadius;})"),true);
        await evaluate(prefs,"document.getElementById('enhanced-tool-parser').click();");
        await sleep(250); await fs.writeFile(path.join(artifacts,'preferences-tool-parser.png'),(await prefs.webContents.capturePage()).toPNG());
        assert.equal(await evaluate(prefs,"localStorage.getItem('enhanced_tool_parser')"),'true');
        await evaluate(prefs,"document.getElementById('enhanced-tool-parser').click(); document.getElementById('developer-mode-toggle').click();");
        assert.equal(prefs.getParentWindow(),main); assert.equal(prefs.isModal(),true); assert.equal(main.isEnabled(),false);
        assert.equal(await evaluate(main,'chats.length'),countBefore);
        assert.equal(await evaluate(prefs,'chats.length'),countBefore);
        assert.equal(await evaluate(prefs,"(() => { const saved=localStorage.getItem('api_key'); const key=document.getElementById('api-key-input'); const value=key.value; key.value='unsaved-api-draft'; key.dispatchEvent(new Event('input',{bubbles:true})); const lines=document.getElementById('input-max-lines'); lines.value='4'; lines.dispatchEvent(new Event('change',{bubbles:true})); const unchanged=localStorage.getItem('api_key')===saved && apiSettingsDirty; key.value=value; apiSettingsDirty=false; document.getElementById('api-unsaved-hint').classList.add('hidden'); return unchanged; })()"),true);
        await evaluate(prefs,"setTheme('dark'); setAccentColor('rose');");
        await sleep(300);
        assert.equal(await evaluate(main,"document.body.classList.contains('theme-dark')"),true);
        assert.equal(await evaluate(main,"localStorage.getItem('input_max_lines')"),'4');
        assert.deepEqual(await evaluate(prefs,"(() => { const c=getComputedStyle(document.getElementById('sys-prompt')); const h=document.querySelector('.settings-sidebar-header h2'); return {bg:c.backgroundColor,text:c.color,titleFits:h.scrollWidth<=h.clientWidth,sidebar:Math.round(document.querySelector('.settings-sidebar').getBoundingClientRect().width)}; })()"),{bg:'rgb(23, 23, 25)',text:'rgb(229, 231, 235)',titleFits:true,sidebar:164});
        await fs.writeFile(path.join(artifacts,'preferences.png'),(await prefs.webContents.capturePage()).toPNG());
        await evaluate(prefs,"setTheme('light'); switchSettingsSection('api',document.querySelector('[data-section=api]'));");
        assert.ok(await evaluate(prefs,"document.getElementById('api-settings-actions').getClientRects().length>0"));
        assert.equal(await evaluate(prefs,"[...document.querySelectorAll('#settings-modal button')].filter(button=>['取消','保存设置'].includes(button.textContent.trim())).every(button=>button.closest('.settings-content-section').id==='section-api')"),true);
        assert.deepEqual(await evaluate(prefs,"(() => { const c=getComputedStyle(document.getElementById('base-url-input')); return [c.backgroundColor,c.color]; })()"),['rgb(240, 240, 245)','rgb(36, 36, 36)']);
        assert.deepEqual(await evaluate(prefs, `(() => {
            const slider = document.querySelector('#record-logs-toggle + .slider');
            const buttons = document.querySelectorAll('#log-actions button');
            return [getComputedStyle(slider).backgroundColor, ...Array.from(buttons, button => getComputedStyle(button).color)];
        })()`), ['rgb(129, 129, 129)', 'rgb(28, 100, 203)', 'rgb(39, 38, 36)']);
        await sleep(250); await fs.writeFile(path.join(artifacts,'preferences-light.png'),(await prefs.webContents.capturePage()).toPNG());
        await evaluate(prefs,"setTheme('dark');");
        await evaluate(prefs,"switchSettingsSection('guide', document.querySelector('[data-section=guide]')); document.getElementById('open-setup-guide').click()");
        await until(() => evaluate(prefs,"document.getElementById('setup-guide-modal').classList.contains('modal-active')"),'setup guide from preferences');
        await evaluate(prefs,"closeSetupGuide()");
        await sleep(260);
        await closePreferences(prefs);
        assert.equal(main.isEnabled(),true);
        await evaluate(main,'window.electronAPI.openAgentGateway()');
        const gateway = await until(() => BrowserWindow.getAllWindows().find(win => /gateway-console\.html$/.test(win.webContents.getURL())),'gateway window');
        await until(() => evaluate(gateway,"document.documentElement.dataset.theme === 'dark'"),'gateway appearance');
        assert.equal(await evaluate(gateway,"getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()"),'#e11d48');
        await fs.writeFile(path.join(artifacts,'gateway-themed.png'),(await gateway.webContents.capturePage()).toPNG());
        await evaluate(main,"setTheme('light')");
        await until(() => evaluate(gateway,"document.documentElement.dataset.theme === 'light' && getComputedStyle(document.getElementById('save-network')).backgroundColor === 'rgb(246, 246, 246)'"),'light gateway appearance');
        assert.deepEqual(await evaluate(gateway, `(() => {
            const controls = ['#port', '#read-code', '#save-network', '#allow-write'];
            return controls.map(selector => getComputedStyle(document.querySelector(selector)).backgroundColor);
        })()`), ['rgb(246, 246, 246)', 'rgba(0, 0, 0, 0)', 'rgb(246, 246, 246)', 'rgb(133, 133, 133)']);
        assert.equal(await evaluate(main,"getComputedStyle(document.querySelector('#agent-yolo-warning-modal p')).color"),'rgb(104, 102, 96)');
        await evaluate(main,"setTheme('dark')");
        let modelCalls = 0;
        let modelListAvailable = true;
        let countAvailable = false;
        let textRequestFails = false;
        const probeCommandRounds = [];
        let ordinaryStream = false;
        const imageRequests = [];
        const command = `Write-Output '${'activity heading '.repeat(26)}${'x'.repeat(120)}'; Start-Sleep -Milliseconds 900`;
        const commandDescription = '输出一段测试文本并短暂等待';
        const followupQuestion = `请补充需要验证的内容。${'详细说明会随卡片一起展开。'.repeat(8)}`;
        const followupAnswer = '检查交互卡片的完整布局';
        let releaseFirstResponse;
        const firstResponseGate = new Promise(resolve => { releaseFirstResponse = resolve; });
        let laterResponseGate;
        const requests = [];
        server = http.createServer(async (req,res) => {
            res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Headers','*');
            if (req.method === 'OPTIONS') { res.end(); return; }
            if (req.method === 'GET' && req.url.endsWith('/models') && modelListAvailable) { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ data:[{ id:'gpt-6.1-sol' },{ id:'deepseek-flash' }] })); return; }
            if (req.method === 'POST' && countAvailable && /count_tokens|countTokens|tokenize-text|input_tokens/.test(req.url)) {
                res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({input_tokens:321,totalTokens:321,token_ids:Array(321).fill(1)})); return;
            }
            if (req.method === 'POST' && req.url.endsWith('/images/generations')) {
                let body = '';
                for await (const chunk of req) body += chunk;
                imageRequests.push(JSON.parse(body));
                await sleep(80);
                res.setHeader('Content-Type','application/json');
                res.end(JSON.stringify({ data: [{ b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7dQAAAAASUVORK5CYII=' }] }));
                return;
            }
            if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.statusCode=404; res.end(JSON.stringify({ error:{ message:'count/model endpoint unavailable in test' } })); return; }
            if (textRequestFails) { res.statusCode=500; res.end(JSON.stringify({error:{message:'mock request failed'}})); return; }
            let source = ''; for await (const chunk of req) source += chunk;
            requests.push(JSON.parse(source)); modelCalls++;
            res.setHeader('Content-Type','text/event-stream');
            const event = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
            if (modelCalls === 1) {
                await firstResponseGate;
                const questions = [
                    { id:'color',question:'选择测试方案',options:[
                        { label:'方案 A',description:'继续执行。'.repeat(10) },
                        { label:'方案 B',description:'另一个方案。'.repeat(10) },
                        { label:'方案 C',description:'重复执行。'.repeat(10) }
                    ] },
                    { id:'details',question:followupQuestion }
                ];
                const call = { type:'function_call',name:'ask_user_question',call_id:'ask-1',arguments:JSON.stringify({ questions }) };
                event({ type:'response.completed',response:{ status:'completed',output:[call],usage:{ input_tokens:100,output_tokens:5,input_tokens_details:{ cached_tokens:60 } } } });
            } else if (probeCommandRounds.length) {
                event({ type:'response.completed',response:{ status:'completed',output:probeCommandRounds.shift() } });
            } else {
                if (laterResponseGate) await laterResponseGate;
                if (ordinaryStream) {
                    event({ type:'response.reasoning_summary_text.delta',delta:'普通对话的思考内容' });
                    await sleep(450);
                }
                event({ type:'response.output_text.delta',delta:'已收到' }); await sleep(30);
                event({ type:'response.output_text.delta',delta:'方案 A。' });
                event({ type:'response.completed',response:{ status:'completed',output:[{ type:'message',role:'assistant',content:[{ type:'output_text',text:'已收到方案 A。' }] },{ type:'function_call',name:'finish_task',call_id:'finish-1',arguments:'{}' }],usage:{ input_tokens:100,output_tokens:25,output_tokens_details:{ reasoning_tokens:10 },input_tokens_details:{ cached_tokens:40 } } } });
            }
            res.write('data: [DONE]\n\n'); res.end();
        });
        await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
        const base = `http://127.0.0.1:${server.address().port}/v1`;
        dialog.showOpenDialog = async () => ({ canceled:false,filePaths:[artifacts] });
        await evaluate(main,`(async () => {
            localStorage.setItem('base_url',${JSON.stringify(base)}); localStorage.setItem('api_key','test-only'); localStorage.setItem('request_endpoint','/responses'); localStorage.setItem('agent_native_notifications','false');
            const chat=chats.find(c=>c.id===activeChatId); const selected=await electronAPI.selectAgentWorkspace(chat.id); await electronAPI.confirmAgentWorkspace(chat.id,selected.path,selected.selectionId); chat.agentWorkspace=selected.path; chat.agentWorkspaceAvailable=true; chat.messages=[{role:'user',content:'测试询问暂停'}]; chat.agentEnabled=true; chat.modelRequestSteps=0; chat.agentCompletedRounds=0; document.getElementById('model-select').value='gpt-6.1-sol'; onModelSelectionChange(); document.getElementById('model-select').dispatchEvent(new Event('change'));
            const transcript = document.getElementById('messages-wrapper');
            const history = document.createElement('div');
            history.style.height = transcript.clientHeight + 'px';
            transcript.prepend(history);
            transcript.scrollTo({ top:transcript.scrollHeight, behavior:'instant' });
            window.testAgentPromise=requestAgentLoop('gpt-6.1-sol',chat);
            return true;
        })()`);
        const thinkingBottom = await until(() => evaluate(main, `(() => {
            const transcript = document.getElementById('messages-wrapper');
            const thinking = transcript.querySelector('.agent-round-summary.running');
            const duration = transcript.lastElementChild?.querySelector('.response-worked-duration');
            if (thinking?.textContent !== 'Thinking' || !duration?.textContent.startsWith('Worked for ') ||
                transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight > 2) return null;
            const viewport = transcript.getBoundingClientRect();
            const fullyVisible = node => {
                const row = node.getBoundingClientRect();
                return row.top >= viewport.top - 1 && row.bottom <= viewport.bottom + 1;
            };
            return {
                overflows:transcript.scrollHeight > transcript.clientHeight,
                remaining:transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight,
                thinkingVisible:fullyVisible(thinking),
                durationVisible:fullyVisible(duration)
            };
        })()`),'first live Thinking and Worked for');
        releaseFirstResponse();
        assert.ok(thinkingBottom.overflows && Math.abs(thinkingBottom.remaining) < 2 && thinkingBottom.thinkingVisible && thinkingBottom.durationVisible,JSON.stringify(thinkingBottom));
        await until(() => evaluate(main,"Boolean(document.querySelector('.agent-question input[type=radio]'))"),'agent question');
        assert.equal(modelCalls,1); await sleep(200); assert.equal(modelCalls,1);
        const activity = () => evaluate(main,"(() => { const summary=document.querySelector('.agent-round-summary'); const label=summary.querySelector('.agent-tool-summary-text'); return [label.textContent,getComputedStyle(label).animationName,summary.getAttribute('aria-expanded')]; })()");
        assert.deepEqual(await activity(), ['Waiting for your answer 选择测试方案','agent-activity-shine','false']);
        assert.equal(await evaluate(main, `(() => {
            const label = document.querySelector('.agent-round-summary.running .agent-tool-summary-text');
            const animation = label.getAnimations().find(item => item.animationName === 'agent-activity-shine');
            animation.pause();
            animation.currentTime = 300;
            const start = parseFloat(getComputedStyle(label).backgroundPositionX);
            animation.currentTime = 900;
            const later = parseFloat(getComputedStyle(label).backgroundPositionX);
            animation.play();
            return start > later && getComputedStyle(label).backgroundClip === 'text';
        })()`), true);
        await evaluate(main,"if (!document.body.classList.contains('agent-info-open')) document.getElementById('agent-info-toggle').click();"); await sleep(450);
        const questionLayout = () => evaluate(main, `(() => {
            const form = document.querySelector('.agent-question');
            const row = form.closest('.agent-question-row');
            const chat = document.getElementById('messages-wrapper');
            const fields = [...form.querySelectorAll('fieldset')];
            const actions = form.querySelector('.agent-question-actions');
            const box = node => node.getBoundingClientRect();
            return {
                insideRow: Math.abs(box(form).left - box(row).left) < 2 && box(form).right <= box(row).right + 1,
                noInnerScroll: fields.length === 2 && [form,...fields,actions].every(node =>
                    !['auto','scroll'].includes(getComputedStyle(node).overflowY) && node.scrollHeight <= node.clientHeight + 1),
                actionsAfterQuestions: fields.every(field => box(field).bottom <= box(actions).top + .5) &&
                    [...form.querySelectorAll('input[type=text]:not([hidden])')].every(input => box(input).bottom <= box(actions).top + .5),
                noNativeScrollbar: getComputedStyle(chat).scrollbarWidth === 'none'
            };
        })()`);
        const expectedQuestionLayout = { insideRow:true,noInnerScroll:true,actionsAfterQuestions:true,noNativeScrollbar:true };
        assert.deepEqual(await questionLayout(),expectedQuestionLayout);
        await assertAgentCardSurface(main,'.agent-question');
        assert.equal(await evaluate(main,"document.querySelector('.agent-question input[type=radio]:checked').value"),'方案 A');
        const selectOther = () => evaluate(main,"[...document.querySelectorAll('.agent-question-option')].find(option=>option.textContent.trim()==='手动输入').click()");
        await selectOther();
        assert.equal(await evaluate(main,"document.querySelectorAll('.agent-question input[type=text]:not([hidden])').length"),2);
        const agentWindowSize = main.getSize();
        main.setSize(390,760); await sleep(250);
        assert.deepEqual(await questionLayout(),expectedQuestionLayout);
        assert.equal(await evaluate(main,"(() => { const chat=document.getElementById('messages-wrapper'); return chat.scrollHeight>chat.clientHeight; })()"),true);
        main.setSize(...agentWindowSize); await sleep(250);
        await evaluate(main,"if (!document.body.classList.contains('agent-info-open')) document.getElementById('agent-info-toggle').click()");
        await evaluate(main,"document.querySelector('.agent-question-option').click()");
        assert.equal(await evaluate(main,"document.querySelectorAll('.agent-question input[type=text]:not([hidden])').length"),1);
        await evaluate(main,"document.querySelector('.agent-question').scrollIntoView({ block:'center',behavior:'instant' })");
        await fs.writeFile(path.join(artifacts,'agent-question.png'),(await main.webContents.capturePage()).toPNG());
        await evaluate(main,'toggleSettings()');
        const duringTask = await until(() => BrowserWindow.getAllWindows().find(win => /preferences=1/.test(win.webContents.getURL())),'preferences during agent');
        await until(() => evaluate(duringTask,"Boolean(document.getElementById('input-max-lines'))"),'running settings ready');
        await evaluate(duringTask,"document.getElementById('api-key-input').value='updated-key'; document.getElementById('base-url-input').value='http://127.0.0.1:1/v1'; document.getElementById('max-tokens-input').value='1234'; saveSettings(true);");
        assert.equal(await evaluate(main,'getAPIKey()'),'test-only'); assert.equal(await evaluate(main,'getBaseURL()'),base);
        await closePreferences(duringTask);
        await evaluate(main,`(() => {
            const input = document.querySelector('.agent-question input[type=text]:not([hidden])');
            input.value = ${JSON.stringify(followupAnswer)};
            input.dispatchEvent(new Event('input',{ bubbles:true }));
            input.focus();
            input.dispatchEvent(new KeyboardEvent('keydown',{ key:'Enter',code:'Enter',ctrlKey:true,bubbles:true,cancelable:true }));
        })()`);
        await evaluate(main,'window.testAgentPromise');
        assert.equal(modelCalls,2);
        assert.deepEqual(await activity(), ['Used 1 tool','none','false']);
        const answerSummary = await evaluate(main,`(() => {
            const summary = document.querySelector('.agent-question-answer');
            return { text:summary?.closest('.agent-question-row')?.textContent ?? summary?.textContent,
                pending:Boolean(document.querySelector('.agent-question button[type=submit]')) };
        })()`);
        assert.equal(answerSummary.pending,false);
        for (const value of ['选择测试方案','方案 A',followupQuestion,followupAnswer]) assert.ok(answerSummary.text?.includes(value),JSON.stringify(answerSummary));
        await assertAgentCardSurface(main,'.agent-question-answer');
        assert.equal(await evaluate(main,`(() => {
            renderMessages(chats.find(chat=>chat.id===activeChatId).messages);
            return document.querySelector('.agent-question-answer')?.textContent.includes(${JSON.stringify(followupAnswer)});
        })()`),true);
        assert.equal(requests[0].reasoning.effort,'medium'); assert.equal(requests[0].temperature,undefined);
        assert.ok(JSON.stringify(requests[1]).includes('方案 A'));
        assert.ok(JSON.stringify(requests[1]).includes(followupAnswer));
        assert.notEqual(requests[1].max_output_tokens,1234);
        await until(() => evaluate(main,'maxTokensLimit === 1234'),'deferred settings applied');
        assert.equal(await evaluate(main,'getAPIKey()'),'updated-key');
        await evaluate(main,`localStorage.setItem('base_url',${JSON.stringify(base)}); localStorage.setItem('api_key','test-only');`);
        const stats = await evaluate(main,"(() => { const c=chats.find(c=>c.id===activeChatId); return {rounds:c.agentCompletedRounds,steps:c.modelRequestSteps,metrics:c.agentTaskMetrics,time:document.querySelector('.message-time')?.textContent}; })()");
        assert.equal(stats.rounds,1); assert.equal(stats.steps,2); assert.equal(stats.metrics.input,200); assert.equal(stats.metrics.cached,100); assert.equal(stats.metrics.output,20); assert.ok(stats.metrics.streamMs>0); assert.match(stats.time,/^\d{2}:\d{2}$/);
        await evaluate(main,"document.getElementById('user-input').value=''; updateTokenEstimate();"); await sleep(200);
        assert.equal(await evaluate(main,"document.getElementById('context-generic-warning').textContent"),'通用预估');
        assert.equal(await evaluate(main,"document.getElementById('context-generic-warning').parentElement.id"),'context-breakdown-note');
        assert.equal(await evaluate(main,"document.getElementById('token-estimate').textContent.startsWith('Toks:')"),true);
        countAvailable = true;
        for (const model of ['claude-opus-4-8','gemini-4-argon','grok-4.6','gpt-6-luna']) {
            const result = await evaluate(main,`estimateContextAccurately([{role:'user',content:'test text'}],{model:${JSON.stringify(model)},contextWindow:10000,reserveTokens:1000})`);
            assert.equal(result.usedTokens,321); assert.equal(result.generic,false); assert.match(result.tokenizerLabel,/API/);
        }
        await evaluate(main,'toggleSettings()');
        const fetchPrefs = await until(() => BrowserWindow.getAllWindows().find(win => /preferences=1/.test(win.webContents.getURL())),'fetch models preferences');
        await until(() => evaluate(fetchPrefs,"Boolean(document.getElementById('input-max-lines'))"),'settings ready');
        await evaluate(fetchPrefs,`document.getElementById('base-url-input').value=${JSON.stringify(base)}; [...document.querySelectorAll('button')].find(b=>b.textContent==='获取可用模型').click();`);
        await until(() => evaluate(fetchPrefs,"document.getElementById('model-list-input').value === 'gpt-6.1-sol\\ndeepseek-flash'"),'model discovery');
        modelListAvailable = false;
        await evaluate(fetchPrefs,"[...document.querySelectorAll('button')].find(b=>b.textContent==='获取可用模型').click()");
        await until(() => evaluate(fetchPrefs,"document.getElementById('model-list-input').nextElementSibling.textContent.includes('后端服务器未返回模型列表')"),'discovery error');
        assert.equal(await evaluate(fetchPrefs,"document.getElementById('model-list-input').value"),'gpt-6.1-sol\ndeepseek-flash');
        await closePreferences(fetchPrefs);
        const process = await evaluate(main,"electronAPI.executeAgentTool({chatId:activeChatId,name:'start_process',arguments:{command:'ping -n 30 127.0.0.1'}})");
        assert.equal(process.success,true);
        await evaluate(main,'AIUIEnhancements.changed()');
        await until(() => evaluate(main,"document.querySelector('#agent-sidebar-processes button')"),'background process sidebar');
        await evaluate(main,"document.querySelector('#agent-sidebar-processes button').click()");
        await until(async () => !(await evaluate(main,'electronAPI.listAgentProcesses()')).processes.some(item => item.running),'background stop');
        console.log('background stopped; checking foreground command');
        await evaluate(main,`(() => { const chat=chats.find(c=>c.id===activeChatId); const message={role:'tool',toolName:'run_shell',toolId:'smoke-shell',arguments:{command:"Write-Output 'regular-smoke'; Start-Sleep -Seconds 20"},status:'running',executionId:'smoke-shell'}; chat.messages.push(message); window.testShell=electronAPI.executeAgentTool({chatId:chat.id,name:'run_shell',executionId:message.executionId,arguments:message.arguments}).then(result=>{message.status='done';return result;}); AIUIEnhancements.changed(); return true; })()`);
        await until(() => evaluate(main,"document.querySelector('#agent-sidebar-processes').textContent.includes('regular-smoke') && !document.querySelector('#agent-sidebar-processes button').disabled"),'regular shell sidebar');
        await sleep(150); await evaluate(main,"document.querySelector('#agent-sidebar-processes button').click()");
        console.log('foreground stop dispatched');
        assert.equal((await evaluate(main,'window.testShell')).cancelled,true);
        console.log('foreground stopped; checking archive');
        await evaluate(main,"appendAgentToolMessageToUI({toolName:'start_process',arguments:{command:'a very long command '.repeat(100)},status:'done',toolId:'compact-background',result:{success:true}})");
        assert.equal(await evaluate(main,"(() => {const n=document.querySelector('[data-agent-tool-id=compact-background] .agent-tool-summary-text'); return n.clientHeight<=parseFloat(getComputedStyle(n).lineHeight)+1;})()"),true);
        const archiveResult = await evaluate(main,`(async () => {
            const progress=[]; let busySeen=false;
            const observer=new MutationObserver(()=>{const bar=document.querySelector('#voice-notification [role=progressbar]');if(bar){progress.push(Number(bar.getAttribute('aria-valuenow')));busySeen ||= document.getElementById('chat-archive-btn').disabled;}});
            observer.observe(document.getElementById('voice-notification'),{subtree:true,childList:true,attributes:true});
            const chat=chats.find(c=>c.id===activeChatId); const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7dQAAAAASUVORK5CYII=';
            const ref=await ImageStore.storeImage(png); chat.messages.push({role:'user',content:'原始输入',attachments:[{isImage:true,fullDataUrl:png}]},{role:'assistant',content:'图片结果',generatedImages:['img:'+ref],completedAt:Date.now()});
            const zip=await AIUIChatArchive.buildArchive(); const data=JSON.parse(await zip.file('conversations.json').async('string')); const exported=data.chats.find(c=>c.id===chat.id); const attachmentExcluded=!exported.messages.some(m=>m.attachments); const imageEmbedded=exported.messages.at(-1).generatedImages[0]===png; const before=chat.messages.length;
            exported.messages.push({role:'assistant',content:'仅追加这一条',completedAt:12345}); zip.file('conversations.json',JSON.stringify(data)); const file=new File([await zip.generateAsync({type:'uint8array'})],'records.zip');
            await AIUIChatArchive.importChats(file); const first=chats.find(c=>c.id===activeChatId).messages.length; await AIUIChatArchive.importChats(file); const second=chats.find(c=>c.id===activeChatId).messages.length;
            const originalClick=HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click=function(){};
            try {await AIUIChatArchive.exportChats();} finally {HTMLAnchorElement.prototype.click=originalClick;observer.disconnect();}
            return {attachmentExcluded,imageEmbedded,before,first,second,progressSeen:progress.length>0,busySeen,buttonsRestored:!document.getElementById('chat-archive-btn').disabled,toolContent:exported.messages.some(m=>m.toolName==='ask_user_question'&&m.content.includes('方案 A'))};
        })()`);
        assert.equal(archiveResult.attachmentExcluded,true); assert.equal(archiveResult.imageEmbedded,true); assert.equal(archiveResult.first,archiveResult.before+1); assert.equal(archiveResult.second,archiveResult.first); assert.equal(archiveResult.toolContent,true);
        assert.equal(archiveResult.progressSeen,true); assert.equal(archiveResult.busySeen,true); assert.equal(archiveResult.buttonsRestored,true);
        const imageActions = await evaluate(main, `(() => {
            const row = document.querySelector('.message-content-col:has(.ai-bubble img)');
            const footer = row.querySelector('.message-footer');
            const actions = [...footer.querySelectorAll('.message-icon-btn')];
            const click = HTMLAnchorElement.prototype.click;
            let download;
            HTMLAnchorElement.prototype.click = function () { download = [this.href, this.download]; };
            try { actions.at(-1).click(); } finally { HTMLAnchorElement.prototype.click = click; }
            return { labels: actions.map(node=>node.getAttribute('aria-label')), iconOnly: actions.every(node=>!node.textContent && node.querySelector('svg')),
                afterTime: actions[0].previousElementSibling.matches('.message-time'),
                download: download[0] === row.querySelector('.ai-bubble img').src && /^generated-/.test(download[1]) };
        })()`);
        assert.deepEqual(imageActions, { labels:['重试','下载图片'], iconOnly:true, afterTime:true, download:true });
        console.log('archive passed; checking live command heading and ordinary chat');
        const shellCall = (id, command, description) => ({ type:'function_call',name:'run_shell',call_id:id,arguments:JSON.stringify({command,description}) });
        const legacyCommand = `Write-Output '${'activity heading '.repeat(85)}'`;
        probeCommandRounds.push([shellCall('shell-legacy',legacyCommand)], [shellCall('shell-probe',command,commandDescription)], [
            { type:'message',role:'assistant',content:[{ type:'output_text',text:'接下来检查第三条命令。' }] },
            shellCall('shell-allowed-2',"Write-Output 'allowed-two'")
        ]);
        await evaluate(main,`(async () => {
            await electronAPI.addAgentAllowedCommand('Write-Output');
            await onAgentCommandModeChange('ask');
            const chat = chats.find(c=>c.id===activeChatId);
            chat.messages.push({role:'user',content:'查看命令摘要'});
            appendMessageToUI('user','查看命令摘要');
            window.testCommandLoop = requestAgentLoop('gpt-6.1-sol',chat);
            return (await electronAPI.checkAgentCommand("Write-Output 'allowed-one'")).allowed;
        })()`).then(allowed => assert.equal(allowed,true));
        await until(() => evaluate(main,"[...document.querySelectorAll('.agent-round-summary.running')].some(el=>el.textContent.startsWith('Running command Write-Output'))"),'legacy command text');
        assert.equal(await evaluate(main,`(() => {
            const label = [...document.querySelectorAll('.agent-round-summary.running .agent-tool-summary-text')].find(node=>node.textContent.startsWith('Running command Write-Output'));
            return label.scrollWidth > label.clientWidth && getComputedStyle(label).textOverflow === 'ellipsis';
        })()`),true);
        await until(() => evaluate(main,"Boolean(document.querySelector('.agent-command-approval-row'))"),'command approval');
        assert.equal(await evaluate(main,"document.querySelector('.agent-command-approval-row .agent-command-description')?.textContent ?? ''"),'');
        const liveDuration = await evaluate(main,"document.querySelector('#messages-wrapper > :last-child .response-worked-duration')?.textContent");
        assert.match(liveDuration,/^Worked for /);
        await until(() => evaluate(main,`document.querySelector('#messages-wrapper > :last-child .response-worked-duration')?.textContent !== ${JSON.stringify(liveDuration)}`),'live elapsed seconds');
        await evaluate(main,"document.querySelector('.agent-command-approval-row button[data-decision=allow]').click()");
        await until(() => evaluate(main,`[...document.querySelectorAll('.agent-round-summary.running')].some(el=>el.textContent.includes(${JSON.stringify(commandDescription)}) && !el.textContent.includes('Write-Output'))`),'active command description');
        await until(() => evaluate(main,`document.querySelector('.agent-command-approval-row:not(.leaving) .agent-command-description')?.textContent === ${JSON.stringify(commandDescription)}`),'approval description');
        const approvalLayout = () => evaluate(main,`(() => {
            const row = document.querySelector('.agent-command-approval-row:not(.leaving)');
            const code = row.querySelector('.agent-command-code');
            const allow = row.querySelector('button[data-decision=allow]');
            const codeBounds = code.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(code);
            const rects = [...range.getClientRects()];
            return {
                description: row.querySelector('.agent-command-description')?.textContent.trim(),
                exactCommand: code.textContent.includes(${JSON.stringify(command)}),
                wraps: new Set(rects.map(rect=>rect.top)).size > 1 && code.scrollWidth <= code.clientWidth + 1,
                actionsAfterCode: codeBounds.bottom <= allow.getBoundingClientRect().top + .5
            };
        })()`);
        const expectedApprovalLayout = { description:commandDescription,exactCommand:true,wraps:true,actionsAfterCode:true };
        assert.deepEqual(await approvalLayout(),expectedApprovalLayout);
        await assertAgentCardSurface(main,'.agent-command-approval-row:not(.leaving) .agent-command-approval-tool');
        main.setSize(390,760); await sleep(250);
        assert.deepEqual(await approvalLayout(),expectedApprovalLayout);
        main.setSize(...agentWindowSize); await sleep(250);
        await evaluate(main,`document.querySelector('.agent-command-approval-row:not(.leaving) .agent-command-approval-tool')
            .dispatchEvent(new KeyboardEvent('keydown',{ key:'Enter',code:'Enter',ctrlKey:true,bubbles:true,cancelable:true }))`);
        await until(() => evaluate(main,"document.querySelector('.agent-command-approval-row:not(.leaving) .agent-command-code')?.textContent.includes('allowed-two')"),'approval for allowed-two');
        assert.equal(await evaluate(main,"!document.querySelector('.agent-command-approval-row:not(.leaving)').textContent.includes('始终允许')"),true);
        await evaluate(main,"resolveAgentCommandApproval('allow');");
        await evaluate(main,"window.testCommandLoop");
        assert.deepEqual(await evaluate(main,`(() => {
            const text = [...document.querySelectorAll('#messages-wrapper > .agent-segment-row')].find(row=>row.textContent.includes('接下来检查第三条命令。'));
            const summary = row => row.querySelector('.agent-round-summary').textContent.trim();
            return [summary(text.previousElementSibling), summary(text.nextElementSibling), document.getElementById('command-mode-trigger').textContent];
        })()`),['Ran 2 commands','Ran 1 command','Always Ask']);
        let releaseLaterResponse;
        laterResponseGate = new Promise(resolve => { releaseLaterResponse = resolve; });
        const scrollToHistory = () => evaluate(main,"document.getElementById('messages-wrapper').scrollTo({ top:0, behavior:'instant' })");
        await scrollToHistory();
        await evaluate(main,`(() => {
            localStorage.setItem('agent_auto_scroll','false');
            document.getElementById('user-input').value = '发送 Agent 任务后自动滚动到底部';
            window.testAutoScrollLoop = sendMessage();
        })()`);
        await until(() => evaluate(main,"document.querySelector('.agent-round-summary.running')?.textContent === 'Thinking'"),'new Agent task appears');
        await waitForTranscriptBottom(main,'sending an Agent prompt follows the transcript with the legacy setting disabled');
        await scrollToHistory();
        releaseLaterResponse();
        laterResponseGate = null;
        await evaluate(main,'window.testAutoScrollLoop');
        await waitForTranscriptBottom(main,'the final Agent reply brings the viewport back to the bottom');
        await scrollToHistory();
        await evaluate(main,"renderMessages(chats.find(chat=>chat.id===activeChatId).messages)");
        await waitForTranscriptBottom(main,'rebuilding the Agent transcript follows the latest content');
        await scrollToHistory();
        const aboveBottom = await until(async () => {
            const state = await transcriptBottomState(main);
            return state.opacity === 1 && state;
        },'return to bottom fades in');
        assert.ok(aboveBottom.overflows && aboveBottom.remaining > 2 && aboveBottom.hasMore && aboveBottom.fades &&
            aboveBottom.interactive && aboveBottom.floating && aboveBottom.translucent && aboveBottom.blurred && aboveBottom.transition,JSON.stringify(aboveBottom));
        await evaluate(main,"document.getElementById('scroll-to-bottom').click()");
        await until(async () => {
            const state = await transcriptBottomState(main);
            return state.overflows && Math.abs(state.remaining) < 2 && !state.hasMore && !state.fades && state.opacity === 0 && !state.interactive;
        },'explicit jump reaches the bottom and hides its button');
        await scrollToHistory();
        await evaluate(main,`(() => {
            const transcript = document.getElementById('messages-wrapper');
            const round = transcript.querySelector('.agent-round-summary[aria-expanded="false"]');
            round.click();
            const detail = round.nextElementSibling.querySelector('.agent-tool-summary[aria-expanded="false"]');
            detail?.click();
            const bubble = [...document.querySelectorAll('#messages-wrapper .ai-bubble p')].at(-1);
            bubble.firstChild.data = '编辑历史消息。';
        })()`);
        await sleep(450);
        assert.ok((await transcriptBottomState(main)).remaining > 2, 'expanding or editing history preserves the reading position');
        const [width, height] = main.getSize();
        main.setSize(width, height - 50);
        await sleep(450);
        assert.ok((await transcriptBottomState(main)).remaining > 2, 'resizing preserves the reading position');
        main.setSize(width, height);
        ordinaryStream = true;
        await evaluate(main,"(() => {const chat=chats.find(c=>c.id===activeChatId); chat.agentEnabled=false; chat.messages.push({role:'user',content:'普通聊天测试'}); updateAgentUIForChat(chat); window.testOrdinary=requestAI('普通聊天测试','gpt-6.1-sol',chat,[]); return true;})()");
        await until(() => evaluate(main,"document.querySelector('.response-activity .agent-round-summary.running')?.textContent === 'Thinking'"),'ordinary live activity');
        await evaluate(main,"window.testOrdinary");
        await waitForTranscriptBottom(main,'ordinary chat follows the latest reply');
        assert.equal(await evaluate(main,"document.querySelector('.response-activity .agent-round-summary')?.textContent === 'Thought'"),true);
        await evaluate(main,"document.querySelector('.response-activity .agent-round-summary').click(); document.querySelector('.response-activity .agent-tool-summary').click()");
        assert.match(await evaluate(main,"document.querySelector('.response-activity .thinking-text').textContent"),/普通对话的思考内容/);
        const retry = await evaluate(main, `(() => {
            const footer = document.querySelector('.response-activity').parentElement.querySelector('.message-footer');
            const actions = [...footer.querySelectorAll('.message-icon-btn')];
            const iconOnly = actions.every(node=>!node.textContent && getComputedStyle(node).backgroundColor === 'rgba(0, 0, 0, 0)');
            const ordered = footer.firstElementChild.matches('.message-time') && !footer.querySelector('.message-model,.response-worked-duration');
            return { labels: actions.map(node=>node.getAttribute('aria-label')), iconOnly, ordered };
        })()`);
        assert.deepEqual(retry, { labels:['重试','复制回复'], iconOnly:true, ordered:true });
        await evaluate(main,`(() => {
            const select = document.getElementById('model-select');
            select.value = 'deepseek-flash';
            document.querySelector('.response-activity').parentElement.querySelector('[aria-label="重试"]').click();
        })()`);
        await until(() => requests.at(-1).model === 'deepseek-flash','retry with current model');
        await until(() => evaluate(main,'!isGenerating'),'retry completion');
        await sleep(250);
        await evaluate(main,"scrollChatToBottom()");
        await waitForTranscriptBottom(main,'scrolling settles before capturing activity');
        await fs.writeFile(path.join(artifacts,'ordinary-activity.png'),(await main.webContents.capturePage()).toPNG());
        await evaluate(main,"document.getElementById('messages-wrapper').scrollTo({ top:0, behavior:'instant' })");
        await until(async () => {
            const state = await transcriptBottomState(main);
            return state.overflows && state.remaining > 2 && state.fades && state.opacity === 1;
        },'ordinary chat shows the bottom fade and button away from the bottom');
        await evaluate(main,"scrollChatToBottom()");
        const ordinary = await evaluate(main,"(() => {const chat=chats.find(c=>c.id===activeChatId); return {metrics:document.getElementById('task-metrics').textContent,sidebar:document.getElementById('agent-info-toggle').hidden,time:chat.messages.at(-1).completedAt};})()");
        assert.equal(ordinary.sidebar,true); assert.doesNotMatch(ordinary.metrics,/轮|步/); assert.match(ordinary.metrics,/tok\/s/); assert.ok(ordinary.time>0);
        console.log('ordinary chat passed; checking errors and narrow layout');
        textRequestFails = true;
        await evaluate(main,"requestAI('模拟错误','gpt-6.1-sol',chats.find(c=>c.id===activeChatId),[])");
        assert.deepEqual(await evaluate(main,"[document.getElementById('task-metrics').textContent,document.getElementById('token-estimate').style.display,document.getElementById('context-meter').classList.contains('visible')]"),['','none',false]);
        main.setSize(520,760); await sleep(250);
        await evaluate(main,"(() => {const chat=chats.find(c=>c.id===activeChatId);chat.agentEnabled=true;updateAgentUIForChat(chat);document.getElementById('agent-info-toggle').click();})()");
        assert.deepEqual(await evaluate(main,"[document.getElementById('agent-info-toggle').hidden,document.body.classList.contains('agent-info-open'),document.getElementById('agent-info-sidebar').inert]"),[true,false,true]);
        assert.equal(await evaluate(main,"document.querySelector('main>header').getBoundingClientRect().height"),headerHeight);
        await evaluate(main,"document.getElementById('user-input').value='窄屏统计';autoResize(document.getElementById('user-input'));chats.find(c=>c.id===activeChatId).lastRequestFailed=false;AIUIEnhancements.changed()");await sleep(250);
        assert.equal(await composerControls(main), true);
        await evaluate(main,"toggleSidebar(true)");
        assert.equal(await evaluate(main,"(() => {const b=document.getElementById('history-new-chat'),c=document.querySelector('.history-toolbar button:last-child');return b.textContent.trim()===''&&Math.abs(b.getBoundingClientRect().top-c.getBoundingClientRect().top)<1;})()"),true);
        await evaluate(main,"document.querySelector('.history-toolbar button:last-child').click()");
        assert.equal(await evaluate(main,"document.getElementById('sidebar').classList.contains('active')"),false);
        await evaluate(main,"document.getElementById('model-selector-trigger').click()");
        assert.equal(await evaluate(main,"(() => { const r=document.querySelector('.choice-popover.open').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()"),true);
        await openReasoningOverlay(main);
        assert.equal(await evaluate(main,"getComputedStyle(document.querySelector('.context-meter-track')).borderRadius==='50%'"),true);
        await fs.writeFile(path.join(artifacts,'mobile-layout.png'),(await main.webContents.capturePage()).toPNG());
        main.setSize(390,760); await sleep(250);
        assert.equal(await composerControls(main), true);
        assert.match(await evaluate(main,"document.getElementById('context-breakdown-metrics').textContent"),/tok\/s/);
        await evaluate(main, "document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))");
        assert.equal(await evaluate(main, "document.activeElement === document.querySelector('.reasoning-footer') && document.querySelectorAll('.choice-popover.open').length === 1"), true);
        await openReasoningOverlay(main);
        assert.equal(await evaluate(main,"(() => {const input=document.querySelector('#input-footer .input-area').getBoundingClientRect(),send=document.getElementById('send-btn').getBoundingClientRect();return send.right<=input.right&&document.getElementById('user-input').clientWidth>0&&document.getElementById('agent-info-toggle').hidden;})()"),true);
        await fs.writeFile(path.join(artifacts,'phone-layout.png'),(await main.webContents.capturePage()).toPNG());
        main.setSize(1180,800); await sleep(300);
        assert.deepEqual(await evaluate(main,"[document.getElementById('agent-info-toggle').hidden,document.body.classList.contains('agent-info-open')]"),[false,false]);
        await evaluate(main,`(() => {
            AIUIEnhancements.closeChoices();
            localStorage.setItem('base_url',${JSON.stringify(base)});
            createNewChat();
            switchToImageGeneration();
            document.getElementById('user-input').value = '生成测试图片';
            return sendMessage();
        })()`);
        const liveImage = await evaluate(main,`(() => {
            const footer = document.querySelector('.message-content-col:has(.ai-bubble img) .message-footer');
            const children = [...footer.children];
            const matches = children.map(node=>node.className);
            const icons = children.slice(1).map(node=>node.getAttribute('aria-label'));
            return { matches, icons, time: children[0].textContent };
        })()`);
        assert.deepEqual(liveImage.matches,['message-time','message-icon-btn','message-icon-btn']);
        assert.deepEqual(liveImage.icons,['重试','下载图片']);
        assert.match(liveImage.time,/^\d{2}:\d{2}$/);
        await evaluate(main,`(() => {
            document.getElementById('model-select').value = 'gpt-image-2.6-flare';
            document.querySelector('.message-footer [aria-label="重试"]').click();
        })()`);
        await until(() => imageRequests.length === 2,'image retry request');
        assert.equal(imageRequests[1].model,'gpt-image-2.6-flare');
        assert.equal(imageRequests[1].prompt,imageRequests[0].prompt);
        await until(() => evaluate(main,'!isGenerating'),'image retry completion');
        assert.deepEqual(await evaluate(main,"chats.find(c=>c.id===activeChatId).messages.map(message=>message.role)"),['user','assistant']);
        assert.deepEqual(errors.filter(message => !/Unexpected token.*json|not valid JSON/.test(message)),[]);
        await fs.writeFile(path.join(profile,'result.json'),JSON.stringify({passed:true,errors}));
        console.log(JSON.stringify({ passed:true,artifacts,errors },null,2));
        server?.close(); app.exit(0);
    } catch (error) { server?.close(); console.error(error.stack || error); console.error(JSON.stringify({ errors,profile })); app.exit(1); }
});
