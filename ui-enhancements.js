(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const preferences = new URLSearchParams(location.search).has('preferences');
    if (preferences) document.body.classList.add('preferences-window');
    const capabilities = window.AIUIModelCapabilities;
    let selectedCapability = capabilities.get($('model-select').value);
    let reasoningValue = selectedCapability.default;
    let currentBreakdown = null;
    let settingsPending = false;
    let modelTrigger, modeTrigger, reasoningTrigger;
    let activePopover = null;
    let taskBase = null;
    let resizeFrame;
    let preferencesRefreshTimer;
    let runtimeApi = null;
    const originalAPIKey = window.getAPIKey;
    const originalBaseURL = window.getBaseURL;
    const originalEndpoint = window.getRequestEndpoint;
    window.getAPIKey = () => runtimeApi ? runtimeApi.key : originalAPIKey();
    window.getBaseURL = () => runtimeApi ? runtimeApi.base : originalBaseURL();
    window.getRequestEndpoint = () => runtimeApi ? runtimeApi.endpoint : originalEndpoint();
    function freezeRuntimeAPI() { runtimeApi = { key:originalAPIKey(),base:originalBaseURL(),endpoint:originalEndpoint() }; }
    const choices = new Set();
    const currentChat = () => chats.find(chat => chat.id === activeChatId);
    const icon = name => `<i data-lucide="${name}"></i>`;
    function savedReasoning() { try { return JSON.parse(localStorage.getItem('model_reasoning_settings') || '{}'); } catch (_) { return {}; } }
    function chooseReasoning(value) {
        reasoningValue = selectedCapability.values.includes(value) ? value : selectedCapability.default;
        const saved = savedReasoning(); saved[$('model-select').value] = reasoningValue;
        localStorage.setItem('model_reasoning_settings', JSON.stringify(saved));
        updateReasoningLabel();
    }
    function updateReasoningLabel() {
        if (!reasoningTrigger) return;
        const claude = selectedCapability.mechanism === 'adaptive-effort';
        reasoningTrigger.querySelector('.reasoning-value').textContent = `${claude ? 'Effort · ' : ''}${reasoningLabel(reasoningValue)}`;
        reasoningTrigger.disabled = !selectedCapability.values.some(value => value !== 'default');
        reasoningTrigger.title = claude ? 'Adaptive thinking · Effort' : selectedCapability.mechanism === 'fixed' ? 'This model has no adjustable reasoning control' : selectedCapability.mechanism;
    }
    function reasoningLabel(value) {
        if (value === 'default') return 'Automatic';
        return `${capabilities.label(value)}${value === selectedCapability.default ? ' (default)' : ''}`;
    }
    function syncModel() {
        if (!modelTrigger) return;
        const model = $('model-select').value;
        const next = capabilities.get(model);
        if (next.model !== selectedCapability.model) {
            reasoningValue = capabilities.compatible(selectedCapability,next,reasoningValue) ? reasoningValue : next.default;
            selectedCapability = next;
        }
        modelTrigger.querySelector('span').textContent = model;
        updateReasoningLabel();
    }
    function createPopover(label) {
        const node = document.createElement('div');
        node.className = 'choice-popover detail-surface'; node.setAttribute('role','dialog'); node.setAttribute('aria-label',label);
        node.inert = true; document.body.append(node); choices.add(node); return node;
    }
    function closeChoices(restore = false) {
        for (const node of choices) { node.classList.remove('open'); node.inert = true; node.style.removeProperty('width'); }
        document.querySelectorAll('.custom-select-trigger').forEach(node => node.setAttribute('aria-expanded','false'));
        if (restore) activePopover?.trigger?.focus();
        activePopover = null;
    }
    function positionPopover(node, trigger) {
        if (node.classList.contains('reasoning-choice-popover')) {
            const parent = trigger.closest('.model-choice-popover');
            const gap = 8, margin = 12, available = innerWidth - margin * 2 - gap;
            const childWidth = Math.min(240,Math.floor(available * .43));
            const parentWidth = Math.min(340,available-childWidth);
            parent.style.width = `${parentWidth}px`;
            positionPopover(parent,modelTrigger);
            const rect = parent.getBoundingClientRect();
            const left = Math.max(margin,Math.min(rect.left,innerWidth-margin-parentWidth-childWidth-gap));
            parent.style.left = `${left}px`;
            node.style.width = `${childWidth}px`;
            node.style.maxHeight = `${Math.min(440,innerHeight-24)}px`;
            node.style.left = `${left+parentWidth+gap}px`;
            const footer = trigger.getBoundingClientRect(), height = node.getBoundingClientRect().height;
            node.style.top = `${Math.max(margin,Math.min(footer.bottom-height,innerHeight-height-margin))}px`;
            return;
        }
        const rect = trigger.getBoundingClientRect();
        const maxHeight = Math.max(140, Math.min(440, innerHeight * .75, innerHeight - 24));
        node.style.maxHeight = `${maxHeight}px`;
        const width = node.getBoundingClientRect().width;
        node.style.left = `${Math.max(12, Math.min(rect.left, innerWidth-width-12))}px`;
        const height = node.getBoundingClientRect().height;
        node.style.top = `${Math.max(12, rect.top >= height + 12 ? rect.top-height-7 : Math.min(innerHeight-height-12,rect.bottom+7))}px`;
    }
    function openChoice(node, trigger, keepModel = false) {
        $('attach-menu')?.classList.remove('visible');
        const open = node.classList.contains('open');
        if (!keepModel) closeChoices();
        if (open) { node.classList.remove('open'); node.inert = true; trigger.setAttribute('aria-expanded','false');
            if (keepModel) { const parent=trigger.closest('.model-choice-popover'); parent.style.removeProperty('width'); positionPopover(parent,modelTrigger); activePopover={node:parent,trigger:modelTrigger}; }
            return;
        }
        node.inert = false; node.classList.add('open'); trigger.setAttribute('aria-expanded','true');
        activePopover = { node,trigger }; positionPopover(node,trigger);
        (node.querySelector('input') || node.querySelector('button'))?.focus();
    }
    function trigger(label, title) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'custom-select-trigger';
        button.innerHTML = `<span></span>${icon('chevron-down')}`; button.querySelector('span').textContent = label;
        button.setAttribute('aria-haspopup','dialog'); button.setAttribute('aria-expanded','false'); button.title = title; return button;
    }
    function option(value,label,description,selected,onSelect,danger = false) {
        const button = document.createElement('button'); button.type = 'button'; button.className = `choice-option${danger ? ' danger':''}`;
        button.setAttribute('role','option'); button.setAttribute('aria-selected',String(selected));
        const check = document.createElement('span'); check.className = 'check'; check.textContent = selected ? '✓':'';
        const copy = document.createElement('span'); copy.textContent = label;
        if (description) { const small = document.createElement('small'); small.textContent = description; copy.append(small); }
        button.append(check,copy); button.onclick = () => onSelect(value); return button;
    }
    function initializeSelectors() {
        const select = $('model-select'); select.classList.add('native-select-source');
        modelTrigger = trigger(select.value,'选择模型'); modelTrigger.id = 'model-selector-trigger'; select.after(modelTrigger);
        const modelPopover = createPopover('选择模型');
        modelPopover.classList.add('model-choice-popover');
        const list = document.createElement('div'); list.className = 'choice-options'; list.setAttribute('role','listbox');
        reasoningTrigger = trigger('Reasoning depth','Reasoning depth'); reasoningTrigger.classList.add('reasoning-footer');
        const value = document.createElement('span'); value.className = 'reasoning-value';
        reasoningTrigger.querySelector('svg,i').before(value);
        modelPopover.append(list,reasoningTrigger);
        function renderModels() {
            list.replaceChildren();
            for (const item of select.options) {
                list.append(option(item.value,item.textContent,'',select.value === item.value,value => {
                    select.value = value; select.dispatchEvent(new Event('change')); syncModel(); renderModels();
                    if (reasoningPopover.classList.contains('open')) openChoice(reasoningPopover,reasoningTrigger,true);
                }));
            }
            reasoningTrigger.hidden = isImageMode;
        }
        modelTrigger.onclick = event => { event.stopPropagation(); renderModels(); openChoice(modelPopover,modelTrigger); };
        const reasoningPopover = createPopover('Reasoning depth');
        reasoningPopover.classList.add('reasoning-choice-popover');
        reasoningTrigger.onclick = event => {
            event.stopPropagation(); reasoningPopover.replaceChildren();
            const options = document.createElement('div'); options.className = 'choice-options'; options.setAttribute('role','listbox');
            for (const value of selectedCapability.values.filter(value => value !== 'default')) options.append(option(value,reasoningLabel(value),
                selectedCapability.mechanism === 'adaptive-effort' ? 'Adaptive thinking · Effort' : '',
                value === reasoningValue,chosen => { chooseReasoning(chosen); openChoice(reasoningPopover,reasoningTrigger,true); reasoningTrigger.focus(); }));
            reasoningPopover.append(options); openChoice(reasoningPopover,reasoningTrigger,true);
        };
        select.addEventListener('change',syncModel);
        new MutationObserver(syncModel).observe(select,{ childList:true,subtree:true });
        const mode = $('agent-command-mode-select'); mode.classList.add('native-select-source');
        modeTrigger = trigger('','指令运行审批'); modeTrigger.id = 'command-mode-trigger';
        $('agent-command-mode-bar').append(modeTrigger); $('send-btn').before($('agent-command-mode-bar'));
        const modePopover = createPopover('指令运行审批');
        modeTrigger.onclick = event => {
            event.stopPropagation(); modePopover.replaceChildren();
            const options = document.createElement('div'); options.className = 'choice-options';
            options.append(option('safe','Safe Commands Only','仅自动运行白名单命令，其余命令需你批准。',mode.value === 'safe',setMode),
                option('yolo','YOLO Mode','自动运行所有命令，可能修改或删除文件。',mode.value === 'yolo',setMode,true));
            modePopover.append(options);
            openChoice(modePopover,modeTrigger);
        };
        async function setMode(value) { closeChoices(); mode.value = value; await window.onAgentCommandModeChange(value); syncMode(); }
        function syncMode() { syncCommandMode(); }
        new MutationObserver(syncMode).observe(mode,{ attributes:true,subtree:true,childList:true });
        mode.addEventListener('change',() => setTimeout(syncMode,0));
        const saved = savedReasoning()[select.value]; if (selectedCapability.values.includes(saved)) reasoningValue = saved;
        syncModel(); syncMode();
    }
    function syncCommandMode() {
        if (!modeTrigger) return;
        const yolo = $('agent-command-mode-select').value === 'yolo';
        const name = yolo ? 'shield-alert':'shield-check';
        if (modeTrigger.dataset.icon !== name) {
            modeTrigger.innerHTML = icon(name); modeTrigger.dataset.icon = name; lucide.createIcons();
        }
        modeTrigger.classList.toggle('yolo',yolo);
        modeTrigger.title = `指令核准：${yolo ? 'YOLO Mode':'Safe Commands Only'}`;
        modeTrigger.setAttribute('aria-label',modeTrigger.title);
    }
    function responsiveMeter() {
        const meter = $('context-meter'); if (!meter) return;
        const row = document.querySelector('.input-selector-row');
        const compact = row.clientWidth < 820 || $('chat-column').clientWidth < 900;
        meter.classList.toggle('compact',compact);
        meter.style.setProperty('--usage-percent',String(currentBreakdown?.usedPercent || 0));
    }
    function renderMetrics() {
        const chat = currentChat(), node = $('task-metrics');
        if (!node) return;
        const lastAnswer = [...(chat?.messages || [])].reverse().find(message => message.role === 'assistant' && !message.hidden);
        if (isImageMode || (!isGenerating && lastAnswer?.generatedImages?.length) || chat?.lastRequestFailed) { node.textContent = ''; if (chat?.lastRequestFailed) { $('token-estimate').style.display = 'none'; $('context-meter').classList.remove('visible'); } return; }
        const task = chat?.agentEnabled ? chat.agentTaskMetrics : chat?.lastRequestMetrics;
        const parts = [];
        if (chat?.agentEnabled) parts.push(`${Number(chat.agentCompletedRounds || 0)} 轮 ${Number(chat.modelRequestSteps || 0)} 步`);
        if (task?.streamMs > 0) parts.push(`${(task.output/(task.streamMs/1000)).toFixed(1)} tok/s`);
        if (task?.hasUsage && task.input > 0) parts.push(`缓存命中 ${(task.cached/task.input*100).toFixed(1)}%`);
        node.textContent = parts.join(' · '); responsiveMeter();
    }
    function renderSidebarContext() {
        const container = $('agent-sidebar-context'); if (!container) return;
        const original = $('context-breakdown'); const clone = original.cloneNode(true);
        clone.removeAttribute('id'); clone.removeAttribute('role'); clone.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
        clone.classList.remove('is-open'); container.replaceChildren(clone);
    }
    async function renderSidebar() {
        if (!$('agent-info-toggle')) return;
        const chat = currentChat(), agent = Boolean(chat?.agentEnabled);
        const available = agent && !matchMedia('(max-width:899px), (max-aspect-ratio:1/1)').matches && $('main-content').clientWidth >= 760;
        $('agent-info-toggle').hidden = !available;
        document.body.classList.toggle('agent-sidebar-unavailable',!available);
        if (!available && document.body.classList.contains('agent-info-open')) document.body.classList.remove('agent-info-open');
        const open = available && document.body.classList.contains('agent-info-open');
        $('agent-info-toggle').setAttribute('aria-expanded',String(open));
        $('agent-info-sidebar').inert = !open;
        if (!open) return;
        renderSidebarContext();
        const plans = $('agent-sidebar-plan'); plans.replaceChildren();
        const plan = chat.agentPlan;
        $('agent-sidebar-plan-section').hidden = !plan?.steps?.length;
        for (const item of plan?.steps || []) {
            const row = document.createElement('div'); row.className = 'sidebar-plan-step'; row.dataset.status = item.status;
            const marker = document.createElement('span'); marker.textContent = item.status === 'completed' ? '✓':item.status === 'in_progress' ? '◉':'○';
            const text = document.createElement('span'); text.textContent = item.step; row.append(marker,text); plans.append(row);
        }
        const running = (chat.messages || []).filter(m => m.toolName === 'run_shell' && m.status === 'running').map(m => ({ command:m.arguments?.command, executionId:m.executionId }));
        try { const result = await window.electronAPI?.listAgentProcesses(); if (currentChat() !== chat) return; for (const process of result?.processes || []) if (process.running) running.push(process); } catch (_) {}
        const processes = $('agent-sidebar-processes'); processes.replaceChildren(); $('agent-sidebar-process-section').hidden = !running.length;
        for (const process of running) {
            const row = document.createElement('div'); row.className = 'sidebar-process';
            const text = document.createElement('span'); text.textContent = process.command || process.processId; text.title = text.textContent;
            const stop = document.createElement('button'); stop.type = 'button'; stop.textContent = '终止';
            stop.onclick = async () => { stop.disabled = true; try { if (process.executionId) await window.electronAPI.cancelAgentExecution(process.executionId); else await window.electronAPI.executeAgentTool({ chatId:chat.id,name:'stop_process',arguments:{ process_id:process.processId } }); } finally { renderSidebar(); } };
            row.append(text,stop); processes.append(row);
        }
    }
    function initializeSidebar() {
        const button = document.createElement('button'); button.type = 'button'; button.id = 'agent-info-toggle'; button.title = 'Agent 侧栏'; button.setAttribute('aria-label','切换 Agent 侧栏'); button.setAttribute('aria-expanded','false'); button.innerHTML = icon('panel-right'); button.hidden = true;
        document.querySelector('main>header').append(button);
        const sidebar = document.createElement('aside'); sidebar.id = 'agent-info-sidebar'; sidebar.className = 'agent-info-sidebar'; sidebar.inert = true;
        sidebar.innerHTML = '<div class="agent-info-sidebar-content"><section><h3>上下文详细用量</h3><div id="agent-sidebar-context"></div></section><section id="agent-sidebar-process-section" hidden><h3>正在运行</h3><div id="agent-sidebar-processes"></div></section><section id="agent-sidebar-plan-section" hidden><h3>任务计划</h3><div id="agent-sidebar-plan"></div></section></div>';
        $('main-content').append(sidebar);
        button.onclick = () => { if (button.hidden) return; const open = document.body.classList.toggle('agent-info-open'); button.setAttribute('aria-expanded',String(open)); renderSidebar(); };
        const toolbar = document.createElement('div'); toolbar.className = 'history-toolbar';
        const newChat = $('sidebar').querySelector('button[onclick="createNewChat()"]'); newChat.id = 'history-new-chat'; newChat.title = '新建对话'; newChat.setAttribute('aria-label','新建对话'); newChat.innerHTML = icon('plus');
        const collapse = document.createElement('button'); collapse.type = 'button'; collapse.title = '收起历史会话'; collapse.setAttribute('aria-label',collapse.title); collapse.innerHTML = icon('panel-left-close'); collapse.onclick = () => { if (innerWidth < 768) toggleSidebar(false); else document.body.classList.add('history-collapsed'); }; toolbar.append(newChat,collapse); $('sidebar').prepend(toolbar);
        const header = document.querySelector('main>header');
        const headerControls = document.createElement('div'); headerControls.className = 'header-history-controls';
        const mobileToggle = header.querySelector('button[onclick="toggleSidebar(true)"]'); mobileToggle.setAttribute('aria-label','展开历史会话');
        const restore = document.createElement('button'); restore.type = 'button'; restore.id = 'history-restore'; restore.title = '展开历史会话'; restore.setAttribute('aria-label',restore.title); restore.innerHTML = icon('panel-left-open'); restore.onclick = () => document.body.classList.remove('history-collapsed');
        const headerNew = newChat.cloneNode(true); headerNew.id = 'header-new-chat'; headerNew.onclick = () => createNewChat();
        headerControls.append(restore,mobileToggle,headerNew); header.prepend(headerControls);
        const metrics = document.createElement('span'); metrics.id = 'task-metrics'; metrics.className = 'task-metrics'; $('context-estimate-shell').append(metrics);
        new ResizeObserver(() => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(() => { responsiveMeter(); positionContextBreakdown(); }); }).observe($('chat-column'));
        new ResizeObserver(() => positionContextBreakdown()).observe($('context-estimate-shell'));
        new ResizeObserver(() => renderSidebar()).observe($('main-content'));
        new MutationObserver(() => { renderMetrics(); renderSidebar(); }).observe(document.body,{ attributes:true,attributeFilter:['class'] });
        // Process state changes outside model requests (background completion).
        setInterval(() => { if (!preferences && document.body.classList.contains('agent-info-open')) renderSidebar(); },1200);
    }
    function addSetting(section,id,label,type,value,description) {
        const row = document.createElement('div'); row.className = 'flex items-center justify-between bg-[#1a1a1a] rounded-xl p-4 border border-gray-700';
        const copy = document.createElement('div'); copy.className = 'flex flex-col pr-3 min-w-0';
        const title = document.createElement('label'); title.htmlFor = id; title.className = 'text-sm font-medium text-gray-200'; title.textContent = label;
        const input = document.createElement('input'); input.id = id; input.type = type;
        const small = document.createElement('span'); small.id = `${id}-hint`; small.className = 'text-[11px] text-gray-500 mt-0.5'; small.textContent = description;
        input.setAttribute('aria-describedby',small.id); copy.append(title,small); row.append(copy);
        if (type === 'checkbox') {
            input.checked = value; input.setAttribute('role','switch');
            const toggle = document.createElement('label'); toggle.className = 'cloud-toggle shrink-0';
            const slider = document.createElement('span'); slider.className = 'slider'; slider.setAttribute('aria-hidden','true');
            toggle.append(input,slider); row.append(toggle);
        } else {
            input.value = value; input.min = '1'; input.max = '30'; input.step = '1'; input.inputMode = 'numeric';
            const stepper = document.createElement('div'); stepper.className = 'setting-stepper';
            const normalize = () => { input.value = String(Math.max(1,Math.min(30,Math.round(Number(input.value) || 6)))); };
            function stepButton(direction,name) {
                const button = document.createElement('button'); button.type = 'button'; button.innerHTML = icon(name);
                button.setAttribute('aria-label',`${direction < 0 ? '减少':'增加'}${label}`);
                button.onclick = () => { normalize(); input.value = String(Math.max(1,Math.min(30,Number(input.value)+direction))); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); };
                return button;
            }
            input.addEventListener('change',normalize);
            stepper.append(stepButton(-1,'minus'),input,stepButton(1,'plus')); row.append(stepper);
        }
        $(section).append(row); return input;
    }
    function appearance() {
        const accent = getComputedStyle(document.body).getPropertyValue('--accent-strong').trim();
        window.electronAPI?.updateAppearance({ theme:document.body.classList.contains('theme-dark') ? 'dark':'light', accent });
    }
    function refreshPreferences() {
        setTheme(localStorage.getItem('theme') || 'light',false); setAccentColor(localStorage.getItem('accent_color') || 'green',false);
        appearance();
        if (isGenerating || contextCompactionRunning || window._audioChatRunning || window._desktopWorkRunning) { settingsPending = true; return; }
        settingsPending = false;
        systemPrompt = localStorage.getItem('sys_prompt') || '';
        currentTemp = Number(localStorage.getItem('chat_temp') || '1');
        maxTokensLimit = Number(localStorage.getItem('max_tokens_limit') || '0');
        autoSummaryInterval = Number(localStorage.getItem('auto_summary_interval') || '0');
        developerModeEnabled = localStorage.getItem('developer_mode') === 'true';
        logLevel = localStorage.getItem('log_level') || 'info'; recordLogsEnabled = localStorage.getItem('record_logs') === 'true';
        mathRenderingEnabled = localStorage.getItem('math_rendering_enabled') !== 'false';
        autoUpdateEnabled = localStorage.getItem('auto_update_enabled') !== 'false';
        currentFontSize = localStorage.getItem('font_size') || 'medium'; setFontSize(currentFontSize);
        currentLayoutMode = localStorage.getItem('layout_mode') || 'classic'; applyLayoutMode(currentLayoutMode);
        selectedBackgroundImage = Number(localStorage.getItem('bg_image') || '1'); updateBackgroundImage();
        currentCanvasFontSize = localStorage.getItem('canvas_font_size') || 'medium'; setCanvasFontSize(currentCanvasFontSize);
        applyTextModelList(loadModelList(),localStorage.getItem('selected_model')); autoResize($('user-input')); syncModel(); syncAppStateToMain();
    }
    function initializeSettings() {
        addSetting('section-ai-chat','input-max-lines','输入框最大行数','number',Number(localStorage.getItem('input_max_lines')) || 6,'超过此行数后在输入框内滚动。');
        addSetting('section-agent','agent-native-notifications','任务完成或需要回答时发送系统通知','checkbox',localStorage.getItem('agent_native_notifications') !== 'false','仅在主窗口未激活时通知，并播放系统通知音效。');
        addSetting('developer-options','enhanced-tool-parser','增强的工具调用解析','checkbox',localStorage.getItem('enhanced_tool_parser') === 'true','兼容 Dot / Liquid 平台的特殊工具标记，默认关闭。');
        const immediateSettings = {
            'sys-prompt':'sys_prompt',
            'voice-chat-model-input':'voice_chat_model', 'voice-fish-base-input':'voice_fish_base',
            'voice-fish-key-input':'voice_fish_key', 'voice-fish-name-input':'voice_fish_name',
            'voice-fish-id-input':'voice_fish_id', 'voice-xf-appid-input':'voice_xf_appid',
            'voice-xf-key-input':'voice_xf_key', 'voice-xf-secret-input':'voice_xf_secret',
            'voice-preset-probability':'voice_preset_probability',
            'desktop-shortcut-input':'desktop_shortcut', 'desktop-image-quality-input':'desktop_image_quality',
            'desktop-skip-b-preset-input':'desktop_skip_b_preset', 'desktop-auto-screenshot-input':'desktop_auto_screenshot',
            'math-render-toggle':'math_rendering_enabled', 'auto-update-toggle':'auto_update_enabled',
            'developer-mode-toggle':'developer_mode', 'record-logs-toggle':'record_logs',
            'agent-auto-scroll':'agent_auto_scroll', 'input-max-lines':'input_max_lines',
            'agent-native-notifications':'agent_native_notifications', 'enhanced-tool-parser':'enhanced_tool_parser'
        };
        function persistImmediateSetting(event) {
            const input = event.target;
            const section = input.closest('.settings-content-section');
            if (!section || section.id === 'section-api' || input.disabled || input.readOnly) return;
            const key = immediateSettings[input.id];
            if (key) {
                const value = input.type === 'checkbox' ? String(input.checked) : input.id === 'input-max-lines'
                    ? String(Math.max(1,Math.min(30,Math.round(Number(input.value) || 6)))) : input.value;
                localStorage.setItem(key,value);
                if (input.id === 'sys-prompt') systemPrompt = input.value;
            }
            if (input.name === 'auto-summary-interval') onContextSettingChange();
            if (section.id === 'section-agent' && event.type === 'change' && input.id !== 'agent-native-notifications' && input.id !== 'agent-auto-scroll') saveAgentCommandSettings();
            window.electronAPI?.preferencesChanged();
        }
        $('settings-modal').addEventListener('input',persistImmediateSetting);
        $('settings-modal').addEventListener('change',persistImmediateSetting);
        $('settings-modal').addEventListener('click',event => {
            const button = event.target.closest('button'), image = event.target.closest('[id^="bg-thumb-"]');
            if (image) localStorage.setItem('bg_image',String(selectedBackgroundImage));
            if (button?.classList.contains('temp-btn')) localStorage.setItem('chat_temp',String(currentTemp));
            if (button?.classList.contains('layout-btn')) localStorage.setItem('layout_mode',currentLayoutMode);
            if (image || button?.closest('.settings-content-section:not(#section-api)')) window.electronAPI?.preferencesChanged();
        });
        const originalSave = window.saveSettings;
        window.saveSettings = function(...args) {
            localStorage.setItem('input_max_lines',String(Math.max(1,Math.min(30,Number($('input-max-lines').value) || 6))));
            localStorage.setItem('agent_native_notifications',String($('agent-native-notifications').checked));
            localStorage.setItem('enhanced_tool_parser',String($('enhanced-tool-parser').checked));
            const result = originalSave.apply(this,args); window.electronAPI?.preferencesChanged(); return result;
        };
        const reset = document.querySelector('button[onclick="resetModelListEditor()"]');
        const fetchModels = document.createElement('button'); fetchModels.type = 'button'; fetchModels.textContent = '获取可用模型'; fetchModels.className = reset.className; fetchModels.style.marginLeft = 'auto'; reset.before(fetchModels);
        const error = document.createElement('p'); error.className = 'text-xs text-red-500 mt-2'; error.hidden = true; $('model-list-input').after(error);
        fetchModels.onclick = async () => {
            fetchModels.disabled = true; fetchModels.textContent = '正在获取…'; error.hidden = true;
            const failures = [];
            try {
                const base = new URL($('base-url-input').value.trim());
                const key = $('api-key-input').value.trim();
                const root = base.href.replace(/\/(?:v1beta\/openai|v1|v1beta|api)\/?$/, '').replace(/\/$/, '');
                const candidates = [...new Set([`${base.href.replace(/\/$/,'')}/models`,`${root}/v1/models`,`${root}/models`,`${root}/api/tags`,`${root}/v1beta/models`])];
                for (const endpoint of candidates) {
                    try {
                        const response = await fetch(endpoint,{ headers:{ Authorization:`Bearer ${key}`,'x-api-key':key,'x-goog-api-key':key,'anthropic-version':'2023-06-01' },signal:AbortSignal.timeout(5000) });
                        if (!response.ok) { const detail = await response.json().catch(() => ({})); throw new Error(`${response.status} ${detail.error?.message || response.statusText}`); }
                        const data = await response.json(); const items = Array.isArray(data) ? data:data.data || data.models || data.result?.models;
                        const models = normalizeModelList((Array.isArray(items) ? items:[]).map(item => typeof item === 'string' ? item:item.id || item.name || item.model).filter(Boolean).map(name => name.replace(/^models\//,'')));
                        if (!models.length) throw new Error('模型列表为空或格式不支持');
                        $('model-list-input').value = models.join('\n'); markApiSettingsDirty(); return;
                    } catch (reason) { failures.push(`${new URL(endpoint).pathname}: ${reason.message}`); }
                }
                throw new Error(failures.join('；'));
            } catch (reason) { error.textContent = `后端服务器未返回模型列表：${reason.message}`; error.hidden = false; }
            finally { fetchModels.disabled = false; fetchModels.textContent = '获取可用模型'; }
        };
        if (preferences) {
            const close = async () => {
                if (apiSettingsDirty) { if (!confirm('API 配置已修改但尚未保存，是否保存更改？')) return; if (!saveSettings(true)) return; }
                await window.electronAPI?.closePreferences();
            };
            window.toggleSettings = close;
            window.electronAPI?.onPreferencesClose(close);
            setInterval(async () => {
                const state = await window.electronAPI?.getPreferencesState();
                if (!state) return;
                isGenerating = state.generating; contextCompactionRunning = state.compaction; window._audioChatRunning = state.audio; window._desktopWorkRunning = state.desktop;
                window.isAgentTaskRunning = () => state.agentRunning; updateSettingsLocks();
            },1200);
        } else {
            window.electronAPI?.onPreferencesChanged(refreshPreferences);
            window.addEventListener('storage',event => {
                if (!event.key || ['ai_chats','selected_model','model_reasoning_settings','model_list','api_key','base_url','max_tokens_limit','request_endpoint'].includes(event.key)) return;
                clearTimeout(preferencesRefreshTimer); preferencesRefreshTimer = setTimeout(refreshPreferences,80);
            });
            setInterval(() => { if (settingsPending && !isGenerating && !contextCompactionRunning && !window._audioChatRunning && !window._desktopWorkRunning) refreshPreferences(); },400);
        }
        new MutationObserver(appearance).observe(document.body,{ attributes:true,attributeFilter:['class','data-accent-color'] }); appearance();
    }
    window.AIUIEnhancements = {
        closeChoices,
        reasoningFor:model => { const cap = capabilities.get(model); return model === $('model-select').value ? reasoningValue : savedReasoning()[model] || cap.default; },
        modelRequest:() => { const chat = currentChat(); if (!chat) return; chat.modelRequestSteps = (chat.modelRequestSteps || 0)+1; chat.lastRequestFailed = false; renderMetrics(); },
        beginRequestTask:() => { freezeRuntimeAPI(); syncAppStateToMain(); },
        endRequestTask:() => { runtimeApi = null; syncAppStateToMain(); },
        taskStart:chat => { freezeRuntimeAPI(); chat._activeTaskStartIndex = chat.messages.length; chat.agentTaskMetrics = { input:0,cached:0,output:0,streamMs:0,hasUsage:false }; taskBase = { ...chat.agentTaskMetrics }; chat.lastRequestFailed = false; renderMetrics(); syncAppStateToMain(); },
        requestMetrics:(chat,state,done = false,fallback = 0) => {
            if (done) state.metricsDone = true;
            if (!done && (!state.hasOutputUsage || (state.reasoningText && !state.hasReasoningUsage)) && state.text && !state.counting && performance.now() - (state.countedAt || 0) > 250) {
                state.counting = true; state.countedAt = performance.now();
                window.electronAPI?.countContextTokens(state.text,chat.agentModel || getSelectedModelName()).then(count => {
                    state.localOutput = count;
                    if (!state.metricsDone) window.AIUIEnhancements.requestMetrics(chat,state);
                }).catch(() => {}).finally(() => { state.counting = false; });
            }
            const request = AIUIRequestMetrics.finish(state,fallback);
            if (chat.agentEnabled && chat.agentTaskMetrics) {
                if (!taskBase) taskBase = { ...chat.agentTaskMetrics };
                chat.agentTaskMetrics = { input:taskBase.input+request.input,cached:taskBase.cached+request.cached,output:taskBase.output+request.output,streamMs:taskBase.streamMs+request.streamMs,hasUsage:taskBase.hasUsage || request.hasUsage };
                if (done) taskBase = { ...chat.agentTaskMetrics };
            } else chat.lastRequestMetrics = request;
            renderMetrics();
        },
        taskEnd:chat => {
            const completed = !chat.messages.at(-1)?.failed && chat.messages.slice(chat._activeTaskStartIndex || 0).some(m => m.toolName === 'finish_task' && m.result?.success !== false && m.status === 'done' && !m._countedRound);
            if (completed) {
                chat.agentCompletedRounds = (chat.agentCompletedRounds || 0)+1;
                for (const message of chat.messages) if (message.toolName === 'finish_task') message._countedRound = true;
                if (localStorage.getItem('agent_native_notifications') !== 'false') window.electronAPI?.notifyAgent({ type:'completed',body:chat.title || '当前任务已完成' });
            }
            runtimeApi = null; taskBase = null; delete chat._activeTaskStartIndex; renderMetrics(); updateTokenEstimate(); renderSidebar(); syncAppStateToMain();
        },
        failed:chat => { chat.lastRequestFailed = true; renderMetrics(); },
        context:breakdown => { currentBreakdown = breakdown; renderSidebarContext(); responsiveMeter(); renderMetrics(); },
        requestContextRefresh:() => { updateTokenEstimate(); renderSidebar(); },
        changed:() => {
            renderMetrics(); renderSidebar(); syncModel();
            syncCommandMode();
        },
        notifyQuestion:text => { if (localStorage.getItem('agent_native_notifications') !== 'false') window.electronAPI?.notifyAgent({ type:'question',body:text }); },
        preferences
    };
    document.addEventListener('pointerdown',event => { if (![...choices].some(node => node.contains(event.target)) && !event.target.closest('.custom-select-trigger')) closeChoices(); });
    document.addEventListener('keydown',event => {
        if (event.key === 'Escape' && activePopover) { event.preventDefault(); event.stopImmediatePropagation(); closeChoices(true); }
        if (activePopover && ['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
            const buttons = [...activePopover.node.querySelectorAll('.choice-option')]; if (!buttons.length) return;
            event.preventDefault(); const index = buttons.indexOf(document.activeElement);
            buttons[event.key === 'Home' ? 0:event.key === 'End' ? buttons.length-1:(index+(event.key === 'ArrowDown' ? 1:-1)+buttons.length)%buttons.length].focus();
        }
    },true);
    window.addEventListener('resize',() => { renderSidebar(); if (activePopover) positionPopover(activePopover.node,activePopover.trigger); });
    const originalOnload = window.onload;
    window.onload = async event => {
        await originalOnload?.(event);
        initializeSelectors(); initializeSidebar(); initializeSettings();
        if (preferences) {
            const modal = $('settings-modal'); modal.classList.add('flex','modal-active');
            populateAutoSummarySettings(); populateModelListEditor(); populateVoiceChatSettings(); populateDesktopWorkSettings(); populateOtherSettings(); populateAdvancedSettings(); populateAgentSettings(); updateSettingsPortraitMode();
            const state = await window.electronAPI?.getPreferencesState();
            if (state) { isGenerating = state.generating; contextCompactionRunning = state.compaction; window._audioChatRunning = state.audio; window._desktopWorkRunning = state.desktop; window.isAgentTaskRunning = () => state.agentRunning; updateSettingsLocks(); }
        } else { renderSidebar(); autoResize($('user-input')); }
        lucide.createIcons();
    };
})();
