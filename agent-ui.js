(function () {
    const MAX_TOOL_CALLS_PER_RESPONSE = 30;
    const MAX_CONSECUTIVE_EMPTY_RESPONSES = 3;
    const MAX_CONSECUTIVE_INVALID_RESPONSES = 3;
    const DEFAULT_AGENT_DIFF_MAX_LINES = 10;
    const DEFAULT_AGENT_SHELL_TIMEOUT_SECONDS = 120;
    const TOOL_ICONS = {
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
    const TOOL_LABELS = {
        read_file_range: "读取",
        write_file: "写入",
        edit_file: "编辑",
        multi_edit_file: "批量编辑",
        run_shell: "运行",
        start_process: "启动进程",
        read_process_output: "读取进程输出",
        stop_process: "停止进程",
        list_processes: "进程列表",
        finish_task: "完成任务",
        agent_protocol: "协议提示",
        list_dir: "列目录",
        glob_files: "查找文件",
        grep_files: "搜索",
        delete_path: "删除",
        move_path: "移动",
        copy_path: "复制",
        view_image: "查看图片",
        update_plan: "更新计划",
        _claude_insert_text: "插入文本",
        _claude_undo_edit: "撤销编辑",
        _codex_apply_patch: "应用补丁"
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
    let agentLiveThinkingRow = null;
    let agentThinkingSequence = 0;
    let agentStopRequested = false;
    let agentApprovalResolver = null;
    let agentApprovalRow = null;
    let agentApprovalPrefix = "";
    let agentWorkspaceTrustResolver = null;
    let agentYoloResolver = null;
    let agentCommandMode = "safe";
    let agentToolSequence = 0;
    let agentCurrentExecutionId = "";
    let agentShellProgressUnsubscribe = null;
    let agentTaskStartedAt = 0;
    let agentTaskTimer = null;
    let agentActiveStatusRow = null;
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

    function persistAgentChats() {
        const serializable = chats.map(chat => {
            if (!chat?.agentEnabled) return chat;
            const copy = JSON.parse(JSON.stringify(chat));
            if (Array.isArray(copy.messages)) {
                copy.messages = copy.messages.map(message => {
                    if (message?.role !== "tool" || !message.contentRef || typeof message.content !== "string") return message;
                    return { ...message, content: "" };
                });
            }
            return copy;
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
        agentCommandMode = "safe";
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
        if (input) input.placeholder = chat?.agentEnabled ? "向 Agent 描述任务..." : "给 AI 发送消息...   支持附件 | /canvas 编码模式 | /compact 压缩上下文";
        updateAttachMenuButtons();
        if (chat?.agentEnabled) refreshAgentWorkspace(chat).catch(() => {});
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
            const preview = Array.isArray(selection?.textFilePreview) ? selection.textFilePreview.slice(0, 5) : [];
            const totalCount = Math.max(Number(selection?.textFileCount) || 0, preview.length);
            if (preview.length === 0) {
                const item = document.createElement("li");
                item.textContent = "未检测到 .txt 或 .md 文件";
                fileList.appendChild(item);
            } else {
                for (const filePath of preview) {
                    const item = document.createElement("li");
                    item.textContent = String(filePath);
                    fileList.appendChild(item);
                }
                const remaining = totalCount - preview.length;
                if (remaining > 0) {
                    const item = document.createElement("li");
                    item.textContent = `剩余${remaining}个……`;
                    fileList.appendChild(item);
                }
            }
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
        if (value !== "yolo") {
            agentCommandMode = "safe";
            return;
        }
        const confirmed = await requestAgentYoloWarning();
        if (!confirmed) {
            agentCommandMode = "safe";
            const select = document.getElementById("agent-command-mode-select");
            if (select) select.value = "safe";
            return;
        }
        agentCommandMode = "yolo";
    }

    function resolveAgentCommandApproval(decision) {
        const row = agentApprovalRow;
        agentApprovalRow = null;
        if (row) {
            row.classList.add("leaving");
            setTimeout(() => row.remove(), 160);
        }
        const resolver = agentApprovalResolver;
        agentApprovalResolver = null;
        if (resolver) resolver(decision);
    }

    function requestAgentCommandApproval(command, suggestedPrefix) {
        const wrapper = document.getElementById("messages-wrapper");
        if (!wrapper) return Promise.resolve("reject");
        const row = document.createElement("div");
        row.className = "chat-row agent-tool-row-wrapper agent-command-approval-row";
        row.setAttribute("role", "alert");
        row.setAttribute("aria-live", "assertive");
        row.innerHTML = `<div class="agent-tool-row agent-command-approval-tool"><div class="agent-tool-summary"><i data-lucide="shield-alert"></i><span>Agent 请求运行非白名单命令</span></div><div class="agent-command-code"></div><div class="agent-command-actions"><button type="button" class="border border-gray-600 text-gray-300 hover:bg-gray-800" onclick="resolveAgentCommandApproval('reject')">拒绝</button><button type="button" class="border border-gray-600 text-gray-200 hover:bg-gray-800" onclick="resolveAgentCommandApproval('allow')">允许</button><button type="button" class="text-white" style="background:var(--accent-strong)" onclick="resolveAgentCommandApproval('always')">始终允许</button></div></div>`;
        const commandEl = row.querySelector(".agent-command-code");
        commandEl.textContent = command;
        agentApprovalPrefix = String(suggestedPrefix || "").trim();
        agentApprovalRow = row;
        wrapper.appendChild(row);
        lucide.createIcons();
        wrapper.scrollTop = wrapper.scrollHeight;
        return new Promise(resolve => {
            agentApprovalResolver = resolve;
        });
    }

    function formatAgentWorkingTime(milliseconds, completed = false) {
        const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
        return completed ? `worked for ${seconds}s` : `working for ${seconds}s...`;
    }

    function currentAgentTaskDuration() {
        return agentTaskStartedAt ? Date.now() - agentTaskStartedAt : 0;
    }

    function updateAgentTaskTimer() {
        const elapsed = agentActiveStatusRow?.querySelector(".agent-working-time");
        if (elapsed) elapsed.textContent = formatAgentWorkingTime(currentAgentTaskDuration());
    }

    function setAgentActiveStatusRow(row) {
        if (agentActiveStatusRow && agentActiveStatusRow !== row) {
            const previous = agentActiveStatusRow.querySelector(".agent-working-time");
            if (previous) previous.textContent = "";
        }
        agentActiveStatusRow = row || null;
        updateAgentTaskTimer();
    }

    function startAgentTaskTimer() {
        if (agentTaskTimer) clearInterval(agentTaskTimer);
        agentTaskStartedAt = Date.now();
        agentActiveStatusRow = null;
        agentTaskTimer = setInterval(updateAgentTaskTimer, 1000);
    }

    function finishAgentTaskTimer(chat, targetMessage = null) {
        const durationMs = currentAgentTaskDuration();
        if (agentTaskTimer) clearInterval(agentTaskTimer);
        agentTaskTimer = null;
        agentTaskStartedAt = 0;
        const elapsed = agentActiveStatusRow?.querySelector(".agent-working-time");
        if (elapsed) elapsed.textContent = formatAgentWorkingTime(durationMs, true);
        const persistedTarget = targetMessage || [...(chat?.messages || [])].reverse().find(message => message?.role === "tool");
        if (persistedTarget && !persistedTarget.taskDurationMs) persistedTarget.taskDurationMs = durationMs;
        agentActiveStatusRow = null;
        return durationMs;
    }

    function appendAgentThinkingRow(text = "Agent 正在考虑下一步决策", options = {}) {
        const wrapper = document.getElementById("messages-wrapper");
        const row = document.createElement("div");
        row.className = "chat-row agent-tool-row-wrapper agent-thinking-row";
        const running = options.running !== false;
        row.innerHTML = `<div class="agent-tool-row${running ? " running" : ""}"><div class="agent-tool-summary"><i data-lucide="bot"></i><span class="agent-tool-summary-text">${escapeHtml(text)}</span><span class="agent-working-time"></span><i class="agent-tool-toggle" data-lucide="chevron-down"></i></div><div class="agent-tool-preview"><div class="agent-tool-preview-content"><div class="thinking-text"></div></div></div></div>`;
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
                toolRow.classList.toggle("collapsed", getAgentDetailDefaultBehavior() === "collapsed");
                row.dataset.detailInitialized = "true";
            }
            summary.setAttribute("aria-expanded", String(hasReasoning && !toolRow.classList.contains("collapsed")));
        };
        row.finishThinking = durationMs => {
            if (agentLiveThinkingRow === row) agentLiveThinkingRow = null;
            if (!row.reasoningText) {
                if (agentActiveStatusRow === row) setAgentActiveStatusRow(null);
                row.remove();
                return false;
            }
            const seconds = Math.max(0, Math.round(Number(durationMs || 0) / 1000));
            toolRow.classList.remove("running");
            row.querySelector(".agent-tool-summary-text").textContent = `思考了${seconds}秒`;
            const elapsed = row.querySelector(".agent-working-time");
            if (elapsed) elapsed.textContent = "";
            if (agentActiveStatusRow === row) setAgentActiveStatusRow(null);
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
        wrapper.appendChild(row);
        if (options.reasoning) row.updateReasoning(options.reasoning);
        if (!running) row.finishThinking(options.durationMs);
        lucide.createIcons();
        if (running && options.activate !== false) setAgentActiveStatusRow(row);
        wrapper.scrollTop = wrapper.scrollHeight;
        return row;
    }

    function appendAgentThinkingMessageToUI(message) {
        if (!message?.reasoning) return null;
        return appendAgentThinkingRow("", {
            running: false,
            activate: false,
            reasoning: message.reasoning,
            durationMs: message.thinkingDurationMs,
            gatewayThinkingId: message.gatewayThinkingId
        });
    }

    function appendAgentEndpointFallbackRow(info) {
        const wrapper = document.getElementById("messages-wrapper");
        if (!wrapper) return null;
        const row = document.createElement("div");
        row.className = "chat-row agent-tool-row-wrapper agent-endpoint-fallback-row";
        row.innerHTML = `<div class="agent-tool-row warning running"><div class="agent-tool-summary"><i data-lucide="route"></i><span class="agent-tool-summary-text">接口返回 501，正在转接至 ${escapeHtml(info?.to || "备用接口")}</span><span class="agent-working-time"></span></div></div>`;
        wrapper.appendChild(row);
        lucide.createIcons();
        setAgentActiveStatusRow(row);
        wrapper.scrollTop = wrapper.scrollHeight;
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
        if (message.toolName === "write_file" || message.toolName === "edit_file") {
            const diff = message.displayDiff || message.result.displayDiff;
            return truncateAgentDisplayLines(Array.isArray(diff?.lines) ? diff.lines : []);
        }
        if (message.toolName === "run_shell") {
            const output = [
                ...splitAgentDisplayLines(message.result.stdout).map(text => ({ type: "output", text })),
                ...splitAgentDisplayLines(message.result.stderr).map(text => ({ type: "error", text }))
            ];
            return truncateAgentDisplayLines(output);
        }
        if (message.toolName === "list_dir" && message.result?.success) {
            const entries = Array.isArray(message.result.entries) ? message.result.entries : [];
            const lines = entries.map(entry => ({
                type: entry.type === "directory" ? "error" : "output",
                text: `${entry.type === "directory" ? "[DIR] " : "[FILE]"}${entry.path || entry.name}${entry.type === "file" && entry.size ? ` (${entry.size} bytes)` : ""}`
            }));
            if (message.result.hasMore) lines.push({ type: "output", text: `……还有 ${message.result.totalCount - (message.result.offset + entries.length)} 项` });
            return truncateAgentDisplayLines(lines);
        }
        if (message.toolName === "grep_files" && message.result?.success) {
            const matches = Array.isArray(message.result.matches) ? message.result.matches : [];
            const lines = matches.map(match => ({
                type: "output",
                text: `${match.path}:${match.line}: ${String(match.content || "").slice(0, 200)}`
            }));
            if (message.result.truncated) lines.push({ type: "output", text: "……结果已截断" });
            return truncateAgentDisplayLines(lines);
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
        if ((message.toolName === "multi_edit_file" || message.toolName === "_codex_apply_patch") && message.result?.success) {
            const diff = message.displayDiff || message.result.displayDiff;
            return truncateAgentDisplayLines(Array.isArray(diff?.lines) ? diff.lines : []);
        }
        if (message.toolName === "glob_files" && message.result?.success) {
            const items = Array.isArray(message.result.matches) ? message.result.matches : [];
            const lines = items.map(item => ({
                type: "output",
                text: `${item.path}${item.size ? ` (${item.size} bytes)` : ""}`
            }));
            if (message.result.truncated) lines.push({ type: "output", text: "……结果已截断" });
            return truncateAgentDisplayLines(lines);
        }
        if (message.toolName === "web_search" && message.result?.success) {
            const items = Array.isArray(message.result.results) ? message.result.results : [];
            return truncateAgentDisplayLines(items.map(item => ({
                type: "output",
                text: `${item.title}\n${item.url}${item.snippet ? `\n${item.snippet}` : ""}`
            })));
        }
        if (message.toolName === "browse_web" && message.result?.success) {
            return truncateAgentDisplayLines(splitAgentDisplayLines(message.result.text).map(text => ({ type: "output", text })));
        }
        if ((message.toolName === "read_process_output" || message.toolName === "stop_process") && message.result?.success) {
            const output = [
                ...splitAgentDisplayLines(message.result.stdout).map(text => ({ type: "output", text })),
                ...splitAgentDisplayLines(message.result.stderr).map(text => ({ type: "error", text }))
            ];
            return truncateAgentDisplayLines(output);
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

    function renderAgentToolPreview(row, message) {
        const toolRow = row?.querySelector(".agent-tool-row");
        const summary = row?.querySelector(".agent-tool-summary");
        const previewContent = row?.querySelector(".agent-tool-preview-content");
        if (!toolRow || !summary || !previewContent) return;
        const lines = getAgentPreviewLines(message);
        const hadPreview = toolRow.classList.contains("has-preview");
        const wasCollapsed = toolRow.classList.contains("collapsed");
        previewContent.replaceChildren();
        if (message.toolName === "view_image" && message.result?.success && message.result.dataUrl) {
            const img = document.createElement("img");
            img.src = message.result.dataUrl;
            img.alt = message.result.path || "image";
            img.className = "agent-tool-preview-image";
            img.style.maxWidth = "100%";
            img.style.maxHeight = "400px";
            img.style.borderRadius = "6px";
            img.style.marginTop = "8px";
            previewContent.appendChild(img);
        }
        for (const line of lines) {
            const element = document.createElement("div");
            element.className = `agent-tool-preview-line ${line.type || "output"}`;
            element.textContent = String(line.text || "");
            previewContent.appendChild(element);
        }
        const hasImage = message.toolName === "view_image" && message.result?.success && message.result.dataUrl;
        const canToggle = lines.length > 0 || hasImage;
        toolRow.classList.toggle("has-preview", canToggle);
        const shouldCollapse = canToggle && (hadPreview ? wasCollapsed : getAgentDetailDefaultBehavior() === "collapsed");
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

    function formatAgentToolSummary(message) {
        const name = String(message?.toolName || "");
        const args = toolArguments(message);
        const status = message?.status || "running";
        if (name === "read_file_range") {
            const pathText = String(args.path || "文件");
            if (status === "running") return `读取${pathText}，${args.start_line ?? "?"}-${args.end_line ?? "?"}行`;
            if (message.result?.success) return `读取${message.result.path || pathText}，${message.result.actualStartLine ?? "?"}-${message.result.actualEndLine ?? "?"}行（实际返回 ${message.result.returnedLines ?? 0} 行）`;
            return `读取${pathText}失败`;
        }
        if (name === "write_file") {
            if (status === "running") return `写入${String(args.path || "文件")}，${String(args.content || "").length}字符`;
            return message.result?.success ? `写入${message.result.path || args.path || "文件"}，${message.result.charactersWritten ?? 0}字符` : `写入${args.path || "文件"}失败`;
        }
        if (name === "edit_file") {
            if (status === "running") return `编辑${String(args.path || "文件")}，等待唯一匹配`;
            return message.result?.success ? `编辑${message.result.path || args.path || "文件"}，已替换 1 处` : `编辑${args.path || "文件"}失败`;
        }
        if (name === "run_shell") {
            const progress = agentShellProgressByExecution.get(message.executionId) || {};
            const result = message.result || {};
            const milliseconds = Math.max(0, Math.round(Number(progress.elapsedMs || result.durationMs || 0)));
            const bytes = Number(progress.stdoutBytes || 0) + Number(progress.stderrBytes || 0) || Number(result.stdoutBytes || 0) + Number(result.stderrBytes || 0);
            if (status === "running") return `运行命令，${milliseconds}毫秒，${bytes}字节`;
            return result.exitCode === 0 && !result.timedOut && !result.cancelled ? `运行命令完成，${milliseconds}毫秒，${bytes}字节（exitCode 0）` : `运行命令结束，${milliseconds}毫秒，${bytes}字节（exitCode ${result.exitCode ?? 1}）`;
        }
        if (name === "finish_task") return "任务完成";
        if (name === "list_dir") {
            const pathText = String(args.dir_path || args.path || ".");
            if (status === "running") return `列目录 ${pathText}`;
            if (message.result?.success) return `列目录 ${message.result.path || pathText}，共 ${message.result.totalCount ?? 0} 项`;
            return `列目录 ${pathText} 失败`;
        }
        if (name === "grep_files") {
            const patternText = String(args.pattern || "");
            if (status === "running") return `搜索 "${patternText}"`;
            if (message.result?.success) return `搜索 "${patternText}"，${message.result.totalCount ?? 0} 处匹配${message.result.truncated ? "（已截断）" : ""}`;
            return `搜索 "${patternText}" 失败`;
        }
        if (name === "view_image") {
            const pathText = String(args.path || "图片");
            if (status === "running") return `查看图片 ${pathText}`;
            if (message.result?.success) return `查看图片 ${message.result.path || pathText}，${message.result.fileSize ? `${(message.result.fileSize / 1024).toFixed(1)} KB` : ""}`;
            return `查看图片 ${pathText} 失败`;
        }
        if (name === "update_plan") {
            if (status === "running") return "更新任务计划";
            if (message.result?.success) {
                const steps = Array.isArray(message.result.plan) ? message.result.plan : [];
                const completed = steps.filter(s => s.status === "completed").length;
                const inProgress = steps.filter(s => s.status === "in_progress").length;
                return `任务计划已更新，${steps.length} 步（完成 ${completed}，进行中 ${inProgress}）`;
            }
            return "更新任务计划失败";
        }
        if (name === "_claude_insert_text") {
            const pathText = String(args.path || "文件");
            if (status === "running") return `插入文本到 ${pathText} 第 ${args.insert_line ?? "?"} 行`;
            return message.result?.success ? `插入文本到 ${pathText} 完成` : `插入文本到 ${pathText} 失败`;
        }
        if (name === "multi_edit_file") {
            const pathText = String(args.path || "文件");
            const count = Array.isArray(args.edits) ? args.edits.length : (args.old_text ? 1 : 0);
            if (status === "running") return `批量编辑${pathText}，${count} 处改动`;
            if (message.result?.success) return `批量编辑${message.result.path || pathText}，已应用 ${message.result.editCount ?? count} 处改动`;
            const failed = Number.isInteger(message.result?.failedIndex) ? `（第 ${message.result.failedIndex + 1} 处失败）` : "";
            return `批量编辑${pathText}失败${failed}，未写入任何改动`;
        }
        if (name === "glob_files") {
            const patternText = String(args.pattern || "");
            if (status === "running") return `查找文件 "${patternText}"`;
            if (message.result?.success) return `查找文件 "${patternText}"，${message.result.totalCount ?? 0} 个结果${message.result.truncated ? "（已截断）" : ""}`;
            return `查找文件 "${patternText}" 失败`;
        }
        if (name === "delete_path") {
            const pathText = String(args.path || "目标");
            if (status === "running") return `删除 ${pathText}`;
            if (message.result?.success) return `已删除 ${message.result.type === "directory" ? "目录" : "文件"} ${message.result.path || pathText}`;
            return `删除 ${pathText} 失败`;
        }
        if (name === "move_path") {
            if (status === "running") return `移动 ${String(args.from || "来源")} → ${String(args.to || "目标")}`;
            if (message.result?.success) return `已移动 ${message.result.from} → ${message.result.to}`;
            return `移动 ${String(args.from || "来源")} 失败`;
        }
        if (name === "copy_path") {
            if (status === "running") return `复制 ${String(args.from || "来源")} → ${String(args.to || "目标")}`;
            if (message.result?.success) return `已复制 ${message.result.from} → ${message.result.to}`;
            return `复制 ${String(args.from || "来源")} 失败`;
        }
        if (name === "web_search") {
            const queryText = String(args.query || "");
            if (status === "running") return `联网搜索 "${queryText}"`;
            if (message.result?.success) {
                const engine = message.result.engine ? `（${message.result.engine}）` : "";
                const fallback = message.result.fellBack ? "，已自动切换引擎" : "";
                return `联网搜索 "${queryText}"${engine}，${message.result.resultCount ?? 0} 条结果${fallback}`;
            }
            return `联网搜索 "${queryText}" 失败`;
        }
        if (name === "browse_web") {
            const urlText = String(args.url || "");
            if (status === "running") return `浏览 ${urlText}`;
            if (message.result?.success) return `浏览 ${message.result.url || urlText}，${String(message.result.text || "").length} 字符`;
            return `浏览 ${urlText} 失败`;
        }
        if (name === "start_process") {
            const commandText = String(args.command || "");
            if (status === "running") return `后台启动：${commandText}`;
            if (message.result?.success) return `后台进程已启动 ${message.result.processId}：${commandText}`;
            return `后台启动失败：${commandText}`;
        }
        if (name === "read_process_output") {
            const idText = String(args.process_id || "");
            if (status === "running") return `读取进程输出 ${idText}`;
            if (message.result?.success) {
                const state = message.result.running ? "运行中" : `已退出（exitCode ${message.result.exitCode ?? "?"}）`;
                return `进程 ${idText} ${state}，输出 ${message.result.stdoutBytes ?? 0}/${message.result.stderrBytes ?? 0} 字节`;
            }
            return `读取进程 ${idText} 输出失败`;
        }
        if (name === "stop_process") {
            const idText = String(args.process_id || "");
            if (status === "running") return `停止进程 ${idText}`;
            return message.result?.success ? `已停止进程 ${idText}` : `停止进程 ${idText} 失败`;
        }
        if (name === "list_processes") {
            if (status === "running") return "列出后台进程";
            if (message.result?.success) {
                const list = Array.isArray(message.result.processes) ? message.result.processes : [];
                const running = list.filter(item => item.running).length;
                return `后台进程 ${list.length} 个（运行中 ${running}）`;
            }
            return "列出后台进程失败";
        }
        if (name === "_claude_undo_edit") return status === "running" ? "撤销编辑" : "撤销编辑不支持";
        if (name === "_codex_apply_patch") {
            if (status === "running") return "应用补丁";
            if (message.result?.success) {
                const ops = Array.isArray(message.result.operations) ? message.result.operations : [];
                const paths = ops.map(op => op.path).filter(Boolean);
                const summary = paths.length > 2 ? `${paths.slice(0, 2).join("、")} 等 ${paths.length} 个文件` : paths.join("、");
                return `已应用补丁（${ops.length} 个操作${summary ? `：${summary}` : ""}）`;
            }
            return `应用补丁失败：${String(message.result?.error || "").slice(0, 80)}`;
        }
        return status === "running" ? `执行 ${name}` : `${name} 已返回结果`;
    }

    function formatAgentToolDetail(message) {
        if (!message?.result || message.status === "running") return "";
        if (message.result.error) return String(message.result.error).slice(0, 500);
        return "";
    }

    function appendAgentToolMessageToUI(message, options = {}) {
        const wrapper = document.getElementById("messages-wrapper");
        if (!wrapper || !message) return null;
        const row = document.createElement("div");
        row.className = options.inline
            ? "agent-tool-row-wrapper agent-tool-inline"
            : "chat-row agent-tool-row-wrapper";
        row.dataset.agentToolId = message.toolId || "";
        const failed = message.status === "error" || (message.status === "done" && message.result && message.result.success === false);
        const running = message.status === "running";
        row.innerHTML = `<div class="agent-tool-row${failed ? " failed" : ""}${running ? " running" : ""}"><div class="agent-tool-summary"><i data-lucide="${TOOL_ICONS[message.toolName] || "wrench"}"></i><span class="agent-tool-summary-text"></span><span class="agent-working-time"></span><i class="agent-tool-toggle" data-lucide="chevron-down"></i></div><div class="agent-tool-detail"></div><div class="agent-tool-preview"><div class="agent-tool-preview-content"></div></div></div>`;
        row.querySelector(".agent-tool-summary-text").textContent = formatAgentToolSummary(message);
        if (message.taskDurationMs) row.querySelector(".agent-working-time").textContent = formatAgentWorkingTime(message.taskDurationMs, true);
        row.querySelector(".agent-tool-detail").textContent = formatAgentToolDetail(message);
        renderAgentToolPreview(row, message);
        const container = options.container || wrapper;
        if (options.before && options.before.parentNode === container) container.insertBefore(row, options.before);
        else container.appendChild(row);
        lucide.createIcons();
        if (running && isAgentTaskRunning()) setAgentActiveStatusRow(row);
        wrapper.scrollTop = wrapper.scrollHeight;
        return row;
    }

    function appendFinishTaskToFinalRow(message, finalRow = null) {
        const wrapper = document.getElementById("messages-wrapper");
        const rows = wrapper ? wrapper.querySelectorAll(".agent-final-row") : [];
        const targetRow = finalRow || rows[rows.length - 1];
        const contentCol = targetRow?.querySelector(".message-content-col");
        if (!contentCol) return appendAgentToolMessageToUI(message);
        return appendAgentToolMessageToUI(message, {
            inline: true,
            container: contentCol,
            before: contentCol.querySelector(".message-footer")
        });
    }

    function updateAgentToolMessageUI(message) {
        const row = document.querySelector(`[data-agent-tool-id="${CSS.escape(String(message.toolId || ""))}"]`);
        if (!row) return appendAgentToolMessageToUI(message);
        const failed = message.status === "error" || (message.status === "done" && message.result && message.result.success === false);
        const toolRow = row.querySelector(".agent-tool-row");
        if (toolRow) {
            toolRow.classList.toggle("failed", failed);
            toolRow.classList.toggle("running", message.status === "running");
        }
        const summary = row.querySelector(".agent-tool-summary-text");
        const detail = row.querySelector(".agent-tool-detail");
        if (summary) summary.textContent = formatAgentToolSummary(message);
        if (detail) detail.textContent = formatAgentToolDetail(message);
        const elapsed = row.querySelector(".agent-working-time");
        if (elapsed && message.taskDurationMs) elapsed.textContent = formatAgentWorkingTime(message.taskDurationMs, true);
        renderAgentToolPreview(row, message);
        if (message.status === "running" && isAgentTaskRunning()) setAgentActiveStatusRow(row);
        lucide.createIcons();
    }

    async function buildAgentMessages(chat, options = {}) {
        const latestUser = [...(chat.messages || [])].reverse().find(message => message?.role === "user" && message.hidden !== true);
        const compacted = buildCompactedChatMessages(chat);
        if (!chat.agentFixedPrompt) {
            chat.agentSessionStartedAt = chat.agentSessionStartedAt || Date.now();
            chat.agentFixedPrompt = AgentProtocol.buildFixedAgentPrompt({
                systemPrompt: chat.agentSystemPrompt || systemPrompt,
                environment: [
                    chat.agentEnvironment || chat.agentWorkspace || "",
                    `Session started: ${AgentProtocol.formatCurrentTime(new Date(chat.agentSessionStartedAt))}`
                ].filter(Boolean).join("\n")
            });
            if (options.estimateOnly !== true) persistAgentChats();
        }
        const requiredToolInstruction = "严格按照工具定义来调用，你现在不身处于你的官方cli环境！";
        if (!chat.agentFixedPrompt.includes(requiredToolInstruction)) {
            chat.agentFixedPrompt = `${chat.agentFixedPrompt}\n\n${requiredToolInstruction}`;
            if (options.estimateOnly !== true) persistAgentChats();
        }
        const result = [{
            role: "system",
            content: chat.agentFixedPrompt
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
                    if (message.responsesReasoning) built.__aiuiResponsesReasoning = message.responsesReasoning;
                }
                result.push(built);
            }
        }
        // The live plan changes every few turns, so it goes after the cached history
        // prefix rather than inside the fixed prompt or reordering prior turns.
        const planContext = formatAgentPlanForContext(chat);
        if (planContext) result.push({ role: "user", content: planContext });
        return result;
    }

    async function requestAgentModel(chat, model, options = {}) {
        if (Array.isArray(window.queuedAgentMessages) && window.queuedAgentMessages.length) {
            const queued = window.queuedAgentMessages.splice(0);
            let consumedUserMessages = 0;
            queued.forEach(entry => {
                // Remote additions stay bound to the chat that accepted them,
                // including if the user stops the task before the next model turn.
                if (entry && typeof entry === "object" && String(entry.gatewayChatId || "") !== String(chat.id)) return;
                const content = entry && typeof entry === "object" ? entry.content : entry;
                const message = { role: "user", content: String(content || ""), agentQueued: true };
                chat.messages.push(message);
                consumedUserMessages += 1;
                if (typeof appendMessageToUI === "function") appendMessageToUI("user", message.content, null, false, "", []);
            });
            if (typeof persistAgentChats === "function") persistAgentChats();
            if (typeof renderQueuedAgentMessages === "function") renderQueuedAgentMessages();
            if (consumedUserMessages) options.onUserMessagesConsumed?.();
        }
        const messages = await buildAgentMessages(chat);
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
        abortController = new AbortController();
        let fallbackRow = null;
        appendLog("debug", "开始请求 Agent AI 接口");
        appendLog("trace", `Agent AI 请求 URL: ${getBaseURL()}${preferredEndpoint}`);
        const { response, endpoint, requestBody } = await fetchEndpointWithFallback(basePayload, preferredEndpoint, abortController.signal, {
            onFallback: info => {
                fallbackRow = appendAgentEndpointFallbackRow(info);
                if (typeof options.onFallback === "function") options.onFallback(info);
            }
        });
        completeAgentEndpointFallbackRow(fallbackRow, endpoint);
        if (options.statusRow) setAgentActiveStatusRow(options.statusRow);
        lastPromptCacheDebug = logPromptCacheDebug(requestBody, lastPromptCacheDebug);
        appendLog("trace", `Agent 请求体: ${JSON.stringify(requestBody)}`);
        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            appendLog("error", `Agent AI 接口响应错误: ${response.status} ${response.statusText || ""}${detail ? ` - ${detail.slice(0, 500)}` : ""}`);
            throw new Error(`Agent API error: ${response.status}${detail ? ` - ${detail.slice(0, 500)}` : ""}`);
        }
        appendLog("trace", `Agent AI 接口响应状态: ${response.status} ${response.statusText || ""}`);
        if (!response.body || typeof response.body.getReader !== "function") {
            const payload = await response.json();
            const update = extractStreamingUpdate(payload, endpoint);
            const reasoning = String(update.reasoningSnapshot || update.reasoningDelta || "");
            if (reasoning && typeof options.onReasoning === "function") options.onReasoning(reasoning);
            return {
                text: extractNonStreamingResponseText(payload, endpoint),
                reasoning,
                responsesReasoning: AgentProtocol.createResponsesReasoningState(payload, { endpoint, model, baseURL: getBaseURL() }),
                completion: collectAgentCompletionInfo(payload),
                toolCalls: ToolCallNormalizer.canonicalizeToolCalls(ToolCallNormalizer.normalizeToolCalls(payload))
            };
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const debugStream = developerModeEnabled && (logLevel === "debug" || logLevel === "trace");
        const traceStream = developerModeEnabled && logLevel === "trace";
        let fullText = "";
        let reasoningText = "";
        const responsePayloads = [];
        let sseBuffer = "";
        let sawSSE = false;
        let streamBytesReceived = 0;
        const seenStreamEvents = new Set();
        let completion = {};
        const consume = block => {
            const event = parseSSEEventBlock(block);
            if (!event.data) return;
            sawSSE = true;
            if (event.data === "[DONE]") return;
            const payload = JSON.parse(event.data);
            const normalizedPayload = !payload.type && event.eventType ? { ...payload, type: event.eventType } : payload;
            const sequence = normalizedPayload.sequence_number;
            // Relays can reuse one SSE id for a response, including identical
            // consecutive token deltas. Only a protocol sequence number can
            // distinguish a replay from an intentional repeated token.
            const eventKey = Number.isSafeInteger(sequence) && sequence >= 0
                ? `${normalizedPayload.type || endpoint}:${sequence}:${event.data}` : "";
            if (eventKey && seenStreamEvents.has(eventKey)) return;
            if (eventKey) seenStreamEvents.add(eventKey);
            responsePayloads.push(normalizedPayload);
            completion = collectAgentCompletionInfo(normalizedPayload, completion);
            const streamError = getStreamingErrorMessage(normalizedPayload);
            if (streamError) throw new Error(streamError);
            const update = extractStreamingUpdate(normalizedPayload, endpoint);
            fullText = mergeStreamingText(fullText, update.contentDelta, update.contentSnapshot);
            const nextReasoning = mergeStreamingText(reasoningText, update.reasoningDelta, update.reasoningSnapshot);
            if (nextReasoning !== reasoningText) {
                reasoningText = nextReasoning;
                if (typeof options.onReasoning === "function") options.onReasoning(reasoningText);
            }
        };
        if (debugStream) {
            appendLog("debug", "Agent 流式输出接收开始");
            showVoiceNotification("正在接收 Agent 流数据 已接收数据量：0 字节", false, 0, true);
        }
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            streamBytesReceived += value ? value.length : 0;
            sseBuffer += decoder.decode(value, { stream: true });
            if (debugStream) {
                appendLog("debug", `收到 Agent 流数据块: ${value ? value.length : 0} 字节，累计 ${streamBytesReceived} 字节`);
                showVoiceNotification(`正在接收 Agent 流数据 已接收数据量：${streamBytesReceived} 字节`, false, 0, true);
            }
            if (traceStream) appendLog("trace", `Agent 原始流内容: ${sseBuffer.replace(/\n/g, "\\n")}`);
            const parts = sseBuffer.split(/\r?\n\r?\n/);
            sseBuffer = parts.pop() || "";
            for (const part of parts) {
                try {
                    consume(part);
                } catch (error) {
                    appendLog("debug", `解析 Agent 流数据失败: ${error.message}`);
                    throw error;
                }
            }
        }
        sseBuffer += decoder.decode();
        if (sseBuffer.trim()) {
            if (/^(?:event:|data:|id:)/m.test(sseBuffer)) consume(sseBuffer);
            else if (!sawSSE) {
                const payload = JSON.parse(sseBuffer.trim());
                responsePayloads.push(payload);
                completion = collectAgentCompletionInfo(payload, completion);
                fullText = mergeStreamingText(fullText, "", extractNonStreamingResponseText(payload, endpoint));
                const update = extractStreamingUpdate(payload, endpoint);
                reasoningText = mergeStreamingText(reasoningText, update.reasoningDelta, update.reasoningSnapshot);
                if (reasoningText && typeof options.onReasoning === "function") options.onReasoning(reasoningText);
            }
        }
        appendLog("debug", "Agent 流式输出接收完毕");
        if (debugStream) {
            hideVoiceNotification();
            showVoiceNotification(`Agent 流式接收完成，总计：${streamBytesReceived} 字节`, false, 2000, false);
        }
        return {
            text: fullText,
            reasoning: reasoningText,
            responsesReasoning: AgentProtocol.createResponsesReasoningState(responsePayloads, { endpoint, model, baseURL: getBaseURL() }),
            completion,
            toolCalls: ToolCallNormalizer.canonicalizeToolCalls(ToolCallNormalizer.normalizeToolCalls(responsePayloads))
        };
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

    function appendAgentVisibleText(chat, text, model, reasoning = "", final = false) {
        if (ToolCallNormalizer.hasMalformedToolCall && ToolCallNormalizer.hasMalformedToolCall(text)) return null;
        let content = AgentProtocol.stripToolCallsForDisplay(text);
        // Protocol-loop diagnostics are internal state, not user-facing正文.
        // Keep any model正文 before the diagnostic and render it normally.
        content = content.replace(/\n\s*Agent[^\n]*finish_task[^\n]*(?:\n|$)/gi, "\n").trim();
        if (!content) return null;
        const message = {
            role: "assistant",
            content,
            model,
            reasoning: ToolCallNormalizer.stripReasoningSections(String(reasoning || "")),
            agentDisplayOnly: true,
            agentSegment: !final,
            agentFinal: final
        };
        chat.messages.push(message);
        appendMessageToUI("assistant", content, model, final, message.reasoning, [], [], "", {
            agentFinal: final,
            agentSegment: !final,
            agentMessage: true
        });
        chat.updatedAt = Date.now();
        persistAgentChats();
        if (localStorage.getItem("agent_auto_scroll") !== "false") {
            const wrapper = document.getElementById("messages-wrapper");
            if (wrapper) wrapper.scrollTop = wrapper.scrollHeight;
        }
        return message;
    }

    function appendAgentRecoveryStatus(chat, text, model, failed = false) {
        // Fixed application messages must remain visible even when the model's
        // malformed protocol text cannot safely pass the normal prose renderer.
        const message = { role: "assistant", content: text, model, agentDisplayOnly: true,
            agentRecovery: true, agentSegment: !failed, agentFinal: failed, ...(failed ? { failed: true } : {}) };
        chat.messages.push(message);
        appendMessageToUI("assistant", text, model, failed, "", [], [], "", {
            agentFinal: failed, agentSegment: !failed, agentMessage: true
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
        appendAgentToolMessageToUI(message);
        persistAgentChats();
        return message;
    }

    async function resolveAgentToolResult(chat, call, message) {
        if (call.name === "update_plan") {
            return handleUpdatePlan(chat, call.arguments || {});
        }
        if (call.name === "run_shell") {
            const command = String(call.arguments?.command || "");
            if (!command.trim()) return { success: false, error: "command is required" };
            if (agentCommandMode !== "yolo") {
                const policy = await window.electronAPI.checkAgentCommand(command);
                if (!policy.allowed) {
                    const decision = await requestAgentCommandApproval(command, policy.suggestedPrefix);
                    if (agentStopRequested) return STOP_SENTINEL;
                    if (decision === "reject") {
                        return { success: false, rejected: true, error: `[${command}]被用户拒绝，尝试更换方法。` };
                    }
                    if (decision === "always") {
                        const prefix = agentApprovalPrefix || policy.suggestedPrefix;
                        if (prefix) await window.electronAPI.addAgentAllowedCommand(prefix);
                    }
                }
            }
            agentCurrentExecutionId = message.executionId;
            const startedAt = Date.now();
            const progressTimer = setInterval(() => {
                const current = agentShellProgressByExecution.get(message.executionId) || { stdoutBytes: 0, stderrBytes: 0 };
                agentShellProgressByExecution.set(message.executionId, { ...current, elapsedMs: Date.now() - startedAt });
                updateAgentToolMessageUI(message);
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
                agentCurrentExecutionId = "";
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

    async function finalizeAgentToolResult(chat, call, message, result) {
        message.result = result || { success: false, error: "tool did not return a result" };
        if (message.result.displayDiff) {
            message.displayDiff = message.result.displayDiff;
            delete message.result.displayDiff;
        }
        message.status = message.result.success === false || (call.name === "run_shell" && message.result.exitCode !== 0) ? "error" : "done";
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
        document.getElementById("send-btn")?.classList.add("hidden");
        document.getElementById("stop-btn")?.classList.remove("hidden");
        let thinkingRow = appendAgentThinkingRow();
        let invalidResponses = 0;
        let emptyResponses = 0;
        let missingFinalResponses = 0;
        let planOnlyResponses = 0;
        let finishBatchFailures = 0;
        let answerFloorIndex = 0;
        const resetUserTurn = () => {
            invalidResponses = 0;
            emptyResponses = 0;
            missingFinalResponses = 0;
            planOnlyResponses = 0;
            finishBatchFailures = 0;
            answerFloorIndex = chat.messages.reduce((latest, message, index) => message?.role === "user" ? index + 1 : latest, 0);
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
        resetUserTurn();
        let compactionCheckedAt = 0;
        try {
            while (!agentStopRequested) {
                // Check the context budget once per user-visible turn boundary rather
                // than on every internal loop iteration.
                if (Date.now() - compactionCheckedAt > 3000) {
                    compactionCheckedAt = Date.now();
                    await compactAgentContextIfNeeded(chat);
                    if (agentStopRequested) break;
                }
                let result;
                for (let attempt = 1; attempt <= 6; attempt += 1) {
                    try {
                        result = await requestAgentModel(chat, model, {
                    statusRow: thinkingRow,
                    onUserMessagesConsumed: resetUserTurn,
                    onReasoning: reasoning => thinkingRow?.updateReasoning?.(ToolCallNormalizer.stripReasoningSections(reasoning))
                        });
                        window.agentReconnectNotice = "";
                        if (typeof window.renderQueuedAgentMessages === "function") window.renderQueuedAgentMessages();
                        break;
                    } catch (error) {
                        if (!/network|failed to fetch|fetch/i.test(String(error?.message || ''))) throw error;
                        if (attempt >= 6) {
                            window.agentReconnectNotice = '连接已断开';
                            showVoiceNotification(window.agentReconnectNotice, true, 0, true);
                            if (typeof window.renderQueuedAgentMessages === 'function') window.renderQueuedAgentMessages();
                            throw new Error('连接已断开');
                        }
                        window.agentReconnectNotice = `尝试重新连接……${attempt}/6`;
                        showVoiceNotification(window.agentReconnectNotice, true, 0, true);
                        if (typeof window.renderQueuedAgentMessages === "function") window.renderQueuedAgentMessages();
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                }
                hideVoiceNotification();
                completeAgentThinking(chat, model, thinkingRow, result);
                thinkingRow = null;
                if (agentStopRequested) break;
                const rawParsed = ToolCallNormalizer.parseAgentResponse(result.text, result.toolCalls);
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
                if (!parsed.calls.length || parsed.hasMalformedToolCall) {
                    planOnlyResponses = 0;
                    const responseText = parsed.hasMalformedToolCall
                        ? ""
                        : String(parsed.text || "").trim();
                    const visibleResponse = responseText && !parsed.hasMalformedToolCall
                        ? appendAgentVisibleText(chat, responseText, model, "", !result.completion?.tokenLimited) : null;
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
                    thinkingRow = appendAgentThinkingRow();
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
                    .some(segment => segment.type === "tool_call" && segment.call?.name !== "finish_task");
                // Tool rows are rendered immediately in segment order so the transcript
                // stays readable, then executed as one batch (reads in parallel).
                const pendingToolItems = [];
                for (let index = 0; index < parsed.segments.length; index += 1) {
                    const segment = parsed.segments[index];
                    if (segment.type === "text") {
                        const nextSegment = parsed.segments[index + 1];
                        const isFinalText = !trailingFinalText && nextSegment?.type === "tool_call" && nextSegment.call?.name === "finish_task";
                        if (deferAnswer) {
                            deferredAnswerSegments.push({ text: segment.text, final: isFinalText });
                            continue;
                        }
                        const displayed = appendAgentVisibleText(chat, segment.text, model, "", isFinalText);
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
                            thinkingRow = appendAgentThinkingRow();
                            retryMissingFinal = true;
                            break;
                        }
                        for (const segment of deferredAnswerSegments) {
                            const displayed = appendAgentVisibleText(chat, segment.text, model, "", segment.final);
                            if (displayed) lastVisibleText = displayed;
                            if (segment.final && displayed) finalTextAdded = true;
                        }
                        if (trailingFinalText) {
                            const displayed = appendAgentVisibleText(chat, trailingFinalText, model, "", true);
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
                            thinkingRow = appendAgentThinkingRow();
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
                        appendFinishTaskToFinalRow(finishMessage);
                        await persistAgentToolMessage(chat, finishMessage);
                        chat.updatedAt = Date.now();
                        persistAgentChats();
                        renderChatHistory();
                        await renderMessagesWithResolvedRefs(chat.messages);
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
                thinkingRow = appendAgentThinkingRow();
            }
            if (agentStopRequested) {
                chat.messages.push({ role: "assistant", content: "Agent 已停止。", model, agentFinal: true });
                persistAgentChats();
            }
        } catch (error) {
            if (error?.name !== "AbortError" && !agentStopRequested) {
                appendLog("error", `Agent Loop 出错：${error.message}`);
                chat.messages.push({ role: "assistant", content: `Agent 执行失败：${error.message}`, model, agentFinal: true, failed: true });
                persistAgentChats();
            }
        } finally {
            if (thinkingRow) completeAgentThinking(chat, model, thinkingRow, { reasoning: thinkingRow.reasoningText });
            if (agentTaskStartedAt) finishAgentTaskTimer(chat);
            hideVoiceNotification();
            if (window.agentReconnectNotice !== '连接已断开') {
                window.agentReconnectNotice = "";
                if (typeof window.renderQueuedAgentMessages === "function") window.renderQueuedAgentMessages();
            }
            if (agentStopRequested && !chat.messages.some((message, index) => index === chat.messages.length - 1 && message?.role === "assistant" && message?.agentFinal)) {
                chat.messages.push({ role: "assistant", content: "Agent 已停止。", model, agentFinal: true });
                persistAgentChats();
            }
            abortController = null;
            isGenerating = false;
            agentTaskChatId = null;
            agentTaskPreparing = false;
            if (typeof updateSettingsLocks === "function") updateSettingsLocks();
            document.getElementById("send-btn")?.classList.remove("hidden");
            document.getElementById("stop-btn")?.classList.add("hidden");
            renderChatHistory();
            await renderMessagesWithResolvedRefs(chat.messages);
            updateAgentUIForChat(chat);
            if (!agentStopRequested && Array.isArray(window.queuedAgentMessages) && window.queuedAgentMessages.length) {
                setTimeout(() => requestAgentLoop(model, chat), 0);
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
        if (Array.isArray(window.queuedAgentMessages)) {
            for (let index = window.queuedAgentMessages.length - 1; index >= 0; index -= 1) {
                const entry = window.queuedAgentMessages[index];
                if (entry && typeof entry === "object" && String(entry.gatewayChatId || "") !== String(chat.id)) {
                    window.queuedAgentMessages.splice(index, 1);
                }
            }
        }
        if (!Array.isArray(window.queuedAgentMessages) || window.queuedAgentMessages.length >= 20) {
            return reject("待处理消息已达上限，请等待 Agent 处理");
        }
        const queueText = () => {
            window.queuedAgentMessages.push({ content: text, gatewayChatId: String(chat.id) });
            if (!chat.messages.length) {
                chat.title = text.slice(0, 20);
                setActiveChatTitle(chat);
            }
            if (typeof renderQueuedAgentMessages === "function") renderQueuedAgentMessages();
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
                if (typeof renderQueuedAgentMessages === "function") renderQueuedAgentMessages();
                showVoiceNotification(`已取消 ${cancelled} 条待处理远程消息`, false, 3000);
            }
        }
        if (abortController) abortController.abort();
        if (agentCurrentExecutionId) window.electronAPI?.cancelAgentExecution?.(agentCurrentExecutionId).catch(() => {});
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
        if (diffMaxLines) diffMaxLines.value = String(getAgentDiffMaxLines());
        if (detailBehavior) detailBehavior.value = getAgentDetailDefaultBehavior();
        if (shellTimeout) shellTimeout.value = String(Math.round(getAgentShellTimeoutMs() / 1000));
        if (imageDetail) imageDetail.value = localStorage.getItem("agent_view_image_detail") || "medium";
        if (searchEngine) searchEngine.value = getAgentSearchEngine();
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
                if (progress?.executionId) {
                    agentShellProgressByExecution.set(progress.executionId, progress);
                    const chat = agentTaskChatId ? chats.find(item => item.id === agentTaskChatId) : null;
                    const message = chat?.messages?.find(item => item.executionId === progress.executionId);
                    if (message) updateAgentToolMessageUI(message);
                }
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
        initializeAgentUI();
    };

    window.isAgentTaskRunning = isAgentTaskRunning;
    window.stopAgentTask = stopAgentTask;
    window.enterAgentMode = enterAgentMode;
    window.updateAgentUIForChat = updateAgentUIForChat;
    window.ensureAgentWorkspaceAvailable = refreshAgentWorkspace;
    window.resolveAgentCommandApproval = resolveAgentCommandApproval;
    window.onAgentCommandModeChange = onAgentCommandModeChange;
    window.resolveAgentWorkspaceTrust = resolveAgentWorkspaceTrust;
    window.resolveAgentYoloWarning = resolveAgentYoloWarning;
    window.appendAgentToolMessageToUI = appendAgentToolMessageToUI;
    window.appendAgentThinkingMessageToUI = appendAgentThinkingMessageToUI;
    window.populateAgentSettings = populateAgentSettings;
    window.saveAgentCommandSettings = saveAgentCommandSettings;
    window.requestAgentLoop = requestAgentLoop;
    window.buildAgentMessagesForContextEstimate = chat => buildAgentMessages(chat, { estimateOnly: true });
    window.submitGatewayAgentMessage = submitGatewayAgentMessage;
    // The gateway reads only the active reasoning text, never raw model payloads.
    window.getGatewayAgentThinkingState = () => agentLiveThinkingRow && agentTaskChatId ? {
        chatId: String(agentTaskChatId), id: agentLiveThinkingRow.gatewayThinkingId,
        reasoning: agentLiveThinkingRow.reasoningText,
        durationMs: Math.max(0, Date.now() - agentLiveThinkingRow.thinkingStartedAt), status: "running"
    } : null;
})();
