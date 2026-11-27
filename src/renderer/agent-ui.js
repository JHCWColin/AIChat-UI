(function () {
    const MAX_TOOL_CALLS_PER_RESPONSE = 30;
    const MAX_CONSECUTIVE_EMPTY_RESPONSES = 3;
    const MAX_CONSECUTIVE_INVALID_RESPONSES = 3;
    const MAX_BACKEND_RETRIES = 6;
    const BACKEND_RETRY_DELAY_MS = 5000;
    const BACKEND_IDLE_TIMEOUT_MS = 120000;
    const DEFAULT_AGENT_DIFF_MAX_LINES = 10;
    const DEFAULT_AGENT_SHELL_TIMEOUT_SECONDS = 120;
    const SHELL_OUTPUT_PAGE_SIZE = 8192;
    const SHELL_OUTPUT_TOOLS = new Set(["run_shell", "start_process", "read_process_output", "stop_process"]);
    const TOOL_ICONS = {
        ask_user_question: 'message-circle-question',
        read_file_range: "file-search",
        write_file: "file-plus-2",
        edit_file: "file-pen-line",
        multi_edit_file: "file-pen-line",
        run_shell: "terminal",
        start_process: "play",
        read_process_output: "activity",
        stop_process: "square",
        list_processes: "list",
        finish_task: "check-circle-2",
        agent_protocol: "shield-alert",
        list_dir: "folder-tree",
        glob_files: "file-stack",
        grep_files: "search",
        delete_path: "trash-2",
        move_path: "folder-symlink",
        copy_path: "copy",
        view_image: "image",
        update_plan: "list-checks",
        _claude_insert_text: "file-pen-line",
        _claude_undo_edit: "undo-2",
        _codex_apply_patch: "file-pen-line",
        web_search: "search",
        browse_web: "globe"
    };
    // Tools that only read state can run concurrently; anything that mutates the
    // workspace, the shell, or the UI must stay in strict sequential order.
    const READ_ONLY_TOOLS = new Set([
        "read_file_range",
        "list_dir",
        "glob_files",
        "grep_files",
        "view_image",
        "web_search",
        "browse_web",
        "read_process_output",
        "list_processes"
    ]);

    let agentTaskChatId = null;
    let agentTaskPreparing = false;
    let agentModelController = null;
    let agentLiveThinkingRow = null;
    let agentThinkingSequence = 0;
    let agentStopRequested = false;
    let agentApprovalResolver = null;
    let agentQuestionResolver = null;
    let agentApprovalRow = null;
    let agentWorkspaceTrustResolver = null;
    let agentYoloResolver = null;
    let agentCommandMode = "safe";
    let agentCommandModeChatId = null;
    let agentToolSequence = 0;
    let agentShellProgressUnsubscribe = null;
    let agentTaskStartedAt = 0;
    let agentTaskTimer = null;
    let agentTaskFooter = null;
    let liveActivityBlock = null;
    const queuedMessageRows = new Map();
    const liveToolBlocks = new Map();
    const activeToolMessages = new WeakSet();
    const agentShellProgressByExecution = new Map();
    const agentPlansByChat = new Map();
    const agentEditHistoryByFile = new Map();

    function currentAgentChat() {
        return activeChatId ? chats.find(chat => chat.id === activeChatId) : null;
    }

    function isAgentTaskRunning(chatId) {
        if (!agentTaskChatId) return false;
        return chatId === undefined ? true : String(chatId) === String(agentTaskChatId);
    }

    function getQueuedAgentMessages(chatId) {
        return window.queuedAgentMessages.filter(entry =>
            typeof entry === "string" || (entry && String(entry.chatId ?? entry.gatewayChatId) === String(chatId)));
    }

    function queueAgentMessage(chat, content, attachments = [], gateway = false) {
        window.queuedAgentMessages.push({ chatId: String(chat.id), content, attachments,
            ...(gateway ? { gatewayChatId: String(chat.id) } : {}) });
        placeAgentTaskFooter();
        scrollChatToBottom();
        if (getAgentMessageInsertion() === "interrupt") agentModelController?.abort();
    }

    function consumeAgentMessages(chat) {
        if (!window.queuedAgentMessages.length) return { count: 0, gatewayInput: false };
        const queued = getQueuedAgentMessages(chat.id);
        window.queuedAgentMessages.length = 0;
        placeAgentTaskFooter();
        let gatewayInput = false;
        for (const entry of queued) {
            const gateway = Boolean(entry.gatewayChatId);
            const message = { role: "user", content: entry.content ?? entry, agentQueued: true,
                ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
                ...(gateway ? { agentGatewaySource: true } : {}) };
            chat.messages.push(message);
            gatewayInput ||= gateway;
            appendMessageToUI("user", message.content, null, false, "", message.attachments || [], [], "", {
                voiceMessage: message,
                voiceMessageKey: window.getTextVoiceMessageKey?.(chat.id, chat.messages.length - 1)
            });
        }
        if (queued.length) {
            chat.updatedAt = Date.now();
            persistAgentChats();
        }
        return { count: queued.length, gatewayInput };
    }

    function persistAgentChats() {
        const serializable = chats.map(chat => {
            if (!chat?.agentEnabled || !Array.isArray(chat.messages)) return chat;
            return {
                ...chat,
                messages: chat.messages.map(message => {
                    if (message?.role !== "tool" || !message.contentRef || typeof message.content !== "string") return message;
                    if (!Object.prototype.propertyIsEnumerable.call(message, "content")) return message;
                    return { ...message, content: "" };
                })
            };
        });
        try {
            localStorage.setItem("ai_chats", JSON.stringify(serializable));
        } catch (error) {
            appendLog("error", `Agent 会话持久化失败：${error.message}`);
        }
    }

    const agentResultStore = {
        dbPromise: null,
        open() {
            if (this.dbPromise) return this.dbPromise;
            if (!window.indexedDB) return Promise.resolve(null);
            this.dbPromise = new Promise(resolve => {
                const request = indexedDB.open("AIChatAgentTools", 1);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains("results")) db.createObjectStore("results", { keyPath: "id" });
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => resolve(null);
            });
            return this.dbPromise;
        },
        async put(id, content) {
            const db = await this.open();
            if (!db) return false;
            return new Promise(resolve => {
                const tx = db.transaction("results", "readwrite");
                tx.objectStore("results").put({ id, content });
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
            });
        },
        async get(id) {
            const db = await this.open();
            if (!db) return "";
            return new Promise(resolve => {
                const request = db.transaction("results", "readonly").objectStore("results").get(id);
                request.onsuccess = () => resolve(String(request.result?.content || ""));
                request.onerror = () => resolve("");
            });
        }
    };

    async function hydrateAgentToolResults() {
        for (const chat of chats) {
            if (!chat?.agentEnabled) continue;
            // Plans are per-chat state, not message state; restore them along with the
            // persisted tool results so a reopened session keeps its task list.
            if (chat.agentPlan && Array.isArray(chat.agentPlan.steps)) {
                agentPlansByChat.set(chat.id, chat.agentPlan);
            }
            if (!Array.isArray(chat.messages)) continue;
            for (const message of chat.messages) {
                if (message?.role !== "tool" || !message.contentRef || message.content) continue;
                const content = await agentResultStore.get(message.contentRef);
                Object.defineProperty(message, "content", { value: content, writable: true, configurable: true, enumerable: false });
            }
        }
    }

    async function persistAgentToolMessage(chat, message) {
        if (!message || message.role !== "tool") return;
        if (!message.toolId) message.toolId = `${chat.id}-${Date.now()}-${agentToolSequence += 1}`;
        if (typeof message.content === "string") {
            message.contentRef = message.contentRef || `agent-result-${chat.id}-${message.toolId}`;
            const content = message.content;
            if (await agentResultStore.put(message.contentRef, content)) {
                Object.defineProperty(message, "content", { value: content, writable: true, configurable: true, enumerable: false });
            }
        }
        chat.updatedAt = Date.now();
        persistAgentChats();
    }

    function setActiveChatTitle(chat) {
        const title = document.getElementById("active-chat-title");
        const workspace = document.getElementById("active-chat-workspace");
        if (title) title.textContent = String(chat?.title || "新对话");
        if (workspace) {
            const value = chat?.agentEnabled ? String(chat.agentWorkspace || "工作区不可用") : "";
            workspace.textContent = value;
            workspace.title = value;
            workspace.classList.toggle("visible", Boolean(chat?.agentEnabled));
        }
    }

    function updateAgentUIForChat(chat) {
        setActiveChatTitle(chat);
        const modeChatId = chat?.agentEnabled ? chat.id : null;
        if (modeChatId !== agentCommandModeChatId || agentCommandMode === "yolo") agentCommandMode = "safe";
        agentCommandModeChatId = modeChatId;
        const modeBar = document.getElementById("agent-command-mode-bar");
        const modeSelect = document.getElementById("agent-command-mode-select");
        if (modeSelect) modeSelect.value = agentCommandMode;
        if (modeBar) modeBar.classList.toggle("visible", Boolean(chat?.agentEnabled));
        document.body.classList.toggle("agent-mode", Boolean(chat?.agentEnabled));
        const title = document.getElementById("active-chat-title");
        if (title) title.classList.toggle("text-emerald-400", Boolean(chat?.agentEnabled));
        const canvasToggle = document.getElementById("canvas-toggle-btn");
        if (canvasToggle) {
            canvasToggle.style.removeProperty("display");
            canvasToggle.classList.toggle("visible", Boolean(chat?.canvasEnabled && !chat?.agentEnabled));
        }
        const input = document.getElementById("user-input");
        if (input) input.placeholder = chat?.agentEnabled ? "描述任务，或输入 / 使用命令" : "发送消息，或输入 / 使用命令";
        updateAttachMenuButtons();
        if (typeof updateTokenEstimate === 'function') updateTokenEstimate();
        if (chat?.agentEnabled) refreshAgentWorkspace(chat).then(() => {
            if (currentAgentChat() === chat && typeof updateTokenEstimate === 'function') updateTokenEstimate();
        }).catch(() => {});
        window.AIUIEnhancements?.changed();
    }

    async function enterAgentMode() {
        if (!window.electronAPI?.isElectron) {
            showVoiceNotification("Agent 模式只支持 Electron 桌面端", true, 3000);
            return;
        }
        if (isGenerating || isAgentTaskRunning()) {
            showVoiceNotification("请先停止当前回复，再进入 Agent 模式", true, 3000);
            return;
        }
        const chat = currentAgentChat();
        if (!chat) return;
        if (chat.agentEnabled) {
            showVoiceNotification("当前会话已经是 Agent，会话模式不可退出", true, 3000);
            return;
        }
        if (chat.canvasEnabled) {
            showVoiceNotification("已启用 Canvas 的会话不能进入 Agent 模式", true, 3500);
            return;
        }
        if (isImageMode) {
            showVoiceNotification("当前处于图像生成或编辑状态，不能进入 Agent 模式", true, 3500);
            return;
        }
        try {
            const selection = await window.electronAPI.selectAgentWorkspace(chat.id);
            if (!selection || selection.canceled) return;
            if (!selection.path || selection.exists === false) throw new Error("工作区不可用");
            let binding = selection;
            if (selection.requiresConfirmation) {
                const trusted = await requestAgentWorkspaceTrust(selection);
                if (!trusted) return;
                if (!window.electronAPI?.confirmAgentWorkspace) throw new Error("当前版本不支持确认 Agent 工作区");
                binding = await window.electronAPI.confirmAgentWorkspace(chat.id, selection.path, selection.selectionId);
            }
            if (!binding.path || binding.exists === false) throw new Error("工作区不可用");
            chat.agentEnabled = true;
            chat.agentWorkspace = binding.path;
            chat.agentEnvironment = binding.environment || "";
            chat.agentSystemPrompt = systemPrompt || "";
            chat.agentSessionStartedAt = Date.now();
            chat.agentAutoCompactionPromptShown = false;
            chat.agentFixedPrompt = AgentProtocol.buildFixedAgentPrompt({
                systemPrompt: chat.agentSystemPrompt,
                environment: [
                    chat.agentEnvironment,
                    `Session started: ${AgentProtocol.formatCurrentTime(new Date(chat.agentSessionStartedAt))}`
                ].filter(Boolean).join("\n")
            });
            chat.agentWorkspaceAvailable = true;
            chat.updatedAt = Date.now();
            persistAgentChats();
            renderChatHistory();
            updateAgentUIForChat(chat);
            showVoiceNotification("已进入 Agent 模式，当前会话不可退出", false, 3000);
        } catch (error) {
            showVoiceNotification(`Agent 工作区绑定失败：${error.message}`, true, 5000);
        }
    }

    async function refreshAgentWorkspace(chat) {
        if (!chat?.agentEnabled || !window.electronAPI?.getAgentWorkspace) return true;
        try {
            const binding = await window.electronAPI.getAgentWorkspace(chat.id);
            chat.agentWorkspaceAvailable = Boolean(binding?.exists);
            if (binding?.path) chat.agentWorkspace = binding.path;
            if (!chat.agentEnvironment && binding?.environment) chat.agentEnvironment = binding.environment;
            if (!chat.agentFixedPrompt && chat.agentEnvironment) {
                chat.agentSessionStartedAt = chat.agentSessionStartedAt || Date.now();
                chat.agentFixedPrompt = AgentProtocol.buildFixedAgentPrompt({
                    systemPrompt: chat.agentSystemPrompt || systemPrompt,
                    environment: [
                        chat.agentEnvironment,
                        `Session started: ${AgentProtocol.formatCurrentTime(new Date(chat.agentSessionStartedAt))}`
                    ].filter(Boolean).join("\n")
                });
            }
            setActiveChatTitle(chat);
            if (!binding?.exists) showVoiceNotification("Agent 工作区不可用，已禁止继续执行工具", true, 5000);
            return Boolean(binding?.exists);
        } catch (error) {
            chat.agentWorkspaceAvailable = false;
            showVoiceNotification(`Agent 工作区检查失败：${error.message}`, true, 5000);
            return false;
        }
    }

    function resolveAgentWorkspaceTrust(confirmed) {
        const modal = document.getElementById("agent-workspace-trust-modal");
        if (modal) closeAnimatedModal(modal, "visible");
        const resolver = agentWorkspaceTrustResolver;
        agentWorkspaceTrustResolver = null;
        if (resolver) resolver(Boolean(confirmed));
    }

    function requestAgentWorkspaceTrust(selection) {
        const modal = document.getElementById("agent-workspace-trust-modal");
        if (!modal) return Promise.resolve(false);
        if (agentWorkspaceTrustResolver) resolveAgentWorkspaceTrust(false);

        const workspacePath = String(selection?.path || "");
        const pathElement = document.getElementById("agent-workspace-trust-path");
        if (pathElement) {
            pathElement.textContent = `工作区：${workspacePath}`;
            pathElement.title = workspacePath;
        }

        const fileList = document.getElementById("agent-workspace-trust-files");
        if (fileList) {
            fileList.replaceChildren();
            const item = document.createElement("li");
            item.textContent = "工作区中的文档可能包含影响 Agent 行为的指令，请仅信任你了解的目录。";
            fileList.appendChild(item);
        }

        openAnimatedModal(modal, "visible");
        return new Promise(resolve => {
            agentWorkspaceTrustResolver = resolve;
        });
    }

    function resolveAgentYoloWarning(confirmed) {
        const modal = document.getElementById("agent-yolo-warning-modal");
        if (modal) closeAnimatedModal(modal, "visible");
        const resolver = agentYoloResolver;
        agentYoloResolver = null;
        if (resolver) resolver(Boolean(confirmed));
    }

    function requestAgentYoloWarning() {
        const modal = document.getElementById("agent-yolo-warning-modal");
        if (!modal) return Promise.resolve(false);
        openAnimatedModal(modal, "visible");
        return new Promise(resolve => {
            agentYoloResolver = resolve;
        });
    }

    async function onAgentCommandModeChange(value) {
        const select = document.getElementById("agent-command-mode-select");
        if (value === "yolo") {
            if (agentCommandMode !== "yolo" && await requestAgentYoloWarning()) agentCommandMode = "yolo";
        } else {
            agentCommandMode = value === "ask" ? "ask" : "safe";
        }
        if (select) select.value = agentCommandMode;
        window.AIUIEnhancements?.changed();
    }

    function resolveAgentCommandApproval(decision) {
        const row = agentApprovalRow;
        agentApprovalRow = null;
        if (row) {
            row.inert = true;
            row.classList.add("leaving");
            setTimeout(() => row.remove(), 160);
        }
        const resolver = agentApprovalResolver;
        agentApprovalResolver = null;
        if (resolver) resolver(decision);
    }

    function requestAgentCommandApproval(command, message, alwaysAsk) {
        const title = "允许 Agent 运行这条命令吗？";
        const reason = alwaysAsk ? "当前模式要求逐条审批命令。" : "此命令不在允许列表中。";
        window.AIUIEnhancements?.notifyQuestion(title);
        const wrapper = document.getElementById("messages-wrapper");
        if (!wrapper) return Promise.resolve("reject");
        const row = document.createElement("div");
        row.className = "chat-row agent-command-approval-row";
        const allowAlways = alwaysAsk ? "" : '<button type="button" data-decision="always">始终允许</button>';
        row.innerHTML = `
            <section class="detail-surface agent-interaction-card agent-command-approval-tool" tabindex="-1">
                <h4 class="agent-card-heading"></h4>
                <div class="agent-command-body">
                    <p class="agent-command-description"></p>
                    <p class="agent-command-reason"></p>
                    <pre class="agent-command-code"><code></code></pre>
                </div>
                <div class="agent-card-actions agent-command-actions">
                    <button type="button" data-decision="reject">拒绝</button>
                    ${allowAlways}
                    <button type="button" class="agent-card-primary" data-decision="allow">允许一次</button>
                </div>
            </section>`;
        const card = row.firstElementChild;
        const heading = card.querySelector(".agent-card-heading");
        heading.id = `agent-approval-${message.toolId}`;
        heading.textContent = title;
        card.setAttribute("aria-labelledby", heading.id);
        const description = toolArguments(message).description;
        card.querySelector(".agent-command-description").textContent = typeof description === "string" ? description.trim() : "";
        card.querySelector(".agent-command-reason").textContent = reason;
        const commandEl = card.querySelector("code");
        commandEl.textContent = command;
        const highlight = window.hljs;
        if (highlight) {
            const languages = ["powershell", "bash"].filter(language => highlight.getLanguage(language));
            commandEl.innerHTML = highlight.highlightAuto(command, languages).value;
        }
        for (const button of card.querySelectorAll("[data-decision]")) {
            button.onclick = () => {
                if (agentApprovalRow === row) resolveAgentCommandApproval(button.dataset.decision);
            };
        }
        bindAgentCardSubmitShortcut(card, card.querySelector('[data-decision="allow"]'));
        agentApprovalRow = row;
        const block = liveToolBlocks.get(message);
        if (block?.isConnected) block.after(row);
        else wrapper.appendChild(row);
        placeAgentTaskFooter();
        revealAgentCard(card, card);
        return new Promise(resolve => {
            agentApprovalResolver = resolve;
        });
    }

    function bindAgentCardSubmitShortcut(card, button) {
        const modifier = /Mac/i.test(navigator.platform) ? "Meta" : "Control";
        button.setAttribute("aria-keyshortcuts", `${modifier}+Enter`);
        const hint = document.createElement("kbd");
        hint.setAttribute("aria-hidden", "true");
        hint.textContent = modifier === "Meta" ? "⌘ ↵" : "Ctrl ↵";
        button.append(hint);
        card.addEventListener("keydown", event => {
            if (event.defaultPrevented || event.isComposing || event.repeat || event.key !== "Enter" ||
                (modifier === "Meta" ? !event.metaKey : !event.ctrlKey) || event.altKey || event.shiftKey) return;
            event.preventDefault();
            button.click();
        });
    }

    function revealAgentCard(card, focusTarget) {
        focusTarget?.focus({ preventScroll: true });
        const wrapper = document.getElementById("messages-wrapper");
        card.scrollIntoView({ block: card.offsetHeight > wrapper.clientHeight ? "start" : "nearest", behavior: "instant" });
    }

    function formatAgentWorkingTime(milliseconds) {
        const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
        const duration = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
        return `Worked for ${duration}`;
    }

    function currentAgentTaskDuration() {
        return agentTaskStartedAt ? Date.now() - agentTaskStartedAt : 0;
    }

    function updateAgentTaskTimer() {
        const elapsed = agentTaskFooter?.querySelector(".response-worked-duration");
        if (!elapsed) return;
        const text = formatAgentWorkingTime(currentAgentTaskDuration());
        if (elapsed.textContent !== text) elapsed.textContent = text;
    }

    function placeAgentTaskFooter() {
        const wrapper = document.getElementById("messages-wrapper");
        if (!wrapper) return;
        const pending = getQueuedAgentMessages(activeChatId);
        for (const [entry, row] of queuedMessageRows) {
            if (pending.includes(entry)) continue;
            row.remove();
            queuedMessageRows.delete(entry);
        }
        const footer = String(agentTaskChatId) === String(activeChatId) ? agentTaskFooter : null;
        if (footer && wrapper.lastElementChild !== footer) wrapper.append(footer);
        let next = footer;
        for (const entry of pending.slice().reverse()) {
            let row = queuedMessageRows.get(entry);
            if (!row?.isConnected) {
                row = appendMessageToUI("user", entry.content ?? entry, null, false, "", entry.attachments || [], [], "", { container: wrapper });
                queuedMessageRows.set(entry, row);
            }
            if (row.nextElementSibling !== next) wrapper.insertBefore(row, next);
            next = row;
        }
    }

    function createAgentTaskFooter() {
        const row = document.createElement("div");
        row.className = "chat-row agent-task-duration-row";
        row.innerHTML = '<div class="message-footer"><span class="response-worked-duration"></span></div>';
        return row;
    }

    function appendAgentTaskDuration(container, durationMs) {
        const row = createAgentTaskFooter();
        row.querySelector(".response-worked-duration").textContent = formatAgentWorkingTime(durationMs);
        container.append(row);
    }

    function startAgentTaskTimer() {
        if (agentTaskTimer) clearInterval(agentTaskTimer);
        agentTaskStartedAt = Date.now();
        agentTaskFooter = createAgentTaskFooter();
        updateAgentTaskTimer();
        placeAgentTaskFooter();
        agentTaskTimer = setInterval(updateAgentTaskTimer, 1000);
    }

    function finishAgentTaskTimer(chat, targetMessage = null) {
        const durationMs = currentAgentTaskDuration();
        if (agentTaskTimer) clearInterval(agentTaskTimer);
        updateAgentTaskTimer();
        agentTaskTimer = null;
        agentTaskStartedAt = 0;
        const persistedTarget = targetMessage || chat?.messages.findLast(message => !message.hidden);
        if (persistedTarget && persistedTarget.role !== "user") persistedTarget.taskDurationMs = durationMs;
        agentTaskFooter = null;
        return durationMs;
    }

    function appendAgentThinkingRow(text = "Thinking", options = {}) {
        const wrapper = options.container || document.getElementById("messages-wrapper");
        const row = document.createElement("div");
        row.className = "chat-row agent-tool-row-wrapper agent-thinking-row";
        const running = options.running !== false;
        const grouped = options.grouped || running && options.activate !== false || Boolean(options.container?.closest?.(".agent-round-detail"));
        row.innerHTML = `<div class="agent-tool-row${running ? " running" : ""}"><div class="agent-tool-summary"><i data-lucide="bot"></i><span class="agent-tool-summary-text">${escapeHtml(text)}</span><i class="agent-tool-toggle" data-lucide="chevron-down"></i></div><div class="agent-tool-preview"><div class="agent-tool-preview-content"><div class="thinking-text"></div></div></div></div>`;
        const toolRow = row.querySelector(".agent-tool-row");
        const summary = row.querySelector(".agent-tool-summary");
        const thinkingText = row.querySelector(".thinking-text");
        row.thinkingStartedAt = Number(options.startedAt || Date.now());
        row.gatewayThinkingId = options.gatewayThinkingId || `${agentTaskChatId || activeChatId}:thinking:${row.thinkingStartedAt}:${agentThinkingSequence += 1}`;
        row.reasoningText = "";
        if (running && options.activate !== false) agentLiveThinkingRow = row;
        row.updateReasoning = reasoning => {
            const hasReasoning = Boolean(String(reasoning || ""));
            row.reasoningText = String(reasoning || "");
            renderThinkingText(thinkingText, reasoning);
            toolRow.classList.toggle("has-preview", hasReasoning);
            summary.classList.toggle("clickable", hasReasoning);
            summary.tabIndex = hasReasoning ? 0 : -1;
            summary.setAttribute("role", hasReasoning ? "button" : "presentation");
            const toggle = summary.querySelector(".agent-tool-toggle");
            if (toggle) toggle.style.display = hasReasoning ? "block" : "none";
            if (hasReasoning && !row.dataset.detailInitialized) {
                toolRow.classList.toggle("collapsed", grouped || getAgentDetailDefaultBehavior() === "collapsed");
                row.dataset.detailInitialized = "true";
            }
            summary.setAttribute("aria-expanded", String(hasReasoning && !toolRow.classList.contains("collapsed")));
            const detail = row.parentElement?.closest(".agent-round-detail");
            if (running && row.isConnected && detail && !detail.inert && !toolRow.classList.contains("collapsed")) {
                scrollChatToBottom();
            }
        };
        row.finishThinking = durationMs => {
            if (agentLiveThinkingRow === row) agentLiveThinkingRow = null;
            if (!row.reasoningText) {
                row.remove();
                return false;
            }
            const seconds = Math.max(0, Math.round(Number(durationMs || 0) / 1000));
            toolRow.classList.remove("running");
            row.querySelector(".agent-tool-summary-text").textContent = durationMs > 0 ? `Thought for ${seconds}s` : "Thought";
            return true;
        };
        const toggleReasoning = () => {
            if (!toolRow.classList.contains("has-preview")) return;
            const collapsed = toolRow.classList.toggle("collapsed");
            summary.setAttribute("aria-expanded", String(!collapsed));
            lucide.createIcons();
        };
        summary.onclick = toggleReasoning;
        summary.onkeydown = event => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggleReasoning();
            }
        };
        if (running && options.activate !== false) {
            const message = { agentThinking: true, status: "running", gatewayThinkingId: row.gatewayThinkingId };
            const block = appendLiveAgentActivity(message, row);
            const finishThinking = row.finishThinking;
            row.finishThinking = durationMs => {
                const hasReasoning = finishThinking(durationMs);
                message.status = "done";
                message.reasoning = row.reasoningText;
                if (!hasReasoning) {
                    block._agentRoundMessages.splice(block._agentRoundMessages.indexOf(message), 1);
                }
                refreshAgentRoundSummary(block);
                return hasReasoning;
            };
        } else {
            wrapper.appendChild(row);
        }
        if (options.reasoning) row.updateReasoning(options.reasoning);
        if (!running) row.finishThinking(options.durationMs);
        lucide.createIcons();
        return row;
    }

    function appendAgentThinkingMessageToUI(message, options = {}) {
        if (!message?.reasoning) return null;
        return appendAgentThinkingRow("", { running: false, activate: false, reasoning: message.reasoning, durationMs: message.thinkingDurationMs, gatewayThinkingId: message.gatewayThinkingId, container: options.container });
    }

    function appendAgentEndpointFallbackRow(info) {
        const wrapper = document.getElementById("messages-wrapper");
        if (!wrapper) return null;
        const row = document.createElement("div");
        row.className = "chat-row agent-tool-row-wrapper agent-endpoint-fallback-row";
        row.innerHTML = `<div class="agent-tool-row warning running"><div class="agent-tool-summary"><i data-lucide="route"></i><span class="agent-tool-summary-text">接口返回 501，正在转接至 ${escapeHtml(info?.to || "备用接口")}</span></div></div>`;
        wrapper.appendChild(row);
        lucide.createIcons();
        placeAgentTaskFooter();
        scrollChatToBottom();
        return row;
    }

    function completeAgentEndpointFallbackRow(row, endpoint) {
        if (!row) return;
        row.querySelector(".agent-tool-row")?.classList.remove("running");
        const summary = row.querySelector(".agent-tool-summary-text");
        if (summary) summary.textContent = `已转接至 ${endpoint}`;
    }

    function toolArguments(message) {
        return message?.arguments && typeof message.arguments === "object" ? message.arguments : {};
    }

    function getAgentDiffMaxLines() {
        const value = Number(localStorage.getItem("agent_diff_max_lines"));
        return [10, 20, 50, 0].includes(value) ? value : DEFAULT_AGENT_DIFF_MAX_LINES;
    }

    function getAgentShellTimeoutMs() {
        const value = Number(localStorage.getItem("agent_shell_timeout_seconds"));
        const seconds = Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 5), 3600) : DEFAULT_AGENT_SHELL_TIMEOUT_SECONDS;
        return seconds * 1000;
    }

    function getAgentSearchEngine() {
        return localStorage.getItem("agent_search_engine") === "duckduckgo" ? "duckduckgo" : "bing";
    }

    function getAgentMessageInsertion() {
        return localStorage.getItem("agent_message_insertion") === "interrupt" ? "interrupt" : "queue";
    }

    /**
     * Compacts the Agent's history when the estimated context approaches the model's
     * window, the way Claude Code does, instead of waiting for a fixed turn count.
     * Agent internal loop calls are not counted as user turns, so the summary always
     * lands on a completed task boundary.
     */
    async function compactAgentContextIfNeeded(chat) {
        if (!chat?.agentEnabled) return false;
        if (typeof estimateTotalTokens !== "function") return false;
        if (typeof getContextWindowForModel !== "function") return false;
        if (typeof performAutomaticCompaction !== "function") return false;
        // A turn-count interval still wins when the user configured one explicitly.
        if (typeof autoSummaryInterval !== "undefined" && autoSummaryInterval !== 0) return false;
        const windowSize = getContextWindowForModel(chat.agentModel || getSelectedModelName());
        if (!(windowSize > 0)) return false;
        const threshold = typeof AGENT_COMPACTION_THRESHOLD === "number" ? AGENT_COMPACTION_THRESHOLD : 0.92;
        const estimated = estimateTotalTokens();
        if (!(estimated > 0) || estimated < windowSize * threshold) return false;
        const percent = Math.round((estimated / windowSize) * 100);
        appendLog("info", `Agent 上下文达到 ${percent}%（${estimated}/${windowSize}），开始自动压缩`);
        showVoiceNotification(`上下文已用 ${percent}%，正在自动压缩以继续任务`, false, 0, true);
        try {
            await performAutomaticCompaction(chat);
            if (typeof updateTokenEstimate === "function") updateTokenEstimate();
            return true;
        } catch (error) {
            appendLog("error", `Agent 阈值压缩失败：${error.message}`);
            return false;
        }
    }

    function splitAgentDisplayLines(content) {
        const text = String(content || "");
        if (!text) return [];
        const lines = text.split(/\r\n|\n|\r/);
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        return lines;
    }

    function truncateAgentDisplayLines(lines) {
        const limit = getAgentDiffMaxLines();
        if (limit === 0 || lines.length <= limit) return lines;
        const headCount = Math.ceil(limit / 2);
        const tailCount = Math.floor(limit / 2);
        const omittedCount = lines.length - headCount - tailCount;
        return [
            ...lines.slice(0, headCount),
            { type: "omitted", text: `……（省略${omittedCount}行）` },
            ...lines.slice(lines.length - tailCount)
        ];
    }

    function getAgentPreviewLines(message) {
        if (!message?.result || message.status === "running") return [];
        if (window.AgentActivity.WRITE_TOOLS.has(message.toolName)) {
            const diff = message.displayDiff || message.result.displayDiff;
            return Array.isArray(diff?.lines) ? diff.lines : [];
        }
        if (message.toolName === "read_file_range" && message.result.success) {
            return splitAgentDisplayLines(message.result.content).map(text => ({ type: "output", text }));
        }
        if (message.toolName === "list_dir" && message.result?.success) {
            const entries = Array.isArray(message.result.entries) ? message.result.entries : [];
            const lines = entries.map(entry => ({
                type: entry.type === "directory" ? "error" : "output",
                text: `${entry.type === "directory" ? "[DIR] " : "[FILE]"}${entry.path || entry.name}${entry.type === "file" && entry.size ? ` (${entry.size} bytes)` : ""}`
            }));
            if (message.result.hasMore) lines.push({ type: "output", text: `……还有 ${message.result.totalCount - (message.result.offset + entries.length)} 项` });
            return lines;
        }
        if (message.toolName === "grep_files" && message.result?.success) {
            const matches = Array.isArray(message.result.matches) ? message.result.matches : [];
            const lines = matches.map(match => ({
                type: "output",
                text: `${match.path}:${match.line}: ${String(match.content || "").slice(0, 200)}`
            }));
            if (message.result.truncated) lines.push({ type: "output", text: "……结果已截断" });
            return lines;
        }
        if (message.toolName === "view_image" && message.result?.success) {
            const r = message.result;
            return [
                { type: "output", text: `路径: ${r.path || ""}` },
                { type: "output", text: `类型: ${r.mimeType || ""}` },
                { type: "output", text: `大小: ${r.fileSize ? `${(r.fileSize / 1024).toFixed(1)} KB` : "unknown"}` },
                ...(r.note ? [{ type: "error", text: r.note }] : [])
            ];
        }
        if (message.toolName === "update_plan" && message.result?.success) {
            const steps = Array.isArray(message.result.plan) ? message.result.plan : [];
            const lines = [];
            if (message.result.explanation) lines.push({ type: "output", text: message.result.explanation });
            steps.forEach((step, index) => {
                const marker = step.status === "completed" ? "[x]" : step.status === "in_progress" ? "[>]" : "[ ]";
                lines.push({ type: step.status === "in_progress" ? "error" : "output", text: `${marker} ${index + 1}. ${step.step}` });
            });
            return lines;
        }
        if (message.toolName === "glob_files" && message.result?.success) {
            const items = Array.isArray(message.result.matches) ? message.result.matches : [];
            const lines = items.map(item => ({
                type: "output",
                text: `${item.path}${item.size ? ` (${item.size} bytes)` : ""}`
            }));
            if (message.result.truncated) lines.push({ type: "output", text: "……结果已截断" });
            return lines;
        }
        if (message.toolName === "web_search" && message.result?.success) {
            const items = Array.isArray(message.result.results) ? message.result.results : [];
            return items.map(item => ({
                type: "output",
                text: `${item.title}\n${item.url}${item.snippet ? `\n${item.snippet}` : ""}`
            }));
        }
        if (message.toolName === "browse_web" && message.result?.success) {
            return splitAgentDisplayLines(message.result.text).map(text => ({ type: "output", text }));
        }
        if (message.toolName === "list_processes" && message.result?.success) {
            const items = Array.isArray(message.result.processes) ? message.result.processes : [];
            return items.map(item => ({
                type: item.running ? "error" : "output",
                text: `${item.processId} ${item.running ? "[running]" : `[exit ${item.exitCode ?? "?"}]`} ${item.command}`
            }));
        }
        if ((message.toolName === "delete_path" || message.toolName === "move_path" || message.toolName === "copy_path") && message.result && !message.result.success) {
            return message.result.hint ? [{ type: "error", text: message.result.hint }] : [];
        }
        return [];
    }

    function toggleAgentToolPreview(row) {
        const toolRow = row?.querySelector(".agent-tool-row");
        const summary = row?.querySelector(".agent-tool-summary");
        if (!toolRow?.classList.contains("has-preview")) return;
        const collapsed = toolRow.classList.toggle("collapsed");
        summary?.setAttribute("aria-expanded", String(!collapsed));
        lucide.createIcons();
    }

    function appendAgentFullOutput(toolRow, container, fullWasOpen, title, buildOutput) {
        const full = document.createElement("details");
        full.className = "agent-full-output";
        const label = document.createElement("summary");
        full.append(label);
        function updateFullOutput() {
            toolRow.classList.toggle("show-full-output", full.open);
            label.textContent = full.open ? "Show preview" : title;
            if (full.open && full.children.length === 1) full.append(buildOutput());
        }
        full.addEventListener("toggle", updateFullOutput);
        full.open = Boolean(fullWasOpen);
        container.append(full);
        updateFullOutput();
    }

    function renderAgentShellOutput(toolRow, container, result, fullWasOpen) {
        const stdout = String(result.stdout || "");
        const stderr = String(result.stderr || "");
        if (!stdout && !stderr) return false;

        // Keep CRLF and surrogate pairs together when a page ends through one.
        const boundary = (text, index) => {
            if (index <= 0 || index >= text.length) return Math.max(index, 0);
            const code = text.charCodeAt(index);
            return (code >= 0xDC00 && code <= 0xDFFF) || (code === 10 && text.charCodeAt(index - 1) === 13)
                ? index + 1 : index;
        };
        const pageItems = page => {
            const start = page * SHELL_OUTPUT_PAGE_SIZE;
            const end = start + SHELL_OUTPUT_PAGE_SIZE;
            return [
                { type: "output", text: stdout.slice(boundary(stdout, start), boundary(stdout, end)) },
                { type: "error", text: stderr.slice(boundary(stderr, start - stdout.length), boundary(stderr, end - stdout.length)) }
            ].filter(item => item.text);
        };
        const makeOutput = items => {
            const output = document.createElement("div");
            output.className = "agent-preview-output agent-shell-output";
            let previous;
            for (const { type, text } of items) {
                if (previous && previous.classList.contains(type)) {
                    previous.textContent += "\n" + text;
                } else {
                    previous = document.createElement("div");
                    previous.className = `agent-tool-preview-line ${type}`;
                    previous.textContent = text;
                    output.append(previous);
                }
            }
            return output;
        };
        const firstPage = pageItems(0);
        let pageCount = Math.ceil((stdout.length + stderr.length) / SHELL_OUTPUT_PAGE_SIZE);
        if (pageCount > 1 && !pageItems(pageCount - 1).length) pageCount--;
        const lines = getAgentDiffMaxLines() ? firstPage.flatMap(({ type, text }) =>
            splitAgentDisplayLines(text).map(text => ({ type, text }))) : null;
        const preview = lines ? truncateAgentDisplayLines(lines) : firstPage;
        container.append(makeOutput(preview === lines ? firstPage : preview));
        if (pageCount === 1 && (!lines || preview === lines)) return true;

        const title = pageCount === 1 ? `Show all ${lines.length} lines` : "Show all output";
        appendAgentFullOutput(toolRow, container, fullWasOpen, title, () => {
            if (pageCount === 1) return makeOutput(firstPage);
            const body = document.createElement("div");
            const navigation = document.createElement("div");
            navigation.className = "agent-shell-output-pages";
            const previous = document.createElement("button");
            const next = document.createElement("button");
            for (const button of [previous, next]) button.type = "button";
            previous.textContent = "上一页";
            next.textContent = "下一页";
            const label = document.createElement("span");
            label.setAttribute("aria-live", "polite");
            navigation.append(previous, label, next);
            let output = document.createElement("div");
            body.append(output, navigation);
            let page = 0;
            function showPage() {
                const updated = makeOutput(pageItems(page));
                output.replaceWith(updated);
                output = updated;
                label.textContent = `${page + 1} / ${pageCount}`;
                previous.disabled = page === 0;
                next.disabled = page === pageCount - 1;
            }
            previous.addEventListener("click", () => { page--; showPage(); });
            next.addEventListener("click", () => { page++; showPage(); });
            showPage();
            return body;
        });
        return true;
    }

    function renderAgentToolPreview(row, message) {
        const toolRow = row?.querySelector(".agent-tool-row");
        const summary = row?.querySelector(".agent-tool-summary");
        const previewContent = row?.querySelector(".agent-tool-preview-content");
        if (!toolRow || !summary || !previewContent) return;
        const lines = getAgentPreviewLines(message);
        const hadPreview = toolRow.classList.contains("has-preview");
        const wasCollapsed = toolRow.classList.contains("collapsed");
        const fullWasOpen = previewContent.querySelector(".agent-full-output")?.open;
        previewContent.replaceChildren();
        toolRow.classList.remove("show-full-output");
        const command = ["run_shell", "start_process"].includes(message.toolName) && toolArguments(message).command;
        if (command) {
            const code = document.createElement("pre");
            code.className = "agent-command-preview";
            code.textContent = "$ " + command;
            previewContent.append(code);
        }
        const image = message.toolName === "view_image" && message.result?.success && message.result.dataUrl;
        if (image) {
            const img = document.createElement("img");
            img.className = "agent-tool-preview-image";
            img.src = image;
            img.alt = message.result.path || "image";
            previewContent.append(img);
        }
        function makeOutput(items) {
            const output = document.createElement("div");
            output.className = "agent-preview-output";
            for (const line of items) {
                const element = document.createElement("div");
                element.className = `agent-tool-preview-line ${line.type || "output"}`;
                element.textContent = line.text ?? "";
                output.append(element);
            }
            return output;
        }
        if (lines.length) {
            const preview = truncateAgentDisplayLines(lines);
            previewContent.append(makeOutput(preview));
            if (preview !== lines) {
                appendAgentFullOutput(toolRow, previewContent, fullWasOpen, `Show all ${lines.length} lines`, () => makeOutput(lines));
            }
        }
        const shellOutput = SHELL_OUTPUT_TOOLS.has(message.toolName) && message.result && message.status !== "running" &&
            renderAgentShellOutput(toolRow, previewContent, message.result, fullWasOpen);
        const detail = formatAgentToolDetail(message);
        if (detail || (message.toolName === "run_shell" && message.status === "running")) {
            const info = document.createElement("div");
            info.className = "agent-preview-meta";
            info.textContent = detail;
            info.hidden = !detail;
            previewContent.append(info);
        }
        const canToggle = Boolean(command || image || detail || lines.length || shellOutput);
        toolRow.classList.toggle("has-preview", canToggle);
        const shouldCollapse = canToggle && (hadPreview ? wasCollapsed :
            Boolean(row.closest(".agent-round-detail")) || getAgentDetailDefaultBehavior() === "collapsed");
        toolRow.classList.toggle("collapsed", shouldCollapse);
        summary.classList.toggle("clickable", canToggle);
        summary.tabIndex = canToggle ? 0 : -1;
        summary.setAttribute("role", canToggle ? "button" : "presentation");
        summary.setAttribute("aria-expanded", String(canToggle && !shouldCollapse));
        summary.title = canToggle ? "显示或隐藏工具详情" : "";
        const toggle = summary.querySelector(".agent-tool-toggle");
        if (toggle) toggle.style.display = canToggle ? "block" : "none";
        summary.onclick = canToggle ? () => toggleAgentToolPreview(row) : null;
        summary.onkeydown = canToggle ? event => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggleAgentToolPreview(row);
            }
        } : null;
    }

    function agentToolFailed(message) {
        return message.status === "error" || message.result?.success === false || message.result?.timedOut ||
            (message.toolName === "run_shell" && Number.isInteger(message.result?.exitCode) && message.result.exitCode !== 0);
    }

    function agentToolStopped(message) {
        return message.status === "interrupted" || message.importedInterrupted || message.result?.cancelled;
    }

    function describeAgentTool(message) {
        const args = toolArguments(message);
        const result = message.result || {};
        const path = result.path || args.path;
        const command = String(args.command || "").trim().split(/\r?\n/)[0];
        const description = typeof args.description === "string" ? args.description.trim() : "";
        const start = result.actualStartLine ?? args.start_line;
        const end = result.actualEndLine ?? args.end_line;
        const range = start && end ? ` (${start}–${end})` : "";
        switch (message.toolName || message.name) {
            case "run_shell": return description ? ["", "", description] : ["Running command", command ? "Ran" : "Ran a command", command];
            case "start_process": return description ? ["", "", description] : ["Starting process", "Started process", command];
            case "read_file_range": return ["Reading file", "Read", path, range];
            case "write_file": return ["Writing file", result.created ? "Created" : "Wrote", path];
            case "edit_file":
            case "multi_edit_file":
            case "_claude_insert_text": return ["Editing file", "Edited", path];
            case "_codex_apply_patch": return ["Applying patch", "Applied patch",
                Array.isArray(result.operations) ? result.operations.map(item => item?.path).filter(Boolean).join(", ") :
                    String(args.input || args.patch || args.diff || "").match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m)?.[1]];
            case "_claude_undo_edit": return ["Undoing edit", "Undid edit", path];
            case "list_dir": return ["Listing directory", "Listed", path || args.dir_path || "."];
            case "glob_files": return ["Finding files", "Matched", args.pattern];
            case "grep_files": return ["Searching files", "Searched for", args.pattern];
            case "view_image": return ["Viewing image", "Viewed", path];
            case "delete_path": return ["Deleting path", "Deleted", path];
            case "move_path": return ["Moving path", "Moved", args.from && `${args.from} → ${args.to || "?"}`];
            case "copy_path": return ["Copying path", "Copied", args.from && `${args.from} → ${args.to || "?"}`];
            case "web_search": return ["Searching the web", "Searched the web", args.query];
            case "browse_web": return ["Opening page", "Opened", result.url || args.url];
            case "read_process_output": return ["Reading process output", "Read process output", args.process_id];
            case "stop_process": return ["Stopping process", "Stopped process", args.process_id];
            case "list_processes": return ["Listing processes", "Listed processes"];
            case "update_plan": return ["Updating plan", "Updated plan", args.plan?.find?.(item => item?.status === "in_progress")?.step];
            case "ask_user_question": return ["Waiting for your answer", "Asked a question", args.questions?.[0]?.question];
            case "finish_task": return ["Finishing task", "Finished task"];
            default: return ["Running tool", "Called", message.toolName || message.name];
        }
    }

    function formatAgentToolDetail(message) {
        const result = message.result || {};
        if (result.error) return String(result.error).slice(0, 500);
        if (message.toolName === "run_shell") {
            const progress = agentShellProgressByExecution.get(message.executionId) || {};
            const ms = progress.elapsedMs ?? result.durationMs;
            const bytes = Number(progress.stdoutBytes ?? result.stdoutBytes ?? 0) + Number(progress.stderrBytes ?? result.stderrBytes ?? 0);
            return [Number.isFinite(ms) ? `${Math.round(ms)} ms` : "", bytes ? `${bytes} bytes` : "",
                Number.isInteger(result.exitCode) ? `Exit code ${result.exitCode}` : "",
                result.timedOut ? "Timed out" : ""].filter(Boolean).join(" · ");
        }
        if (message.toolName === "ask_user_question" && result.answers) return Object.values(result.answers).join("\n");
        if (message.toolName === "start_process" && result.processId) return result.processId;
        return result.note || "";
    }

    function writeDiffCounts(node, { added, removed }) {
        node.querySelector(".agent-diff-add").textContent = added ? `+${added}` : "";
        node.querySelector(".agent-diff-remove").textContent = removed ? `−${removed}` : "";
    }

    function agentDiffCounts(message) {
        const diff = message.displayDiff || message.result?.displayDiff;
        const lines = Array.isArray(diff?.lines) ? diff.lines : [];
        return window.AgentActivity.normalize({
            added: diff?.addedLines ?? lines.filter(line => line?.type === "add").length,
            removed: diff?.removedLines ?? lines.filter(line => line?.type === "delete").length
        });
    }

    function setAgentToolRow(row, message) {
        const [action, done, subject, suffix] = describeAgentTool(message);
        const running = message.status === "running";
        const queued = running && liveToolBlocks.has(message) && !activeToolMessages.has(message);
        const stopped = agentToolStopped(message);
        const failed = !stopped && agentToolFailed(message);
        const toolRow = row.querySelector(".agent-tool-row");
        toolRow.classList.toggle("running", running && !queued);
        toolRow.classList.toggle("failed", Boolean(failed));
        const title = row.querySelector(".agent-tool-summary-text");
        title.querySelector(".agent-step-action").textContent = running ? action : done;
        title.querySelector(".agent-step-subject").textContent = subject || "";
        title.querySelector(".agent-step-extra").textContent = suffix || "";
        title.title = [subject, suffix].filter(Boolean).join("");
        row.querySelector(".agent-step-status").textContent = queued ? "Queued" : stopped ? "Stopped" : failed ? "Failed" : "";
        writeDiffCounts(row, agentDiffCounts(message));
        renderAgentToolPreview(row, message);
        lucide.createIcons();
    }

    function appendAgentToolMessageToUI(message, options = {}) {
        const wrapper = options.container || document.getElementById("messages-wrapper");
        if (!wrapper || !message) return null;
        const row = document.createElement("div");
        row.className = options.inline ? "agent-tool-row-wrapper agent-tool-inline" : "chat-row agent-tool-row-wrapper";
        row.dataset.agentToolId = message.toolId || "";
        row.innerHTML = `<div class="agent-tool-row"><div class="agent-tool-summary"><i data-lucide="${TOOL_ICONS[message.toolName] || "wrench"}"></i><span class="agent-tool-summary-text"><span class="agent-step-action"></span> <span class="agent-step-subject"></span><span class="agent-step-extra"></span></span><span class="agent-step-status"></span><span class="agent-diff-add"></span><span class="agent-diff-remove"></span><i class="agent-tool-toggle" data-lucide="chevron-down"></i></div><div class="agent-tool-preview"><div class="agent-tool-preview-content"></div></div></div>`;
        wrapper.insertBefore(row, options.before?.parentNode === wrapper ? options.before : null);
        setAgentToolRow(row, message);
        return row;
    }

    function summarizeAgentRound(messages) {
        let commands = 0, files = 0, created = 0, edits = 0, web = 0, searches = 0, thinking = 0, tools = 0;
        let failed = 0, stopped = 0, added = 0, removed = 0;
        for (const message of messages) {
            if (message.agentThinking) { thinking += 1; continue; }
            if (message.status === "running" || agentToolStopped(message)) {
                stopped += 1;
                continue;
            }
            if (agentToolFailed(message)) { failed += 1; continue; }
            const name = message.toolName || message.name;
            if (window.AgentActivity.COMMAND_TOOLS.has(name)) commands += 1;
            else if (name === "read_file_range") files += 1;
            else if (window.AgentActivity.READ_TOOLS.has(name)) searches += 1;
            else if (window.AgentActivity.WEB_TOOLS.has(name)) web += 1;
            else if (name === "write_file" && message.result?.created) created += 1;
            else if (window.AgentActivity.WRITE_TOOLS.has(name)) edits += 1;
            else tools += 1;
            const diff = agentDiffCounts(message);
            added += diff.added;
            removed += diff.removed;
        }
        const parts = [];
        const count = (n, singular) => `${n} ${singular}${n === 1 ? "" : "s"}`;
        if (commands) parts.push(`Ran ${count(commands, "command")}`);
        if (files) parts.push(`Read ${count(files, "file")}`);
        if (searches) parts.push(`Explored ${count(searches, "result set")}`);
        if (created) parts.push(`Created ${count(created, "file")}`);
        if (edits) parts.push(`Edited ${count(edits, "file")}`);
        if (web) parts.push(`Made ${count(web, "web request")}`);
        if (tools) parts.push(`Used ${count(tools, "tool")}`);
        if (failed) parts.push(`${failed} failed`);
        if (stopped) parts.push(`${stopped} stopped`);
        if (!parts.length && thinking) parts.push("Thought");
        return { label: parts.map((part, i) => i ? part[0].toLowerCase() + part.slice(1) : part).join(", "), added, removed };
    }

    function activityKey(message) {
        return message.agentThinking ? message.gatewayThinkingId : message.toolId;
    }

    function captureAgentActivityView(wrapper) {
        const groups = new Set();
        const details = new Map();
        for (const block of wrapper.querySelectorAll(":scope > .agent-round-summary-wrapper")) {
            if (!block.querySelector(".agent-round-summary")?.classList.contains("expanded")) continue;
            for (const message of block._agentRoundMessages) {
                const key = activityKey(message);
                if (key) groups.add(key);
            }
            for (const row of block.querySelectorAll("[data-agent-detail-key]")) {
                if (row.querySelector(".agent-tool-summary")?.getAttribute("aria-expanded") !== "true") continue;
                details.set(row.dataset.agentDetailKey, Boolean(row.querySelector(".agent-full-output")?.open));
            }
        }
        return { groups, details };
    }

    function appendAgentRoundItem(block, message, thinkingRow) {
        const container = block.querySelector(".agent-round-detail-inner");
        const display = !block._agentLive && message.status === "running" ? { ...message, status: "interrupted" } : message;
        const row = message.agentThinking
            ? thinkingRow || appendAgentThinkingMessageToUI(message, { container })
            : appendAgentToolMessageToUI(display, { container });
        if (!row) return;
        if (thinkingRow) container.append(row);
        const key = activityKey(message);
        if (key) row.dataset.agentDetailKey = key;
        if (block._agentView?.details.has(key)) {
            const header = row.querySelector(".agent-tool-summary");
            if (header?.getAttribute("aria-expanded") === "false") header.click();
            if (block._agentView.details.get(key)) {
                const full = row.querySelector(".agent-full-output");
                if (full) full.open = true;
            }
        }
        lucide.createIcons();
    }

    function expandAgentRoundSummary(row) {
        const bar = row.querySelector(".agent-round-summary");
        const detail = row.querySelector(".agent-round-detail");
        const open = bar.classList.toggle("expanded");
        if (open && !row._agentRoundRendered) {
            row._agentRoundRendered = true;
            for (const message of row._agentRoundMessages) appendAgentRoundItem(row, message, row._agentThinkingRows?.get(message));
        }
        if (!open) {
            for (const step of detail.querySelectorAll('.agent-tool-summary[aria-expanded="true"]')) step.click();
            for (const output of detail.querySelectorAll(".agent-full-output[open]")) output.open = false;
        }
        detail.inert = !open;
        detail.classList.toggle("is-open", open);
        bar.setAttribute("aria-expanded", String(open));
    }

    function refreshAgentRoundSummary(row) {
        const messages = row._agentRoundMessages;
        const unfinished = row._agentLive && messages.some(message => message.status === "running");
        const active = unfinished ? messages.find(message => message.status === "running" &&
            (message.agentThinking || activeToolMessages.has(message))) : null;
        const summary = unfinished ? { label: "Waiting for tools", added: 0, removed: 0 } : summarizeAgentRound(messages);
        const bar = row.querySelector(".agent-round-summary");
        let label = summary.label;
        if (active?.agentThinking) {
            label = active.activityLabel || "Thinking";
        } else if (active) {
            const [action, , subject, suffix] = describeAgentTool(active);
            label = [action, subject].filter(Boolean).join(" ") + (suffix || "");
        }
        const text = bar.querySelector(".agent-tool-summary-text");
        if (text.textContent !== label) {
            text.textContent = label;
            bar.title = active ? label : "";
        }
        bar.classList.toggle("running", Boolean(active));
        writeDiffCounts(bar, summary);
        row.hidden = !messages.length;
    }

    function appendAgentRoundSummaryUI(options = {}) {
        const wrapper = options.container || document.getElementById("messages-wrapper");
        if (!wrapper) return null;
        const row = document.createElement("div");
        row.className = "chat-row agent-round-summary-wrapper";
        row._agentRoundMessages = options.messages || [];
        row._agentLive = options.live === true;
        row._agentView = options.view;
        row.innerHTML = `<button type="button" class="agent-round-summary" aria-expanded="false"><span class="agent-tool-summary-text" aria-live="polite"></span><span class="agent-diff-add"></span><span class="agent-diff-remove"></span><i class="agent-tool-toggle" data-lucide="chevron-right"></i></button><div class="agent-round-detail" inert><div class="agent-round-detail-inner"></div></div>`;
        const bar = row.querySelector(".agent-round-summary");
        bar.onclick = () => expandAgentRoundSummary(row);
        wrapper.append(row);
        if (!options.container) placeAgentTaskFooter();
        refreshAgentRoundSummary(row);
        if (options.view && row._agentRoundMessages.some(message => options.view.groups.has(activityKey(message)))) expandAgentRoundSummary(row);
        lucide.createIcons();
        return row;
    }

    function endAgentActivityBlock() {
        if (liveActivityBlock?.hidden) liveActivityBlock.remove();
        liveActivityBlock = null;
    }

    function appendLiveAgentActivity(message, thinkingRow) {
        if (!liveActivityBlock?.isConnected) {
            liveActivityBlock = appendAgentRoundSummaryUI({ live: true });
            liveActivityBlock._agentThinkingRows = new WeakMap();
        }
        const block = liveActivityBlock;
        if (thinkingRow) block._agentThinkingRows.set(message, thinkingRow);
        else liveToolBlocks.set(message, block);
        block._agentRoundMessages.push(message);
        refreshAgentRoundSummary(block);
        if (block._agentRoundRendered) appendAgentRoundItem(block, message, thinkingRow);
        scrollChatToBottom();
        return block;
    }

    function appendFinishTaskToFinalRow(message, finalRow) {
        appendResponseDuration(finalRow, message.taskDurationMs);
    }

    function appendResponseDuration(finalRow, durationMs) {
        const footer = finalRow?.querySelector(".message-footer");
        if (!footer || !Number.isFinite(durationMs)) return;
        const duration = footer.querySelector(".response-worked-duration") || document.createElement("span");
        duration.className = "response-worked-duration";
        duration.textContent = formatAgentWorkingTime(durationMs);
        footer.prepend(duration);
    }

    function appendResponseActivity(container, reasoning, running, durationMs) {
        if (!running && !reasoning) return null;
        const message = { agentThinking: true, reasoning, thinkingDurationMs: durationMs, status: running ? "running" : "done" };
        const block = appendAgentRoundSummaryUI({ messages: [message], container, live: running });
        block.classList.add("response-activity");
        if (!running) return null;
        const step = appendAgentThinkingRow("Thinking", {
            activate: false, grouped: true, container: document.createDocumentFragment()
        });
        block._agentThinkingRows = new WeakMap([[message, step]]);
        let elapsed;
        let replyStartedAt;
        return {
            update: text => step.updateReasoning(text),
            replying: () => {
                if (message.activityLabel) return;
                replyStartedAt = Date.now();
                message.activityLabel = "Responding";
                refreshAgentRoundSummary(block);
            },
            finish: () => {
                if (elapsed !== undefined) return elapsed;
                elapsed = (replyStartedAt ?? Date.now()) - step.thinkingStartedAt;
                message.status = "done";
                message.reasoning = step.reasoningText;
                message.thinkingDurationMs = elapsed;
                if (!step.finishThinking(elapsed)) block.remove();
                else refreshAgentRoundSummary(block);
                return elapsed;
            }
        };
    }

    function updateAgentToolMessageUI(message) {
        const block = liveToolBlocks.get(message);
        if (!block?.isConnected) return;
        refreshAgentRoundSummary(block);
        if (!block._agentRoundRendered) return;
        const row = block.querySelector(`[data-agent-tool-id="${CSS.escape(String(message.toolId))}"]`);
        if (row) {
            setAgentToolRow(row, message);
            if (!block.querySelector(".agent-round-detail").inert) scrollChatToBottom();
        }
    }

    function updateAgentShellProgressUI(message) {
        const block = liveToolBlocks.get(message);
        if (!block?.isConnected || !block._agentRoundRendered || block.querySelector(".agent-round-detail").inert) return;
        const info = block.querySelector(`[data-agent-tool-id="${CSS.escape(String(message.toolId))}"] .agent-preview-meta`);
        if (!info) return;
        info.textContent = formatAgentToolDetail(message);
        info.hidden = false;
    }

    async function buildAgentMessages(chat, options = {}) {
        const latestUser = [...(chat.messages || [])].reverse().find(message => message?.role === "user" && message.hidden !== true);
        const compacted = buildCompactedChatMessages(chat);
        if (!chat.agentFixedPrompt?.includes(AgentProtocol.CORE_AGENT_RULES)) {
            chat.agentSessionStartedAt = chat.agentSessionStartedAt || Date.now();
            chat.agentFixedPrompt = AgentProtocol.buildFixedAgentPrompt({
                systemPrompt: chat.agentSystemPrompt ?? systemPrompt,
                environment: [
                    chat.agentEnvironment || chat.agentWorkspace || "",
                    `Session started: ${AgentProtocol.formatCurrentTime(new Date(chat.agentSessionStartedAt))}`
                ].filter(Boolean).join("\n")
            });
            if (options.estimateOnly !== true) persistAgentChats();
        }
        const memoryContext = options.memoryAllowed === false ? "" : window.AIUIMemory?.getContext(chat, options);
        const result = [{
            role: "system",
            content: memoryContext ? [chat.agentFixedPrompt, memoryContext,
                "The JSON-only Agent rules apply to workspace tools, with finish_task as the last workspace call. When the optional native manage_memory tool is available, it is the sole exception to those rules. Use it only after the complete user-facing answer, and keep its call out of prose and the Agent JSON protocol."
            ].join("\n\n") : chat.agentFixedPrompt
        }];
        for (const message of compacted) {
            if (message?.agentDisplayOnly === true) continue;
            if (message?.role === "tool") {
                const content = message.content || (message.contentRef ? await agentResultStore.get(message.contentRef) : "");
                let imageResult = message.result;
                if (message.toolName === "view_image" && !imageResult && content) {
                    try { imageResult = JSON.parse(content); } catch (_) { /* retain legacy plain-text results */ }
                }
                if (message.toolName === "view_image" && imageResult && typeof imageResult === "object") {
                    const { dataUrl, ...metadata } = imageResult;
                    const summary = `[Tool Result: view_image]\n${JSON.stringify(metadata)}`;
                    const imageUrl = imageResult.success !== false && typeof dataUrl === "string"
                        && /^data:image\/[^;,]+;base64,/i.test(dataUrl) ? dataUrl : "";
                    result.push({ role: "user", content: imageUrl ? [
                        { type: "text", text: summary },
                        { type: "image_url", image_url: { url: imageUrl } }
                    ] : summary });
                    continue;
                }
                result.push({
                    role: "user",
                    content: `[Tool Result: ${String(message.toolName || "unknown")}]\n${String(content || "")}`
                });
            } else if (message?.role === "user" || message?.role === "assistant" || message?.role === "system") {
                const built = await buildSingleApiMessage(message, chat, message === latestUser);
                if (message.role === "assistant") {
                    built.content = AgentProtocol.stripAssistantReasoningContent(built.content);
                    if (/deepseek/i.test(chat.agentModel || '') && message.reasoning) built.reasoning_content = message.reasoning;
                    if (message.responsesReasoning) built.__aiuiResponsesReasoning = message.responsesReasoning;
                }
                result.push(built);
            }
        }
        // The live plan changes every few turns, so it goes after the cached history
        // prefix rather than inside the fixed prompt or reordering prior turns.
        const planContext = formatAgentPlanForContext(chat);
        if (planContext) result.splice(result.length - (options.queuedCount || 0), 0, { role: "user", content: planContext });
        return result;
    }

    async function requestAgentModel(chat, model, signal, options) {
        const requestMetrics = window.AIUIRequestMetrics?.create();
        const { memoryAllowed, memoryFollowup, onText, onReasoning, onBackendProgress } = options;
        const transport = window.AIUIMemoryTransport;
        const memoryEnabled = memoryAllowed && window.AIUIMemory?.isEnabled();
        const memoryTool = memoryEnabled && transport && window.AIUIMemory.getTool();
        const messages = await buildAgentMessages(chat, { memoryAllowed, queuedCount: options.queuedCount });
        if (memoryFollowup) messages.push({ role: "user",
            content: "The previous response contained a housekeeping tool call but no complete answer. Provide the actual final answer now, then finish the Agent task. Do not repeat the housekeeping call."
        });
        const promptCacheKey = typeof getPromptCacheKeyForChat === "function"
            ? getPromptCacheKeyForChat(chat)
            : String(localStorage.getItem("prompt_cache_key") || "").trim();
        const cacheControl = String(localStorage.getItem("cache_control") || "").trim();
        const basePayload = {
            model,
            temperature: currentTemp,
            messages,
            stream: true,
            __aiuiStructuredResponsesInput: true,
            ...(maxTokensLimit > 0 ? { max_tokens: maxTokensLimit } : {}),
            ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
            ...(cacheControl ? { cache_control: cacheControl } : {})
        };
        const preferredEndpoint = getRequestEndpoint();
        signal.throwIfAborted();
        onBackendProgress();
        appendLog("debug", "开始请求 Agent AI 接口");
        appendLog("trace", `Agent AI 请求 URL: ${getBaseURL()}${preferredEndpoint}`);
        let fallbackRow;
        const { response, endpoint, requestBody, requestDecorated } = await fetchEndpointWithFallback(basePayload, preferredEndpoint, signal, {
            redactDiagnostics: Boolean(memoryEnabled),
            ...(memoryTool ? {
                decorateRequest: (body, targetEndpoint) => transport.declareTool(body, targetEndpoint, memoryTool),
                retryWithoutDecoration: transport.isUnsupportedToolError
            } : {}),
            onFallback: info => {
                signal.throwIfAborted();
                fallbackRow?.remove();
                fallbackRow = appendAgentEndpointFallbackRow(info);
            }
        }).catch(error => {
            fallbackRow?.remove();
            throw error;
        });
        signal.throwIfAborted();
        if (response.ok) completeAgentEndpointFallbackRow(fallbackRow, endpoint);
        else fallbackRow?.remove();
        lastPromptCacheDebug = logPromptCacheDebug(requestBody, lastPromptCacheDebug);
        if (!memoryEnabled) appendLog("trace", `Agent 请求体: ${JSON.stringify(requestBody)}`);
        if (!response.ok) {
            void response.body?.cancel?.().catch(() => {});
            throw new Error(getAgentHttpErrorReason(response.status, response.statusText));
        }
        appendLog("trace", `Agent AI 接口响应状态: ${response.status} ${response.statusText || ""}`);
        const memoryCollector = memoryTool && requestDecorated ? transport.createCollector(endpoint) : null;
        const debugStream = developerModeEnabled && (logLevel === "debug" || logLevel === "trace");
        const traceStream = developerModeEnabled && logLevel === "trace" && !memoryEnabled;
        const ndjsonStream = typeof isOllamaEndpoint === "function" && isOllamaEndpoint(endpoint);
        let fullText = "";
        let reasoningText = "";
        const responsePayloads = [];
        const seenStreamEvents = new Set();
        let completion = {};
        let sawCompletion = false;
        let sawStreamEvent = false;
        let sawDoneMarker = false;
        let lastOutputComplete = false;
        const applyPayload = (payload, streaming, eventType = "") => {
            if (!payload || typeof payload !== "object") throw new Error("模型返回了无效的响应格式");
            if (!payload.type && eventType) payload = { ...payload, type: eventType };
            const streamError = getStreamingErrorMessage(payload);
            if (streamError || payload.status === "failed") {
                throw new Error(memoryEnabled ? "模型接口返回错误" : streamError || "模型接口返回失败状态");
            }
            const sequence = payload.sequence_number;
            // Relays can reuse one SSE id for a response, including identical
            // consecutive token deltas. Only a protocol sequence number can
            // distinguish a replay from an intentional repeated token.
            const eventKey = Number.isSafeInteger(sequence) && sequence >= 0
                ? `${payload.type || endpoint}:${sequence}:${JSON.stringify(payload)}` : "";
            if (eventKey && seenStreamEvents.has(eventKey)) return;
            if (eventKey) seenStreamEvents.add(eventKey);
            responsePayloads.push(payload);
            onBackendProgress();
            memoryCollector?.ingest(payload);
            completion = collectAgentCompletionInfo(payload, completion);
            sawCompletion ||= !streaming || isAgentStreamEnd(payload, completion);
            lastOutputComplete = ["response.output_item.done", "response.output_text.done", "response.content_part.done"].includes(payload.type)
                || Boolean(payload.choices?.[0]?.message);
            const update = extractStreamingUpdate(payload, endpoint);
            if (requestMetrics) {
                window.AIUIRequestMetrics.ingest(requestMetrics, payload, update);
                window.AIUIEnhancements?.requestMetrics(chat, requestMetrics);
            }
            const nextText = streaming
                ? mergeStreamingText(fullText, update.contentDelta, update.contentSnapshot)
                : extractNonStreamingResponseText(payload, endpoint);
            if (nextText !== fullText) {
                fullText = nextText;
                if (streaming) onText(fullText);
            }
            const nextReasoning = mergeStreamingText(reasoningText, update.reasoningDelta, update.reasoningSnapshot);
            if (nextReasoning !== reasoningText) {
                reasoningText = nextReasoning;
                onReasoning(reasoningText);
            }
        };
        const consume = block => {
            const event = ndjsonStream ? { data: block.trim() } : parseSSEEventBlock(block);
            if (!event.data) return;
            sawStreamEvent = true;
            if (event.data === "[DONE]") { sawDoneMarker = true; return; }
            applyPayload(JSON.parse(event.data), true, event.eventType);
        };
        if (!response.body?.getReader || /\bapplication\/(?:json|[\w.+-]+\+json)\b/i.test(response.headers?.get("content-type") || "")) {
            applyPayload(await response.json(), false);
        } else {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let bytes = 0;
            let reachedEOF = false;
            try {
                while (!sawDoneMarker) {
                    const { done, value } = await reader.read();
                    signal.throwIfAborted();
                    reachedEOF = done;
                    if (done) break;
                    bytes += value.byteLength;
                    buffer += decoder.decode(value, { stream: true });
                    if (debugStream) appendLog("debug", `收到 Agent 流数据块，累计 ${bytes} 字节`);
                    if (traceStream) appendLog("trace", `Agent 原始流内容: ${buffer.replace(/\n/g, "\\n")}`);
                    const parts = buffer.split(ndjsonStream ? /\r?\n/ : /\r?\n\r?\n/);
                    buffer = parts.pop() || "";
                    for (const part of parts) {
                        consume(part);
                        if (sawDoneMarker) break;
                    }
                }
                buffer += decoder.decode();
                if (!sawDoneMarker && buffer.trim()) {
                    if (ndjsonStream || /^(?:event:|data:|id:)/m.test(buffer)) consume(buffer);
                    else if (!sawStreamEvent) applyPayload(JSON.parse(buffer), false);
                }
            } finally {
                if (!reachedEOF) void reader.cancel?.().catch(() => {});
                reader.releaseLock?.();
            }
            appendLog("debug", `Agent 流式输出接收完毕，累计 ${bytes} 字节`);
        }
        signal.throwIfAborted();
        const memoryCalls = memoryCollector?.finish() || [];
        const toolCalls = ToolCallNormalizer.canonicalizeToolCalls(ToolCallNormalizer.normalizeToolCalls(responsePayloads));
        if (!fullText.trim() && !reasoningText.trim() && !toolCalls.length && !memoryCalls.length && !completion.tokenLimited) {
            throw new Error("后端返回空响应");
        }
        if (!sawCompletion && !sawDoneMarker && !lastOutputComplete) throw new Error("回复流提前中断");
        onBackendProgress(false);
        if (requestMetrics) {
            let count = 0;
            if ((!requestMetrics.hasOutputUsage || (requestMetrics.reasoningText && !requestMetrics.hasReasoningUsage)) && fullText) try { count = await window.electronAPI.countContextTokens(fullText, model); } catch (_) {}
            window.AIUIEnhancements?.requestMetrics(chat, requestMetrics, true, count);
        }
        signal.throwIfAborted();
        if (typeof updateTokenEstimate === 'function') updateTokenEstimate();
        return {
            text: fullText,
            reasoning: reasoningText,
            responsesReasoning: AgentProtocol.createResponsesReasoningState(responsePayloads, { endpoint, model, baseURL: getBaseURL() }),
            completion,
            memoryCalls,
            toolCalls
        };
    }

    function isAgentStreamEnd(payload, completion) {
        return Boolean(completion.finishReason || ["completed", "incomplete"].includes(completion.status)
            || payload.done === true || payload.candidates?.[0]?.finishReason
            || ["message_stop", "response.completed", "response.done", "response.incomplete"].includes(payload.type));
    }

    function getAgentHttpErrorReason(status, statusText) {
        const descriptions = {
            400: "请求无效", 401: "身份验证失败", 403: "访问被拒绝", 404: "未找到接口或模型", 408: "请求超时",
            429: "请求过于频繁", 500: "服务器内部错误", 501: "接口不受支持", 502: "网关错误", 503: "服务暂不可用", 504: "网关超时"
        };
        return [`HTTP ${status}`, descriptions[status] || statusText].filter(Boolean).join(" ");
    }

    function getAgentBackendErrorReason(error) {
        if (error?.name === "SyntaxError") return "模型返回了无效的响应格式";
        const message = String(error?.message || "未知错误").replace(/\s+/g, " ").trim();
        if (/failed to fetch|network(?:error| error)|load failed/i.test(message)) return "网络连接失败或中断";
        return message.length > 120 ? message.slice(0, 119) + "…" : message;
    }

    function showAgentBackendRetry(row, reason, attempt) {
        const wrapper = document.getElementById("messages-wrapper");
        if (!row) {
            row = document.createElement("div");
            row.className = "chat-row agent-round-summary-wrapper agent-backend-retry-row";
            row.innerHTML = '<div class="agent-retry-summary running" role="status"><span class="agent-tool-summary-text"></span></div>';
            wrapper.append(row);
        }
        window.agentReconnectNotice = `后端错误：${reason} 正在重试 （${attempt}/${MAX_BACKEND_RETRIES}）`;
        row.querySelector(".agent-tool-summary-text").textContent = window.agentReconnectNotice;
        placeAgentTaskFooter();
        scrollChatToBottom();
        return row;
    }

    function waitForAgentRetry(signal) {
        return new Promise(resolve => {
            const finish = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", finish);
                resolve();
            };
            const timer = setTimeout(finish, BACKEND_RETRY_DELAY_MS);
            signal.addEventListener("abort", finish, { once: true });
        });
    }

    function createAgentTextPreview(model) {
        let row;
        let frame;
        let pending = "";
        let displayed = "";
        return {
            update(text) {
                pending = text;
                if (frame !== undefined) return;
                frame = requestAnimationFrame(() => {
                    frame = undefined;
                    const prose = ToolCallNormalizer.getAgentStreamingText(pending);
                    if (prose === displayed) return;
                    displayed = prose;
                    if (!prose) { row?.remove(); row = null; return; }
                    if (!row) {
                        row = appendMessageToUI("assistant", "", model, false, "", [], [], "", {
                            agentSegment: true, agentMessage: true, container: document.getElementById("messages-wrapper")
                        });
                        row.classList.add("agent-streaming-row");
                        placeAgentTaskFooter();
                    }
                    row.querySelector(".ai-content-area").innerHTML = renderAssistantMarkdown(prose);
                    scrollChatToBottom();
                });
            },
            clear() {
                if (frame !== undefined) cancelAnimationFrame(frame);
                frame = undefined;
                row?.remove();
                row = null;
                displayed = "";
            }
        };
    }

    async function requestAgentModelWithRetry(chat, model, options) {
        agentModelController = new AbortController();
        const { signal } = agentModelController;
        const preview = createAgentTextPreview(model);
        let retryRow;
        let thinkingRow = appendAgentThinkingRow();
        try {
            for (let retries = 0; ; retries += 1) {
                const attempt = new AbortController();
                const attemptSignal = AbortSignal.any([signal, attempt.signal]);
                let idleTimer;
                const onBackendProgress = (waiting = true) => {
                    clearTimeout(idleTimer);
                    if (waiting) idleTimer = setTimeout(() => attempt.abort(new Error("等待后端回复超时")), BACKEND_IDLE_TIMEOUT_MS);
                };
                try {
                    const result = await requestAgentModel(chat, model, attemptSignal, { ...options, onBackendProgress,
                        onText: preview.update,
                        onReasoning: text => {
                            thinkingRow ||= appendAgentThinkingRow();
                            thinkingRow.updateReasoning(ToolCallNormalizer.stripReasoningSections(text));
                        }
                    });
                    thinkingRow ||= appendAgentThinkingRow();
                    return { result, thinkingRow };
                } catch (error) {
                    onBackendProgress(false);
                    preview.clear();
                    if (thinkingRow) {
                        thinkingRow.updateReasoning("");
                        thinkingRow.finishThinking();
                        thinkingRow = null;
                    }
                    endAgentActivityBlock();
                    if (signal.aborted) return null;
                    const reason = getAgentBackendErrorReason(attemptSignal.reason || error);
                    appendLog("warn", `Agent 后端请求失败：${reason}`);
                    if (retries === MAX_BACKEND_RETRIES) throw new Error(`后端错误：${reason}，已重试 ${MAX_BACKEND_RETRIES} 次`);
                    retryRow = showAgentBackendRetry(retryRow, reason, retries + 1);
                    await waitForAgentRetry(signal);
                    if (signal.aborted) return null;
                }
            }
        } finally {
            agentModelController = null;
            preview.clear();
            retryRow?.remove();
            window.agentReconnectNotice = "";
        }
    }

    function collectAgentCompletionInfo(payload, previous = {}) {
        const response = payload?.response && typeof payload.response === "object" ? payload.response : payload;
        const usage = response?.usage || payload?.message?.usage || {};
        const finishReason = payload?.choices?.[0]?.finish_reason || payload?.delta?.stop_reason
            || payload?.stop_reason || payload?.message?.stop_reason || previous.finishReason || "";
        const incompleteReason = response?.incomplete_details?.reason || previous.incompleteReason || "";
        const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? previous.outputTokens;
        const reasoningTokens = usage.output_tokens_details?.reasoning_tokens
            ?? usage.completion_tokens_details?.reasoning_tokens ?? previous.reasoningTokens;
        return { ...previous, finishReason, incompleteReason, status: response?.status || previous.status || "",
            ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
            ...(Number.isFinite(reasoningTokens) ? { reasoningTokens } : {}),
            tokenLimited: ["length", "max_tokens", "max_output_tokens"].includes(finishReason)
                || ["max_tokens", "max_output_tokens"].includes(incompleteReason) };
    }

    function appendAgentHiddenAssistant(chat, rawText, model, reasoning, options = {}) {
        if (!rawText && !reasoning && !options.responsesReasoning) return;
        const message = {
            role: "assistant",
            content: String(rawText || ""),
            model,
            reasoning: ToolCallNormalizer.stripReasoningSections(String(reasoning || "")),
            ...(options.responsesReasoning ? { responsesReasoning: options.responsesReasoning } : {}),
            hidden: true,
            agentToolResponse: true,
            agentThinking: options.agentThinking === true,
            ...(options.gatewayThinkingId ? { gatewayThinkingId: options.gatewayThinkingId } : {}),
            thinkingDurationMs: Math.max(0, Number(options.thinkingDurationMs || 0))
        };
        chat.messages.push(message);
        chat.updatedAt = Date.now();
        persistAgentChats();
        return message;
    }

    function isAgentMemoryCall(call) {
        return /(?:^|\.)manage_memory$/i.test(String(call?.name || ""));
    }

    function stripAgentMemoryProtocol(text, options) {
        if (!/\bmanage_memory\b/i.test(String(text || ""))) return text;
        const parsed = ToolCallNormalizer.parseAgentResponse(text, [], options);
        if (parsed.hasMalformedToolCall) return "";
        if (!parsed.calls.some(isAgentMemoryCall)) return text;
        return parsed.segments.filter(segment => !isAgentMemoryCall(segment.call)).map(segment => {
            if (segment.type === "text") return segment.text;
            return JSON.stringify({ tool_call: { name: segment.call.name, arguments: segment.call.arguments } });
        }).join("\n\n");
    }

    function completeAgentThinking(chat, model, row, result = {}) {
        if (!row) return null;
        const reasoning = ToolCallNormalizer.stripReasoningSections(String(result.reasoning || row.reasoningText || ""));
        if (reasoning && reasoning !== row.reasoningText) row.updateReasoning(reasoning);
        const durationMs = Math.max(0, Date.now() - Number(row.thinkingStartedAt || Date.now()));
        const agentThinking = row.finishThinking(durationMs);
        return appendAgentHiddenAssistant(chat, result.text || "", model, reasoning, {
            responsesReasoning: result.responsesReasoning,
            agentThinking,
            gatewayThinkingId: row.gatewayThinkingId,
            thinkingDurationMs: durationMs
        });
    }

    function appendAgentVisibleText(chat, text, model, reasoning = "", final = false, insertAt = null) {
        if (ToolCallNormalizer.hasMalformedToolCall && ToolCallNormalizer.hasMalformedToolCall(text)) return null;
        let content = AgentProtocol.stripToolCallsForDisplay(text);
        // Protocol-loop diagnostics are internal state, not user-facing正文.
        // Keep any model正文 before the diagnostic and render it normally.
        content = content.replace(/\n\s*Agent[^\n]*finish_task[^\n]*(?:\n|$)/gi, "\n").trim();
        if (!content) return null;
        const message = {
            role: "assistant",
            content,
            completedAt: Date.now(),
            model,
            reasoning: ToolCallNormalizer.stripReasoningSections(String(reasoning || "")),
            agentDisplayOnly: true,
            agentSegment: !final,
            agentFinal: final
        };
        if (insertAt !== null) {
            chat.messages.splice(insertAt, 0, message);
        } else {
            chat.messages.push(message);
            appendMessageToUI("assistant", content, model, final, message.reasoning, [], [], "", {
                completedAt: message.completedAt,
                agentFinal: final,
                agentSegment: !final,
                agentMessage: true,
                voiceMessage: message,
                voiceMessageKey: window.getTextVoiceMessageKey?.(chat.id, chat.messages.length - 1)
            });
        }
        chat.updatedAt = Date.now();
        persistAgentChats();
        return message;
    }

    function appendAgentRecoveryStatus(chat, text, model, failed = false) {
        // Fixed application messages must remain visible even when the model's
        // malformed protocol text cannot safely pass the normal prose renderer.
        const message = { role: "assistant", content: text, model, agentDisplayOnly: true,
            agentRecovery: true, agentSegment: !failed, agentFinal: failed, ...(failed ? { failed: true } : {}) };
        chat.messages.push(message);
        appendMessageToUI("assistant", text, model, failed, "", [], [], "", {
            agentFinal: failed, agentSegment: !failed, agentMessage: true, failed
        });
        chat.updatedAt = Date.now();
        persistAgentChats();
        return message;
    }

    // Returned by the resolver when the user stopped the task mid-tool; the caller
    // must abort the loop without recording a result.
    const STOP_SENTINEL = Symbol("agent-stop");

    function prepareAgentToolMessage(chat, call) {
        const message = {
            role: "tool",
            name: call.name,
            toolName: call.name,
            arguments: call.arguments || {},
            status: "running",
            content: "",
            toolId: `${chat.id}-${Date.now()}-${agentToolSequence += 1}`
        };
        if (call.name === "run_shell") message.executionId = `${chat.id}-${Date.now()}-${agentToolSequence += 1}`;
        chat.messages.push(message);
        appendLiveAgentActivity(message);
        if (call.name === "ask_user_question") endAgentActivityBlock();
        persistAgentChats();
        return message;
    }

    async function resolveAgentToolResult(chat, call, message) {
        activeToolMessages.add(message);
        updateAgentToolMessageUI(message);
        if (call.name === 'ask_user_question') {
            const result = await requestAgentUserQuestion(call.arguments || {}, message);
            return agentStopRequested ? STOP_SENTINEL : result;
        }
        if (call.name === "update_plan") {
            return handleUpdatePlan(chat, call.arguments || {});
        }
        if (call.name === "run_shell" || call.name === 'start_process') {
            const command = String(call.arguments?.command || "");
            if (!command.trim()) return { success: false, error: "command is required" };
            if (agentCommandMode !== "yolo") {
                const alwaysAsk = agentCommandMode === "ask";
                const policy = alwaysAsk ? { allowed: false } : await window.electronAPI.checkAgentCommand(command);
                if (agentStopRequested) return STOP_SENTINEL;
                if (!policy.allowed) {
                    const decision = await requestAgentCommandApproval(command, message, alwaysAsk);
                    if (agentStopRequested) return STOP_SENTINEL;
                    if (decision === "reject") {
                        return { success: false, rejected: true, error: `[${command}]被用户拒绝，尝试更换方法。` };
                    }
                    if (!alwaysAsk && decision === "always" && policy.suggestedPrefix) {
                        await window.electronAPI.addAgentAllowedCommand(policy.suggestedPrefix);
                        if (agentStopRequested) return STOP_SENTINEL;
                    }
                }
            }
            if (call.name === 'start_process') return window.electronAPI.executeAgentTool({ chatId:chat.id,name:call.name,arguments:call.arguments || {} });
            const startedAt = Date.now();
            const progress = { stdoutBytes: 0, stderrBytes: 0, elapsedMs: 0 };
            agentShellProgressByExecution.set(message.executionId, progress);
            const progressTimer = setInterval(() => {
                progress.elapsedMs = Date.now() - startedAt;
                updateAgentShellProgressUI(message);
            }, 250);
            try {
                return await window.electronAPI.executeAgentTool({
                    chatId: chat.id,
                    name: call.name,
                    arguments: call.arguments || {},
                    executionId: message.executionId,
                    timeoutMs: getAgentShellTimeoutMs()
                });
            } finally {
                clearInterval(progressTimer);
                agentShellProgressByExecution.delete(message.executionId);
            }
        }
        if (call.name === "_claude_insert_text") return handleClaudeInsertText(chat, call.arguments || {});
        if (call.name === "_claude_undo_edit") {
            return { success: false, error: "undo_edit is not supported in this environment. Use edit_file to manually revert the previous change by swapping old_text and new_text." };
        }
        if (call.name === "_codex_apply_patch") {
            const patch = String(call.arguments?.input || call.arguments?.patch || call.arguments?.diff || "");
            if (!patch.trim()) {
                return { success: false, error: "apply_patch input is empty. Provide a patch containing *** Begin Patch sections, or use edit_file / multi_edit_file instead." };
            }
            return window.electronAPI.executeAgentTool({
                chatId: chat.id,
                name: "apply_patch",
                arguments: { input: patch }
            });
        }
        const toolArguments = call.name === "view_image"
            ? { ...(call.arguments || {}), detail: call.arguments?.detail || localStorage.getItem("agent_view_image_detail") || "medium" }
            : (call.name === "web_search"
                ? { ...(call.arguments || {}), engine: call.arguments?.engine || localStorage.getItem("agent_search_engine") || "" }
                : (call.arguments || {}));
        return window.electronAPI.executeAgentTool({
            chatId: chat.id,
            name: call.name,
            arguments: toolArguments
        });
    }

    function getAgentQuestions(args) {
        const raw = Array.isArray(args.questions) ? args.questions : [{ question: args.question || args.prompt, options: args.options }];
        return raw.slice(0, 6)
            .filter(item => item && String(item.question || item.header || "").trim())
            .map((item, index) => ({
                id: String(item.id || index),
                title: String(item.question || item.header).trim(),
                options: (Array.isArray(item.options) ? item.options : []).slice(0, 12).map(option => ({
                    label: typeof option === "string" ? option : String(option?.label || ""),
                    description: typeof option?.description === "string" ? option.description : ""
                })).filter(option => option.label.trim())
            }));
    }

    function addAgentQuestionOption(field, name, { label, description }) {
        const choice = document.createElement("div");
        choice.className = "agent-question-choice";
        const option = document.createElement("label");
        option.className = "agent-question-option";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = name;
        radio.value = label;
        const text = document.createElement("span");
        text.textContent = label;
        if (description) {
            const detail = document.createElement("small");
            detail.textContent = description;
            text.append(detail);
        }
        option.append(radio, text);
        choice.append(option);
        field.append(choice);
        return { choice, radio };
    }

    function addAgentQuestionField(form, question, headingId) {
        const field = document.createElement("fieldset");
        const heading = document.createElement("h4");
        heading.className = "agent-card-heading";
        heading.id = headingId;
        heading.textContent = question.title;
        field.setAttribute("aria-labelledby", headingId);
        field.append(heading);
        form.append(field);

        const custom = document.createElement("input");
        custom.className = "agent-question-input";
        custom.type = "text";
        custom.placeholder = "输入你的回答…";
        custom.setAttribute("aria-labelledby", headingId);
        if (!question.options.length) {
            field.append(custom);
            return { field, custom, manual: null };
        }

        const radios = question.options.map(option => addAgentQuestionOption(field, headingId, option).radio);
        radios[0].checked = true;
        const { choice, radio: manual } = addAgentQuestionOption(field, headingId, { label: "手动输入" });
        custom.hidden = true;
        choice.append(custom);
        field.addEventListener("change", event => {
            if (event.target.type === "radio") custom.hidden = !manual.checked;
        });
        manual.addEventListener("click", event => {
            if (event.detail > 0 && manual.checked) {
                custom.hidden = false;
                custom.focus();
            }
        });
        return { field, custom, manual };
    }

    function createAgentQuestionAnswerRow(questions, result) {
        if (result?.success === false || (!result?.cancelled && !result?.answers)) return null;
        const row = document.createElement("div");
        row.className = "chat-row agent-question-row";
        const card = document.createElement("div");
        card.className = "detail-surface agent-interaction-card agent-question-answer";
        for (const question of questions) {
            const entry = document.createElement("div");
            const heading = document.createElement("h4");
            heading.textContent = question.title;
            const answer = document.createElement("p");
            answer.textContent = result.cancelled ? "已取消" : (result.answers[question.id] ?? "");
            entry.append(heading, answer);
            card.append(entry);
        }
        row.append(card);
        return row;
    }

    function appendAgentQuestionAnswerToUI(message, wrapper) {
        const questions = getAgentQuestions(toolArguments(message));
        const row = questions.length ? createAgentQuestionAnswerRow(questions, message.result) : null;
        if (row) wrapper.append(row);
    }

    function requestAgentUserQuestion(args, message) {
        const questions = getAgentQuestions(args);
        if (!questions.length) return Promise.resolve({ success: false, error: "questions must contain at least one question" });
        const form = document.createElement("form");
        form.className = "detail-surface agent-interaction-card agent-question";
        const controls = questions.map((question, index) => addAgentQuestionField(form, question, `agent-question-${message.toolId}-${index}`));
        const error = document.createElement("p");
        error.className = "agent-question-error";
        error.setAttribute("role", "alert");
        const actions = document.createElement("div");
        actions.className = "agent-card-actions agent-question-actions";
        actions.innerHTML = '<button type="button">取消</button><button type="submit" class="agent-card-primary">提交答案</button>';
        const [cancel, submit] = actions.children;
        form.append(error, actions);
        bindAgentCardSubmitShortcut(form, submit);
        const questionRow = document.createElement("div");
        questionRow.className = "chat-row agent-question-row";
        questionRow.append(form);
        const block = liveToolBlocks.get(message);
        if (block?.isConnected) block.after(questionRow);
        else document.getElementById("messages-wrapper").append(questionRow);
        placeAgentTaskFooter();
        window.AIUIEnhancements?.notifyQuestion(questions[0].title);
        revealAgentCard(form, form.querySelector("input:checked, input[type=text]:not([hidden])"));
        return new Promise(resolve => {
            agentQuestionResolver = result => {
                agentQuestionResolver = null;
                if (agentStopRequested) questionRow.remove();
                else questionRow.replaceWith(createAgentQuestionAnswerRow(questions, result));
                resolve(result);
            };
            cancel.onclick = () => agentQuestionResolver?.({ success: true, cancelled: true, answers: {} });
            form.oninput = () => { error.textContent = ""; };
            form.onsubmit = event => {
                event.preventDefault();
                const answers = [];
                for (const [index, { field, custom, manual }] of controls.entries()) {
                    const checked = field.querySelector("input:checked");
                    const value = !manual || checked === manual ? custom.value.trim() : checked?.value;
                    if (!value) {
                        error.textContent = "请回答每个问题，或取消本次询问。";
                        (custom.hidden ? field.querySelector("input") : custom).focus();
                        return;
                    }
                    answers.push([questions[index].id, value]);
                }
                agentQuestionResolver?.({ success: true, answers: Object.fromEntries(answers) });
            };
        });
    }

    function recordAgentActivity(chat, toolName, message) {
        if (!chat?.agentEnabled) return;
        const stats = window.AgentActivity?.applyToolActivity(chat, toolName, message);
        if (!stats) return;
        chat.updatedAt = Date.now();
        window.AIUIEnhancements?.refreshAgentSidebar?.();
    }

    async function finalizeAgentToolResult(chat, call, message, result) {
        message.result = result || { success: false, error: "tool did not return a result" };
        if (message.result.displayDiff) {
            message.displayDiff = message.result.displayDiff;
            delete message.result.displayDiff;
        }
        message.status = message.result.success === false || (call.name === "run_shell" && message.result.exitCode !== 0) ? "error" : "done";
        recordAgentActivity(chat, call.name, message);
        message.content = message.result.rejected
            ? String(message.result.error || "")
            : JSON.stringify(message.result);
        await persistAgentToolMessage(chat, message);
        updateAgentToolMessageUI(message);
    }

    /**
     * Runs a group of already-rendered tool calls from one model response. Read-only
     * calls are dispatched concurrently because they cannot interfere with each
     * other; any mutating call runs alone, in order, and drains the pending read
     * batch first so "later calls see earlier effects" still holds.
     */
    async function executeAgentToolBatch(chat, items) {
        let pendingReads = [];
        const flushReads = async () => {
            if (!pendingReads.length) return true;
            const batch = pendingReads;
            pendingReads = [];
            await Promise.all(batch.map(async item => {
                const result = await resolveAgentToolResult(chat, item.call, item.message);
                if (result === STOP_SENTINEL) return;
                await finalizeAgentToolResult(chat, item.call, item.message, result);
            }));
            return !agentStopRequested;
        };
        for (const item of items) {
            if (READ_ONLY_TOOLS.has(item.call.name)) {
                pendingReads.push(item);
                continue;
            }
            if (!(await flushReads())) return false;
            const result = await resolveAgentToolResult(chat, item.call, item.message);
            if (result === STOP_SENTINEL) return false;
            await finalizeAgentToolResult(chat, item.call, item.message, result);
            if (agentStopRequested) return false;
        }
        return flushReads();
    }

    function handleUpdatePlan(chat, args) {
        const plan = Array.isArray(args.plan) ? args.plan : [];
        const explanation = String(args.explanation || "");
        const sanitized = plan.map(item => ({
            step: String(item?.step || ""),
            status: ["pending", "in_progress", "completed"].includes(item?.status) ? item.status : "pending"
        })).filter(item => item.step);
        const inProgressCount = sanitized.filter(item => item.status === "in_progress").length;
        if (inProgressCount > 1) {
            return { success: false, error: `at most one plan step may be in_progress, got ${inProgressCount}` };
        }
        agentPlansByChat.set(chat.id, { explanation, steps: sanitized, updatedAt: Date.now() });
        // Mirror onto the chat so the plan survives a reload instead of living only
        // in this tab's memory.
        chat.agentPlan = { explanation, steps: sanitized, updatedAt: Date.now() };
        persistAgentChats();
        return { success: true, explanation, plan: sanitized, stepCount: sanitized.length };
    }

    async function handleClaudeInsertText(chat, args) {
        const filePath = String(args.path || "");
        const insertLine = Number(args.insert_line) || 0;
        const insertText = String(args.insert_text || "");
        if (!filePath) return { success: false, error: "path is required" };
        try {
            const readResult = await window.electronAPI.executeAgentTool({
                chatId: chat.id,
                name: "read_file_range",
                arguments: { path: filePath, start_line: 1, end_line: 1000000 }
            });
            if (!readResult?.success) return readResult;
            const content = String(readResult.content || "");
            const lines = content.split(/\r?\n/);
            const insertIndex = Math.max(0, Math.min(insertLine, lines.length));
            const before = lines.slice(0, insertIndex).join("\n");
            const after = lines.slice(insertIndex).join("\n");
            const newContent = before + (before ? "\n" : "") + insertText + (after ? "\n" : "") + after;
            return await window.electronAPI.executeAgentTool({
                chatId: chat.id,
                name: "write_file",
                arguments: { path: filePath, content: newContent }
            });
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    function getAgentPlanLines(chat) {
        const plan = agentPlansByChat.get(chat.id);
        if (!plan || !Array.isArray(plan.steps)) return [];
        const lines = [];
        if (plan.explanation) lines.push({ type: "output", text: plan.explanation });
        plan.steps.forEach((step, index) => {
            const marker = step.status === "completed" ? "[x]" : step.status === "in_progress" ? "[>]" : "[ ]";
            lines.push({ type: step.status === "completed" ? "output" : step.status === "in_progress" ? "error" : "output", text: `${marker} ${index + 1}. ${step.step}` });
        });
        return lines;
    }

    function formatAgentPlanForContext(chat) {
        const plan = agentPlansByChat.get(chat.id) || chat.agentPlan;
        const steps = Array.isArray(plan?.steps) ? plan.steps : [];
        if (!steps.length) return "";
        const lines = steps.map((step, index) => {
            const marker = step.status === "completed" ? "[x]" : step.status === "in_progress" ? "[>]" : "[ ]";
            return `${marker} ${index + 1}. ${String(step.step || "")}`;
        });
        const explanation = String(plan?.explanation || "").trim();
        return [
            "Current Task Plan",
            "",
            explanation,
            lines.join("\n"),
            "",
            "Keep this plan accurate: mark a step in_progress before starting it and completed only once it is verified. Use update_plan to revise it whenever the plan changes."
        ].filter(part => part !== "").join("\n");
    }

    async function requestAgentProtocolCorrection(chat, model, rawText, recovery = {}) {
        const evidence = recovery.malformedProtocol && typeof ToolCallNormalizer.extractToolCallEvidence === "function"
            ? ToolCallNormalizer.extractToolCallEvidence(rawText)
            : "";
        const knownRecovery = !recovery.malformedProtocol && (recovery.toolFailure ? {
            issue: "tool_execution_failed", location: "tool results",
            suggestion: "根据实际失败的工具结果修复问题；成功声明必须以已验证的执行结果为依据。"
        } : recovery.missingFinal ? {
            issue: "missing_final_answer", location: "assistant output",
            suggestion: "工具调用已被识别，但用户还没有收到完整结果；先输出实际最终答复，再调用 finish_task。"
        } : recovery.planOnly ? {
            issue: "repeated_plan_without_progress", location: "agent plan",
            suggestion: "计划已经成功更新；继续执行下一步实际工作，或直接输出最终结果，不必重新修复已成功的工具语法。"
        } : recovery.tokenLimited ? {
            issue: "output_token_limit", location: "model response",
            suggestion: "输出受到服务长度限制；减少重复思考并继续提供尚未输出的实际结果。"
        } : recovery.reasoningOnly ? {
            issue: "reasoning_without_output", location: "assistant output",
            suggestion: "思考已接收，但正文和可执行工具均为空；请在实际输出通道提供答案或调用工具。"
        } : {
            issue: "empty_response", location: "assistant output",
            suggestion: "尚未收到可显示的正文或可执行工具；请提供实际输出。"
        });
        const diagnostics = knownRecovery || (typeof ToolCallNormalizer.diagnoseToolCallResponse === "function"
            ? ToolCallNormalizer.diagnoseToolCallResponse(rawText)
            : {
                issue: evidence ? "malformed_or_unsupported_tool_call" : "no_tool_call",
                location: evidence ? "tool-call fragment" : "response",
                suggestion: "Return a complete standalone JSON tool call using the exact local tool name and argument schema."
            });
        const errorText = [
            recovery.malformedProtocol ? "Agent 协议诊断：模型返回内容未能执行。请根据以下诊断修复后重试。" : "Agent 执行状态提示：请根据当前实际结果继续完成任务。",
            recovery.reasoningOnly ? "上一轮只返回了思考，没有实际正文或工具调用。不要继续仅在思考通道讨论计划；请在实际正文通道输出用户所需的答案，必要时发出真实工具调用。" : "",
            recovery.missingFinal ? "你请求结束任务，但尚未提供可显示的最终答复。请实际输出完整答案，再发出终止调用；不要只描述接下来打算如何回答。" : "",
            recovery.planOnly ? "更新计划只是记录步骤，不代表已完成用户任务。请继续执行实际工作或直接给出最终答复，不要重复更新同一计划。" : "",
            recovery.tokenLimited ? "服务返回了输出长度限制标记。请减少重复思考，继续输出尚未提供的实际答案；不要把被截断的输出当成已完成。" : "",
            recovery.toolFailure ? `本轮结束调用之前的实际工具失败：${recovery.toolFailure}。请先根据真实失败结果修复或说明无法完成的原因，再输出经结果核实的最终答复；不要重复之前未经验证的成功声明。` : "",
            "下一轮必须产生实际用户可见的结果或可执行工具输出。思考中的工具意图不会被执行，思考本身也不会替代最终答案。",
            `错误类型：${diagnostics.issue}`,
            `错误位置：${diagnostics.location}`,
            `修复建议：${diagnostics.suggestion}`,
            recovery.malformedProtocol ? (evidence ? `本次错误的工具调用具体内容：\n${evidence}` : `本次模型原始响应：\n${String(rawText || "").trim().slice(0, 4000) || "（空响应）"}`) : ""
        ].filter(Boolean).join("\n\n");
        chat.messages.push({
            role: "tool",
            name: "agent_protocol",
            toolName: "agent_protocol",
            arguments: {},
            hidden: true,
            status: "done",
            result: { success: true, protocolCorrection: true, error: errorText, diagnostics, evidence },
            content: errorText,
            toolId: `${chat.id}-${Date.now()}-${agentToolSequence += 1}`
        });
        const message = chat.messages[chat.messages.length - 1];
        await persistAgentToolMessage(chat, message);
    }

    async function requestAgentLoop(model, chat, options = {}) {
        if (!chat?.agentEnabled) return requestAI("", model, chat);
        if (isAgentTaskRunning()) {
            options.onReady?.(false);
            return;
        }
        // Reserve the active chat before awaiting IPC so a second send or chat
        // switch cannot start a competing task during workspace validation.
        agentTaskChatId = chat.id;
        agentTaskPreparing = true;
        agentStopRequested = false;
        isGenerating = true;
        if (typeof updateSettingsLocks === "function") updateSettingsLocks();
        let workspaceReady = false;
        try { workspaceReady = await refreshAgentWorkspace(chat); }
        catch (error) { appendLog("error", `Agent 工作区检查失败：${error.message}`); }
        if (!workspaceReady || agentStopRequested || currentAgentChat() !== chat) {
            if (currentAgentChat() === chat) consumeAgentMessages(chat);
            agentTaskChatId = null;
            agentTaskPreparing = false;
            isGenerating = false;
            if (typeof updateSettingsLocks === "function") updateSettingsLocks();
            options.onReady?.(false);
            return;
        }
        agentTaskPreparing = false;
        if (options.onReady?.(true) === false) {
            agentTaskChatId = null;
            isGenerating = false;
            if (typeof updateSettingsLocks === "function") updateSettingsLocks();
            return;
        }
        startAgentTaskTimer();
        chat.agentModel = model;
        window.AIUIEnhancements?.taskStart(chat);
        document.getElementById("stop-btn")?.classList.remove("hidden");
        let invalidResponses = 0;
        let emptyResponses = 0;
        let missingFinalResponses = 0;
        let planOnlyResponses = 0;
        let finishBatchFailures = 0;
        let answerFloorIndex = 0;
        let memoryAllowed = !chat.messages.findLast(message => message?.role === "user")?.agentGatewaySource;
        let pendingMemoryCalls = [];
        let memoryFollowup = false;
        let autoRead;
        const resetUserTurn = gatewayInput => {
            if (gatewayInput) memoryAllowed = false;
            autoRead?.finish(true);
            autoRead = window.beginAutoReadTurn?.(chat);
            pendingMemoryCalls = [];
            memoryFollowup = false;
            invalidResponses = 0;
            emptyResponses = 0;
            missingFinalResponses = 0;
            planOnlyResponses = 0;
            finishBatchFailures = 0;
            answerFloorIndex = chat.messages.reduce((latest, message, index) => message?.role === "user" ? index + 1 : latest, 0);
        };
        const commitMemory = answer => {
            if (!memoryAllowed || agentStopRequested || !pendingMemoryCalls.length || !window.AIUIMemory?.isEnabled()) return;
            try {
                const results = window.AIUIMemory.applyCalls(pendingMemoryCalls);
                const activity = window.AIUIMemory.summarizeResults(results);
                if (activity) answer.memoryActivity = activity;
            } catch (_) { appendLog("warn", "无法保存本轮 Agent 记忆"); }
        };
        const latestVisibleAnswer = () => {
            for (let index = chat.messages.length - 1; index >= answerFloorIndex; index -= 1) {
                const message = chat.messages[index];
                if (message?.role === "user") break;
                // A prior status update cannot become the final answer after
                // subsequent real work. Plans and protocol reminders do not
                // change the result, but every other tool needs fresh prose.
                if (message?.role === "tool" && !["update_plan", "agent_protocol", "finish_task"]
                    .includes(String(message.toolName || message.name || ""))) break;
                if (message?.role === "assistant" && !message.hidden && !message.agentRecovery && !message.failed
                    && String(message.content || "").trim()
                    && !ToolCallNormalizer.hasMalformedToolCall(message.content)
                    && AgentProtocol.stripToolCallsForDisplay(message.content)) return message;
            }
            return null;
        };
        const appendSpokenAgentText = (text, final, insertAt = null) => {
            const message = appendAgentVisibleText(chat, text, model, "", final, insertAt);
            if (message && autoRead) {
                autoRead.update(message, window.getTextVoiceMessageKey(chat.id, insertAt ?? (chat.messages.length - 1)));
            }
            return message;
        };
        resetUserTurn();
        let compactionCheckedAt = 0;
        let queuedCount = 0;
        try {
            while (!agentStopRequested) {
                // Check the context budget once per user-visible turn boundary rather
                // than on every internal loop iteration.
                if (Date.now() - compactionCheckedAt > 3000) {
                    compactionCheckedAt = Date.now();
                    await compactAgentContextIfNeeded(chat);
                    if (agentStopRequested) break;
                }
                const queued = consumeAgentMessages(chat);
                if (queued.count) resetUserTurn(queued.gatewayInput);
                queuedCount += queued.count;
                const reply = await requestAgentModelWithRetry(chat, model, { memoryAllowed, memoryFollowup, queuedCount });
                if (!reply || agentStopRequested) continue;
                queuedCount = 0;
                const { result, thinkingRow } = reply;
                const parseOptions = {
                    enhanced: localStorage.getItem('developer_mode') === 'true' && localStorage.getItem('enhanced_tool_parser') === 'true'
                };
                result.text = stripAgentMemoryProtocol(result.text, parseOptions);
                completeAgentThinking(chat, model, thinkingRow, result);
                const nativeMemoryCalls = result.memoryCalls.filter(isAgentMemoryCall);
                const rawParsed = ToolCallNormalizer.parseAgentResponse(result.text, result.toolCalls.filter(call => !isAgentMemoryCall(call)), parseOptions);
                const parsed = {
                    ...rawParsed,
                    calls: ToolCallNormalizer.canonicalizeToolCalls(rawParsed.calls),
                    segments: rawParsed.segments.map(segment =>
                        segment.type === "tool_call" ? { ...segment, call: ToolCallNormalizer.canonicalizeToolCall(segment.call) } : segment
                    )
                };
                if (parsed.calls.length > MAX_TOOL_CALLS_PER_RESPONSE) {
                    throw new Error(`单次模型回复包含 ${parsed.calls.length} 个工具调用，超过 30 个上限，Agent 已终止`);
                }
                if (nativeMemoryCalls.length && !parsed.hasMalformedToolCall && !result.completion?.tokenLimited) {
                    pendingMemoryCalls.push(...nativeMemoryCalls.slice(0, MAX_TOOL_CALLS_PER_RESPONSE - pendingMemoryCalls.length));
                    if (!parsed.text && !parsed.calls.length && !memoryFollowup) {
                        memoryFollowup = true;
                        continue;
                    }
                }
                if (!parsed.calls.length || parsed.hasMalformedToolCall) {
                    planOnlyResponses = 0;
                    const responseText = parsed.hasMalformedToolCall
                        ? ""
                        : String(parsed.text || "").trim();
                    const visibleResponse = responseText && !parsed.hasMalformedToolCall
                        ? appendSpokenAgentText(responseText, !result.completion?.tokenLimited) : null;
                    if (visibleResponse && !result.completion?.tokenLimited) {
                        const finishMessage = {
                            role: "tool",
                            name: "finish_task",
                            toolName: "finish_task",
                            arguments: {},
                            status: "done",
                            result: { success: true, implicit: true },
                            content: JSON.stringify({ success: true, implicit: true }),
                            toolId: `${chat.id}-${Date.now()}-${agentToolSequence += 1}`
                        };
                        chat.messages.push(finishMessage);
                        await persistAgentToolMessage(chat, finishMessage);
                        commitMemory(visibleResponse);
                        break;
                    }
                    const isEmptyResponse = !parsed.hasMalformedToolCall && (!visibleResponse || result.completion?.tokenLimited);
                    if (isEmptyResponse) {
                        emptyResponses += 1;
                        invalidResponses = 0;
                        if (emptyResponses >= MAX_CONSECUTIVE_EMPTY_RESPONSES) {
                            const cause = result.completion?.tokenLimited ? "输出因长度限制提前结束"
                                : result.reasoning ? "只返回思考，未提供实际答复" : "未提供可显示的正文或可执行工具";
                            appendAgentRecoveryStatus(chat, `模型连续 ${MAX_CONSECUTIVE_EMPTY_RESPONSES} 次${cause}，本轮任务未完成。请重试或检查当前模型接口。`, model, true);
                            break;
                        }
                        const cause = result.completion?.tokenLimited ? "模型输出因长度限制提前结束"
                            : result.reasoning ? "模型只返回了思考，尚未提供实际答复" : "模型尚未返回可显示的正文或可执行工具";
                        appendAgentRecoveryStatus(chat, `${cause}，正在请求实际输出（${emptyResponses}/${MAX_CONSECUTIVE_EMPTY_RESPONSES}）。`, model);
                    } else {
                        emptyResponses = 0;
                        invalidResponses += 1;
                    }
                    if (invalidResponses >= MAX_CONSECUTIVE_INVALID_RESPONSES) {
                        appendAgentRecoveryStatus(chat, "模型连续返回无法执行的工具协议，本轮任务未完成。请重试或检查模型兼容性。", model, true);
                        break;
                    }
                    await requestAgentProtocolCorrection(chat, model, result.text, {
                        malformedProtocol: Boolean(parsed.hasMalformedToolCall),
                        reasoningOnly: Boolean(result.reasoning) && !ToolCallNormalizer.stripReasoningSections(String(result.text || "")).trim(),
                        tokenLimited: result.completion?.tokenLimited
                    });
                    continue;
                }
                invalidResponses = 0;
                emptyResponses = 0;
                const finishSegmentIndex = parsed.segments.findIndex(segment => segment.type === "tool_call" && segment.call?.name === "finish_task");
                const trailingFinalText = finishSegmentIndex >= 0
                    ? parsed.segments.slice(finishSegmentIndex + 1)
                        .filter(segment => segment.type === "text")
                        .map(segment => segment.text)
                        .join("\n\n")
                    : "";
                let finalTextAdded = false;
                let lastVisibleText = null;
                let retryMissingFinal = false;
                const deferredAnswerSegments = [];
                const deferAnswer = finishSegmentIndex >= 0 && parsed.segments.slice(0, finishSegmentIndex)
                    .some(segment => segment.type === "tool_call");
                // Tool rows are rendered immediately in segment order so the transcript
                // stays readable, then executed as one batch (reads in parallel).
                const pendingToolItems = [];
                for (let index = 0; index < parsed.segments.length; index += 1) {
                    const segment = parsed.segments[index];
                    if (segment.type === "text") {
                        const nextSegment = parsed.segments[index + 1];
                        const isFinalText = !trailingFinalText && nextSegment?.type === "tool_call" && nextSegment.call?.name === "finish_task";
                        if (deferAnswer) {
                            deferredAnswerSegments.push({ text: segment.text, final: isFinalText, position: chat.messages.length });
                            endAgentActivityBlock();
                            continue;
                        }
                        const displayed = appendSpokenAgentText(segment.text, isFinalText);
                        if (displayed) lastVisibleText = displayed;
                        if (isFinalText && displayed) finalTextAdded = true;
                        continue;
                    }
                    const call = segment.call;
                    if (call.name === "finish_task") {
                        // Reads emitted before finish_task still run; the model may batch
                        // its last inspections with the terminal call.
                        if (!(await executeAgentToolBatch(chat, pendingToolItems))) return;
                        const failedTools = pendingToolItems.filter(item => item.message.status === "error" || item.message.result?.success === false);
                        pendingToolItems.length = 0;
                        if (failedTools.length) {
                            pendingMemoryCalls = [];
                            finishBatchFailures += 1;
                            const failedNames = [...new Set(failedTools.map(item => item.call.name))].join("、");
                            const rejectedFinish = prepareAgentToolMessage(chat, call);
                            await finalizeAgentToolResult(chat, call, rejectedFinish, { success: false, incomplete: true,
                                error: `本轮实际工具失败（${failedNames}），未接受未经结果核实的结束请求` });
                            const exhausted = finishBatchFailures >= MAX_CONSECUTIVE_INVALID_RESPONSES;
                            appendAgentRecoveryStatus(chat, exhausted
                                ? `实际工具连续执行失败（${failedNames}），本轮任务未完成。请检查失败信息后重试。`
                                : `实际工具执行失败（${failedNames}），此前的成功声明尚未验证，正在请求根据失败结果重新处理。`, model, exhausted);
                            // A stale answer from before this failure cannot justify
                            // a later bare finish. Require a fresh result explanation.
                            answerFloorIndex = chat.messages.length;
                            if (exhausted) return;
                            await requestAgentProtocolCorrection(chat, model, result.text, { toolFailure: failedNames });
                            retryMissingFinal = true;
                            break;
                        }
                        let inserted = 0;
                        for (const segment of deferredAnswerSegments) {
                            const displayed = appendSpokenAgentText(segment.text, segment.final, segment.position + inserted);
                            if (displayed) {
                                lastVisibleText = displayed;
                                inserted += 1;
                            }
                            if (segment.final && displayed) finalTextAdded = true;
                        }
                        if (trailingFinalText) {
                            const displayed = appendSpokenAgentText(trailingFinalText, true);
                            if (displayed) { lastVisibleText = displayed; finalTextAdded = true; }
                        }
                        const existingAnswer = lastVisibleText || latestVisibleAnswer();
                        if (!finalTextAdded && existingAnswer) {
                            existingAnswer.agentFinal = true;
                            existingAnswer.agentSegment = false;
                            finalTextAdded = true;
                        }
                        if (!finalTextAdded) {
                            missingFinalResponses += 1;
                            const rejectedFinish = prepareAgentToolMessage(chat, call);
                            await finalizeAgentToolResult(chat, call, rejectedFinish, { success: false, incomplete: true,
                                error: "模型未提供实际最终答复，未接受本次结束请求" });
                            if (missingFinalResponses >= MAX_CONSECUTIVE_INVALID_RESPONSES) {
                                appendAgentRecoveryStatus(chat, "模型反复请求结束任务，但没有提供可显示的最终答复，本轮任务未完成。请重试或更换兼容模型。", model, true);
                                return;
                            }
                            appendAgentRecoveryStatus(chat, `模型发出了结束信号，但尚未提供最终答复，正在请求补全（${missingFinalResponses}/${MAX_CONSECUTIVE_INVALID_RESPONSES}）。`, model);
                            await requestAgentProtocolCorrection(chat, model, result.text, { missingFinal: true,
                                reasoningOnly: Boolean(result.reasoning) && !ToolCallNormalizer.stripReasoningSections(String(result.text || "")).trim(),
                                tokenLimited: result.completion?.tokenLimited });
                            retryMissingFinal = true;
                            break;
                        }
                        const finishMessage = {
                            role: "tool",
                            name: "finish_task",
                            toolName: "finish_task",
                            arguments: {},
                            status: "done",
                            result: { success: true },
                            content: JSON.stringify({ success: true }),
                            toolId: `${chat.id}-${Date.now()}-${agentToolSequence += 1}`
                        };
                        finishMessage.taskDurationMs = finishAgentTaskTimer(chat, finishMessage);
                        chat.messages.push(finishMessage);
                        await persistAgentToolMessage(chat, finishMessage);
                        commitMemory(existingAnswer);
                        chat.updatedAt = Date.now();
                        persistAgentChats();
                        return;
                    }
                    pendingToolItems.push({ call, message: prepareAgentToolMessage(chat, call) });
                }
                if (retryMissingFinal) continue;
                if (!(await executeAgentToolBatch(chat, pendingToolItems))) return;
                if (agentStopRequested) return;
                if (parsed.calls.every(call => call.name === "update_plan")) {
                    planOnlyResponses += 1;
                    if (planOnlyResponses >= MAX_CONSECUTIVE_INVALID_RESPONSES) {
                        appendAgentRecoveryStatus(chat, "模型反复更新计划，但没有执行实际工作或提供最终答复，本轮任务未完成。请重试。", model, true);
                        return;
                    }
                    if (planOnlyResponses >= 2) await requestAgentProtocolCorrection(chat, model, result.text, { planOnly: true });
                } else planOnlyResponses = 0;
            }
        } catch (error) {
            autoRead?.finish(true);
            if (error?.name !== "AbortError" && !agentStopRequested) {
                window.AIUIEnhancements?.failed(chat);
                appendLog("error", `Agent Loop 出错：${error.message}`);
                chat.messages.push({ role: "assistant", content: `Agent 执行失败：${error.message}`, model, agentFinal: true, failed: true });
                persistAgentChats();
            }
        } finally {
            autoRead?.finish(agentStopRequested);
            hideVoiceNotification();
            if (agentStopRequested && !chat.messages.at(-1)?.agentFinal) {
                chat.messages.push({ role: "assistant", content: "Agent 已停止。", model, agentDisplayOnly: true, agentRecovery: true, agentSegment: true });
                persistAgentChats();
            }
            if (agentTaskStartedAt) finishAgentTaskTimer(chat);
            if (agentStopRequested) consumeAgentMessages(chat);
            abortController = null;
            isGenerating = false;
            agentTaskChatId = null;
            agentTaskPreparing = false;
            liveToolBlocks.clear();
            window.AIUIEnhancements?.taskEnd(chat);
            persistAgentChats();
            if (typeof updateSettingsLocks === "function") updateSettingsLocks();
            document.getElementById("send-btn")?.classList.remove("hidden");
            document.getElementById("stop-btn")?.classList.add("hidden");
            renderChatHistory();
            await renderMessagesWithResolvedRefs(chat.messages);
            updateAgentUIForChat(chat);
            if (!agentStopRequested && getQueuedAgentMessages(chat.id).length) {
                setTimeout(() => {
                    if (currentAgentChat() === chat && !isGenerating) void requestAgentLoop(model, chat);
                }, 0);
            }
        }
    }

    function submitGatewayAgentMessage(request = {}) {
        const chat = currentAgentChat();
        const text = typeof request.text === "string" ? request.text.trim() : "";
        const reject = error => Promise.resolve({ accepted: false, error });
        const expired = () => Number.isFinite(request.expiresAt) && Date.now() > request.expiresAt;
        if (expired()) return reject("消息投递已超时，请刷新后重试");
        if (request.device?.role !== "write") return reject("该设备没有追加消息权限");
        if (!chat?.agentEnabled || String(request.chatId || "") !== String(chat.id)) {
            return reject("电脑端当前会话已改变，请刷新后重试");
        }
        if (!text || text.length > 8000) return reject("消息须为 1 至 8000 个字符");
        if (contextCompactionRunning || isImageMode || window._audioChatRunning || window._desktopWorkRunning) {
            return reject("电脑端正在执行其他操作，请稍后重试");
        }
        if (agentTaskPreparing || (isGenerating && !isAgentTaskRunning(chat.id))) {
            return reject("电脑端正在准备任务，请稍后重试");
        }
        if (agentStopRequested && isAgentTaskRunning(chat.id)) return reject("Agent 正在停止，请稍后重试");
        if (window.queuedAgentMessages.length >= 20) {
            return reject("待处理消息已达上限，请等待 Agent 处理");
        }
        const queueText = () => {
            queueAgentMessage(chat, text, [], true);
            if (!chat.messages.length) {
                chat.title = text.slice(0, 20);
                setActiveChatTitle(chat);
            }
        };
        if (isAgentTaskRunning(chat.id)) {
            if (expired()) return reject("消息投递已超时，请刷新后重试");
            queueText();
            return Promise.resolve({ accepted: true, queued: true });
        }
        const model = document.getElementById("model-select")?.value;
        if (!model) return reject("请先在电脑端选择模型");
        // The original Agent queue consumes plain task text. It never touches the
        // local composer or interprets /compact, /canvas and other UI commands.
        return new Promise(resolve => {
            requestAgentLoop(model, chat, {
                onReady: ready => {
                    if (!ready) { resolve({ accepted: false, error: "电脑端工作区不可用或任务已取消" }); return; }
                    if (expired()) { resolve({ accepted: false, error: "消息投递已超时，请刷新后重试" }); return false; }
                    queueText();
                    resolve({ accepted: true, queued: false });
                    return true;
                }
            }).catch(() => resolve({ accepted: false, error: "电脑端未能启动 Agent 任务" }));
        });
    }

    function stopAgentTask() {
        agentStopRequested = true;
        agentQuestionResolver?.({ success:true,cancelled:true,answers:{} });
        if (Array.isArray(window.queuedAgentMessages)) {
            let cancelled = 0;
            for (let index = window.queuedAgentMessages.length - 1; index >= 0; index -= 1) {
                const entry = window.queuedAgentMessages[index];
                if (entry && typeof entry === "object" && entry.gatewayChatId) {
                    window.queuedAgentMessages.splice(index, 1);
                    cancelled += 1;
                }
            }
            if (cancelled) {
                placeAgentTaskFooter();
                showVoiceNotification(`已取消 ${cancelled} 条待处理远程消息`, false, 3000);
            }
        }
        agentModelController?.abort();
        if (abortController) abortController.abort();
        for (const executionId of agentShellProgressByExecution.keys()) {
            window.electronAPI?.cancelAgentExecution?.(executionId).catch(() => {});
        }
        // Servers and watchers belong to the task that started them; stopping the
        // task must not leave them holding ports in the background.
        window.electronAPI?.stopAllAgentProcesses?.().catch(() => {});
        resolveAgentCommandApproval("reject");
        resolveAgentYoloWarning(false);
    }

    async function populateAgentSettings() {
        const diffMaxLines = document.getElementById("agent-diff-max-lines");
        const detailBehavior = document.getElementById("agent-detail-default-behavior");
        const shellTimeout = document.getElementById("agent-shell-timeout-seconds");
        const imageDetail = document.getElementById("agent-view-image-detail");
        const searchEngine = document.getElementById("agent-search-engine");
        const messageInsertion = document.getElementById("agent-message-insertion");
        if (diffMaxLines) diffMaxLines.value = String(getAgentDiffMaxLines());
        if (detailBehavior) detailBehavior.value = getAgentDetailDefaultBehavior();
        if (shellTimeout) shellTimeout.value = String(Math.round(getAgentShellTimeoutMs() / 1000));
        if (imageDetail) imageDetail.value = localStorage.getItem("agent_view_image_detail") || "medium";
        if (searchEngine) searchEngine.value = getAgentSearchEngine();
        if (messageInsertion) messageInsertion.value = getAgentMessageInsertion();
        if (!window.electronAPI?.getAgentCommandSettings) return;
        try {
            const settings = await window.electronAPI.getAgentCommandSettings();
            const defaults = document.getElementById("agent-default-commands");
            const additions = document.getElementById("agent-command-additions");
            if (defaults) defaults.value = (settings.defaults || []).join("\n");
            if (additions) additions.value = (settings.additions || []).join("\n");
        } catch (error) {
            showVoiceNotification(`Agent 命令设置读取失败：${error.message}`, true, 4000);
        }
    }

    async function saveAgentCommandSettings() {
        const diffMaxLines = document.getElementById("agent-diff-max-lines");
        const detailBehavior = document.getElementById("agent-detail-default-behavior");
        const shellTimeout = document.getElementById("agent-shell-timeout-seconds");
        const imageDetail = document.getElementById("agent-view-image-detail");
        const searchEngine = document.getElementById("agent-search-engine");
        const messageInsertion = document.getElementById("agent-message-insertion");
        const selectedDiffLimit = Number(diffMaxLines?.value);
        localStorage.setItem("agent_diff_max_lines", String([10, 20, 50, 0].includes(selectedDiffLimit) ? selectedDiffLimit : DEFAULT_AGENT_DIFF_MAX_LINES));
        localStorage.setItem("agent_detail_default_behavior", detailBehavior?.value === "collapsed" ? "collapsed" : "expanded");
        const requestedSeconds = Number(shellTimeout?.value);
        const timeoutSeconds = Number.isFinite(requestedSeconds)
            ? Math.min(Math.max(Math.round(requestedSeconds), 5), 3600)
            : DEFAULT_AGENT_SHELL_TIMEOUT_SECONDS;
        localStorage.setItem("agent_shell_timeout_seconds", String(timeoutSeconds));
        localStorage.setItem("agent_view_image_detail", ["low", "medium", "high", "original"].includes(imageDetail?.value) ? imageDetail.value : "medium");
        localStorage.setItem("agent_search_engine", searchEngine?.value === "duckduckgo" ? "duckduckgo" : "bing");
        if (messageInsertion) localStorage.setItem("agent_message_insertion", messageInsertion.value === "interrupt" ? "interrupt" : "queue");
        if (!window.electronAPI?.saveAgentCommandAdditions) return;
        const additions = document.getElementById("agent-command-additions")?.value || "";
        try {
            await window.electronAPI.saveAgentCommandAdditions(additions);
        } catch (error) {
            showVoiceNotification(`Agent 命令设置保存失败：${error.message}`, true, 4000);
        }
    }

    function initializeAgentUI() {
        if (window.electronAPI?.onAgentShellProgress) {
            agentShellProgressUnsubscribe = window.electronAPI.onAgentShellProgress(progress => {
                const current = agentShellProgressByExecution.get(progress?.executionId);
                if (!current) return;
                current.stdoutBytes = progress.stdoutBytes;
                current.stderrBytes = progress.stderrBytes;
            });
        }
        hydrateAgentToolResults().then(() => {
            if (activeChatId) {
                const chat = chats.find(item => item.id === activeChatId);
                if (chat?.agentEnabled) renderMessagesWithResolvedRefs(chat.messages);
            }
        });
        const chat = currentAgentChat();
        if (chat) updateAgentUIForChat(chat);
    }

    const originalOnload = window.onload;
    window.onload = async function (event) {
        if (typeof originalOnload === "function") await originalOnload(event);
        if (!new URLSearchParams(location.search).has('preferences')) initializeAgentUI();
    };

    window.isAgentTaskRunning = isAgentTaskRunning;
    window.persistAgentChats = persistAgentChats;
    window.stopAgentTask = stopAgentTask;
    window.enterAgentMode = enterAgentMode;
    window.updateAgentUIForChat = updateAgentUIForChat;
    window.ensureAgentWorkspaceAvailable = refreshAgentWorkspace;
    window.resolveAgentCommandApproval = resolveAgentCommandApproval;
    window.onAgentCommandModeChange = onAgentCommandModeChange;
    window.resolveAgentWorkspaceTrust = resolveAgentWorkspaceTrust;
    window.resolveAgentYoloWarning = resolveAgentYoloWarning;
    window.appendAgentToolMessageToUI = appendAgentToolMessageToUI;
    window.appendAgentQuestionAnswerToUI = appendAgentQuestionAnswerToUI;
    window.captureAgentActivityView = captureAgentActivityView;
    window.endAgentActivityBlock = endAgentActivityBlock;
    window.appendAgentFinishStatus = appendFinishTaskToFinalRow;
    window.appendResponseActivity = appendResponseActivity;
    window.appendResponseDuration = appendResponseDuration;
    window.appendAgentTaskDuration = appendAgentTaskDuration;
    window.placeAgentTaskFooter = placeAgentTaskFooter;
    window.appendAgentRoundSummaryUI = appendAgentRoundSummaryUI;
    window.appendAgentThinkingMessageToUI = appendAgentThinkingMessageToUI;
    window.populateAgentSettings = populateAgentSettings;
    window.saveAgentCommandSettings = saveAgentCommandSettings;
    window.requestAgentLoop = requestAgentLoop;
    window.getQueuedAgentMessageCount = chatId => getQueuedAgentMessages(chatId).length;
    window.queueAgentUserMessage = (chat, content, attachments) => {
        if (!chat || !isAgentTaskRunning(chat.id) || agentStopRequested) return false;
        queueAgentMessage(chat, content, attachments);
        return true;
    };
    window.buildAgentMessagesForContextEstimate = chat => buildAgentMessages(chat, { estimateOnly: true });
    window.submitGatewayAgentMessage = submitGatewayAgentMessage;
    window.getAgentStoredResult = key => agentResultStore.get(key);
    // The gateway reads only the active reasoning text, never raw model payloads.
    window.getGatewayAgentThinkingState = () => agentLiveThinkingRow && agentTaskChatId ? {
        chatId: String(agentTaskChatId), id: agentLiveThinkingRow.gatewayThinkingId,
        reasoning: agentLiveThinkingRow.reasoningText,
        durationMs: Math.max(0, Date.now() - agentLiveThinkingRow.thinkingStartedAt), status: "running"
    } : null;
})();
