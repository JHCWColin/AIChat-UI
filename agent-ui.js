(function () {
    const MAX_TOOL_CALLS_PER_RESPONSE = 30;
    const DEFAULT_AGENT_DIFF_MAX_LINES = 10;
    const DEFAULT_AGENT_SHELL_TIMEOUT_SECONDS = 120;
    const TOOL_ICONS = {
        read_file_range: "file-search",
        write_file: "file-plus-2",
        edit_file: "file-pen-line",
        run_shell: "terminal",
        finish_task: "check-circle-2",
        agent_protocol: "shield-alert",
        list_dir: "folder-tree",
        grep_files: "search",
        view_image: "image",
        update_plan: "list-checks",
        _claude_insert_text: "file-pen-line",
        _claude_undo_edit: "undo-2",
        _codex_apply_patch: "file-pen-line"
    };
    const TOOL_LABELS = {
        read_file_range: "读取",
        write_file: "写入",
        edit_file: "编辑",
        run_shell: "运行",
        finish_task: "完成任务",
        agent_protocol: "协议提示",
        list_dir: "列目录",
        grep_files: "搜索",
        view_image: "查看图片",
        update_plan: "更新计划",
        _claude_insert_text: "插入文本",
        _claude_undo_edit: "撤销编辑",
        _codex_apply_patch: "应用补丁"
    };

    let agentTaskChatId = null;
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
            if (!chat?.agentEnabled || !Array.isArray(chat.messages)) continue;
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
        row.reasoningText = "";
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
            durationMs: message.thinkingDurationMs
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
        if (name === "_claude_undo_edit") return status === "running" ? "撤销编辑" : "撤销编辑不支持";
        if (name === "_codex_apply_patch") return status === "running" ? "应用补丁" : "补丁格式不支持";
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

    async function buildAgentMessages(chat) {
        const latestUser = [...(chat.messages || [])].reverse().find(message => message?.role === "user" && message.hidden !== true);
        const compacted = buildCompactedChatMessages(chat);
        const history = compacted.filter(message => message !== latestUser);
        if (!chat.agentFixedPrompt) {
            chat.agentSessionStartedAt = chat.agentSessionStartedAt || Date.now();
            chat.agentFixedPrompt = AgentProtocol.buildFixedAgentPrompt({
                systemPrompt: chat.agentSystemPrompt || systemPrompt,
                environment: [
                    chat.agentEnvironment || chat.agentWorkspace || "",
                    `Session started: ${AgentProtocol.formatCurrentTime(new Date(chat.agentSessionStartedAt))}`
                ].filter(Boolean).join("\n")
            });
            persistAgentChats();
        }
        const requiredToolInstruction = "严格按照工具定义来调用，你现在不身处于你的官方cli环境！";
        if (!chat.agentFixedPrompt.includes(requiredToolInstruction)) {
            chat.agentFixedPrompt = `${chat.agentFixedPrompt}\n\n${requiredToolInstruction}`;
            persistAgentChats();
        }
        const result = [{
            role: "system",
            content: chat.agentFixedPrompt
        }];
        for (const message of history) {
            if (message?.agentDisplayOnly === true) continue;
            if (message?.role === "tool") {
                const content = message.content || (message.contentRef ? await agentResultStore.get(message.contentRef) : "");
                result.push({
                    role: "user",
                    content: `[Tool Result: ${String(message.toolName || "unknown")}]\n${String(content || "")}`
                });
            } else if (message?.role === "user" || message?.role === "assistant" || message?.role === "system") {
                result.push(await buildSingleApiMessage(message, chat, false));
            }
        }
        if (latestUser) result.push(await buildSingleApiMessage(latestUser, chat, true));
        return result;
    }

    async function requestAgentModel(chat, model, options = {}) {
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
        const consume = block => {
            const event = parseSSEEventBlock(block);
            if (!event.data) return;
            sawSSE = true;
            if (event.data === "[DONE]") return;
            const payload = JSON.parse(event.data);
            const normalizedPayload = !payload.type && event.eventType ? { ...payload, type: event.eventType } : payload;
            responsePayloads.push(normalizedPayload);
            const sequence = normalizedPayload.sequence_number;
            const eventKey = event.eventId || (sequence !== undefined && sequence !== null
                ? `${normalizedPayload.type || endpoint}:${sequence}`
                : "");
            if (eventKey && seenStreamEvents.has(eventKey)) return;
            if (eventKey) seenStreamEvents.add(eventKey);
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
            toolCalls: ToolCallNormalizer.canonicalizeToolCalls(ToolCallNormalizer.normalizeToolCalls(responsePayloads))
        };
    }

    function appendAgentHiddenAssistant(chat, rawText, model, reasoning, options = {}) {
        if (!rawText && !reasoning) return;
        const message = {
            role: "assistant",
            content: String(rawText || ""),
            model,
            reasoning: ToolCallNormalizer.stripReasoningSections(String(reasoning || "")),
            hidden: true,
            agentToolResponse: true,
            agentThinking: options.agentThinking === true,
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
            agentThinking,
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
        return message;
    }

    async function executeAgentToolCall(chat, call) {
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

        let result;
        if (call.name === "update_plan") {
            result = handleUpdatePlan(chat, call.arguments || {});
        } else if (call.name === "run_shell") {
            const command = String(call.arguments?.command || "");
            if (!command.trim()) result = { success: false, error: "command is required" };
            else if (agentCommandMode !== "yolo") {
                const policy = await window.electronAPI.checkAgentCommand(command);
                if (!policy.allowed) {
                    const decision = await requestAgentCommandApproval(command, policy.suggestedPrefix);
                    if (agentStopRequested) return false;
                    if (decision === "reject") {
                        result = { success: false, rejected: true, error: `[${command}]被用户拒绝，尝试更换方法。` };
                    } else if (decision === "always") {
                        const prefix = agentApprovalPrefix || policy.suggestedPrefix;
                        if (prefix) await window.electronAPI.addAgentAllowedCommand(prefix);
                    }
                }
            }
            if (!result) {
                agentCurrentExecutionId = message.executionId;
                const startedAt = Date.now();
                const progressTimer = setInterval(() => {
                    const current = agentShellProgressByExecution.get(message.executionId) || { stdoutBytes: 0, stderrBytes: 0 };
                    agentShellProgressByExecution.set(message.executionId, { ...current, elapsedMs: Date.now() - startedAt });
                    updateAgentToolMessageUI(message);
                }, 250);
                try {
                    result = await window.electronAPI.executeAgentTool({
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
        } else if (call.name === "read_file_range" || call.name === "write_file" || call.name === "edit_file" || call.name === "list_dir" || call.name === "grep_files" || call.name === "view_image") {
            const toolArguments = call.name === "view_image"
                ? { ...(call.arguments || {}), detail: call.arguments?.detail || localStorage.getItem("agent_view_image_detail") || "medium" }
                : (call.arguments || {});
            result = await window.electronAPI.executeAgentTool({
                chatId: chat.id,
                name: call.name,
                arguments: toolArguments
            });
        } else if (call.name === "_claude_insert_text") {
            result = await handleClaudeInsertText(chat, call.arguments || {});
        } else if (call.name === "_claude_undo_edit") {
            result = { success: false, error: "undo_edit is not supported in this environment. Use edit_file to manually revert the previous change by swapping old_text and new_text." };
        } else if (call.name === "_codex_apply_patch") {
            result = { success: false, error: "apply_patch freeform syntax is not supported in this environment. Use edit_file for precise string replacements or write_file for full file overwrites." };
        } else {
            result = { success: false, error: `unknown tool: ${call.name}` };
        }
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
        return true;
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

    async function requestAgentProtocolCorrection(chat, model, rawText) {
        const evidence = typeof ToolCallNormalizer.extractToolCallEvidence === "function"
            ? ToolCallNormalizer.extractToolCallEvidence(rawText)
            : String(rawText || "").trim().slice(0, 2000);
        const errorText = [
            "模型没有返回有效的工具调用 JSON。请继续执行任务，并按协议返回工具调用对象。",
            evidence ? `本次错误的工具调用具体内容：\n${evidence}` : "本次响应中未找到可识别的工具调用内容。"
        ].join("\n\n");
        chat.messages.push({
            role: "tool",
            name: "agent_protocol",
            toolName: "agent_protocol",
            arguments: {},
            hidden: true,
            status: "done",
            result: { success: true, protocolCorrection: true, error: errorText },
            content: errorText,
            toolId: `${chat.id}-${Date.now()}-${agentToolSequence += 1}`
        });
        const message = chat.messages[chat.messages.length - 1];
        await persistAgentToolMessage(chat, message);
    }

    async function requestAgentLoop(model, chat) {
        if (!chat?.agentEnabled) return requestAI("", model, chat);
        if (isAgentTaskRunning()) return;
        if (!(await refreshAgentWorkspace(chat))) return;
        agentTaskChatId = chat.id;
        agentStopRequested = false;
        startAgentTaskTimer();
        isGenerating = true;
        document.getElementById("send-btn")?.classList.add("hidden");
        document.getElementById("stop-btn")?.classList.remove("hidden");
        let thinkingRow = appendAgentThinkingRow();
        let invalidResponses = 0;
        try {
            while (!agentStopRequested) {
                const result = await requestAgentModel(chat, model, {
                    statusRow: thinkingRow,
                    onReasoning: reasoning => thinkingRow?.updateReasoning?.(ToolCallNormalizer.stripReasoningSections(reasoning))
                });
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
                if (!parsed.calls.length) {
                    invalidResponses += 1;
                    const responseText = parsed.hasMalformedToolCall
                        ? ""
                        : String(parsed.text || "").trim();
                    if (invalidResponses >= 3) {
                        const responseText = parsed.text || "模型连续返回空回复。";
                        appendAgentVisibleText(chat, `${responseText}\n\nAgent 协议错误：模型未调用 finish_task，循环已终止。`, model, "", true);
                        break;
                    }
                    if (responseText && invalidResponses < 3) appendAgentVisibleText(chat, responseText, model, "", false);
                    await requestAgentProtocolCorrection(chat, model, result.text);
                    thinkingRow = appendAgentThinkingRow();
                    continue;
                }
                invalidResponses = 0;
                const finishSegmentIndex = parsed.segments.findIndex(segment => segment.type === "tool_call" && segment.call?.name === "finish_task");
                const trailingFinalText = finishSegmentIndex >= 0
                    ? parsed.segments.slice(finishSegmentIndex + 1)
                        .filter(segment => segment.type === "text")
                        .map(segment => segment.text)
                        .join("\n\n")
                    : "";
                let finalTextAdded = false;
                for (let index = 0; index < parsed.segments.length; index += 1) {
                    const segment = parsed.segments[index];
                    if (segment.type === "text") {
                        const nextSegment = parsed.segments[index + 1];
                        const isFinalText = !trailingFinalText && nextSegment?.type === "tool_call" && nextSegment.call?.name === "finish_task";
                        appendAgentVisibleText(chat, segment.text, model, "", isFinalText);
                        if (isFinalText) finalTextAdded = true;
                        continue;
                    }
                    const call = segment.call;
                    if (call.name === "finish_task") {
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
                        if (trailingFinalText) {
                            appendAgentVisibleText(chat, trailingFinalText, model, "", true);
                            finalTextAdded = true;
                        }
                        if (!finalTextAdded) appendAgentVisibleText(chat, "任务已完成。", model, "", true);
                        appendFinishTaskToFinalRow(finishMessage);
                        await persistAgentToolMessage(chat, finishMessage);
                        chat.updatedAt = Date.now();
                        persistAgentChats();
                        renderChatHistory();
                        await renderMessagesWithResolvedRefs(chat.messages);
                        return;
                    }
                    if (!(await executeAgentToolCall(chat, call))) return;
                    if (agentStopRequested) return;
                }
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
            if (agentStopRequested && !chat.messages.some((message, index) => index === chat.messages.length - 1 && message?.role === "assistant" && message?.agentFinal)) {
                chat.messages.push({ role: "assistant", content: "Agent 已停止。", model, agentFinal: true });
                persistAgentChats();
            }
            abortController = null;
            isGenerating = false;
            agentTaskChatId = null;
            document.getElementById("send-btn")?.classList.remove("hidden");
            document.getElementById("stop-btn")?.classList.add("hidden");
            renderChatHistory();
            await renderMessagesWithResolvedRefs(chat.messages);
            updateAgentUIForChat(chat);
        }
    }

    function stopAgentTask() {
        agentStopRequested = true;
        if (abortController) abortController.abort();
        if (agentCurrentExecutionId) window.electronAPI?.cancelAgentExecution?.(agentCurrentExecutionId).catch(() => {});
        for (const executionId of agentShellProgressByExecution.keys()) {
            window.electronAPI?.cancelAgentExecution?.(executionId).catch(() => {});
        }
        resolveAgentCommandApproval("reject");
        resolveAgentYoloWarning(false);
    }

    async function populateAgentSettings() {
        const diffMaxLines = document.getElementById("agent-diff-max-lines");
        const detailBehavior = document.getElementById("agent-detail-default-behavior");
        const shellTimeout = document.getElementById("agent-shell-timeout-seconds");
        const imageDetail = document.getElementById("agent-view-image-detail");
        if (diffMaxLines) diffMaxLines.value = String(getAgentDiffMaxLines());
        if (detailBehavior) detailBehavior.value = getAgentDetailDefaultBehavior();
        if (shellTimeout) shellTimeout.value = String(Math.round(getAgentShellTimeoutMs() / 1000));
        if (imageDetail) imageDetail.value = localStorage.getItem("agent_view_image_detail") || "medium";
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
        const selectedDiffLimit = Number(diffMaxLines?.value);
        localStorage.setItem("agent_diff_max_lines", String([10, 20, 50, 0].includes(selectedDiffLimit) ? selectedDiffLimit : DEFAULT_AGENT_DIFF_MAX_LINES));
        localStorage.setItem("agent_detail_default_behavior", detailBehavior?.value === "collapsed" ? "collapsed" : "expanded");
        const requestedSeconds = Number(shellTimeout?.value);
        const timeoutSeconds = Number.isFinite(requestedSeconds)
            ? Math.min(Math.max(Math.round(requestedSeconds), 5), 3600)
            : DEFAULT_AGENT_SHELL_TIMEOUT_SECONDS;
        localStorage.setItem("agent_shell_timeout_seconds", String(timeoutSeconds));
        localStorage.setItem("agent_view_image_detail", ["low", "medium", "high", "original"].includes(imageDetail?.value) ? imageDetail.value : "medium");
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
})();
