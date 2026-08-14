(function () {
    const MAX_TOOL_CALLS_PER_RESPONSE = 30;
    const TOOL_ICONS = {
        read_file_range: "file-search",
        write_file: "file-plus-2",
        edit_file: "file-pen-line",
        run_shell: "terminal",
        finish_task: "check-circle-2",
        agent_protocol: "shield-alert"
    };
    const TOOL_LABELS = {
        read_file_range: "读取",
        write_file: "写入",
        edit_file: "编辑",
        run_shell: "运行",
        finish_task: "完成任务",
        agent_protocol: "协议提示"
    };

    let agentTaskChatId = null;
    let agentStopRequested = false;
    let agentApprovalResolver = null;
    let agentYoloResolver = null;
    let agentCommandMode = "safe";
    let agentToolSequence = 0;
    let agentCurrentExecutionId = "";
    let agentShellProgressUnsubscribe = null;
    const agentShellProgressByExecution = new Map();

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
        const title = document.getElementById("active-chat-title");
        if (title) title.classList.toggle("text-emerald-400", Boolean(chat?.agentEnabled));
        const canvasToggle = document.getElementById("canvas-toggle-btn");
        if (canvasToggle) canvasToggle.style.display = chat?.agentEnabled ? "none" : "inline-flex";
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
            const binding = await window.electronAPI.selectAgentWorkspace(chat.id);
            if (!binding || binding.canceled) return;
            if (!binding.path || binding.exists === false) throw new Error("工作区不可用");
            chat.agentEnabled = true;
            chat.agentWorkspace = binding.path;
            chat.agentEnvironment = binding.environment || "";
            chat.agentSystemPrompt = systemPrompt || "";
            chat.agentFixedPrompt = AgentProtocol.buildFixedAgentPrompt({
                systemPrompt: chat.agentSystemPrompt,
                environment: chat.agentEnvironment
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
                chat.agentFixedPrompt = AgentProtocol.buildFixedAgentPrompt({
                    systemPrompt: chat.agentSystemPrompt || systemPrompt,
                    environment: chat.agentEnvironment
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

    function resolveAgentYoloWarning(confirmed) {
        const modal = document.getElementById("agent-yolo-warning-modal");
        if (modal) modal.classList.remove("visible");
        const resolver = agentYoloResolver;
        agentYoloResolver = null;
        if (resolver) resolver(Boolean(confirmed));
    }

    function requestAgentYoloWarning() {
        const modal = document.getElementById("agent-yolo-warning-modal");
        if (!modal) return Promise.resolve(false);
        modal.classList.add("visible");
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
        const container = document.getElementById("agent-command-approval");
        if (container) container.classList.remove("visible");
        const resolver = agentApprovalResolver;
        agentApprovalResolver = null;
        if (resolver) resolver(decision);
    }

    function requestAgentCommandApproval(command, suggestedPrefix) {
        const container = document.getElementById("agent-command-approval");
        const commandEl = document.getElementById("agent-command-approval-command");
        const prefixEl = document.getElementById("agent-command-approval-prefix");
        if (!container || !commandEl || !prefixEl) return Promise.resolve("reject");
        commandEl.textContent = command;
        prefixEl.value = suggestedPrefix || "";
        container.classList.add("visible");
        prefixEl.focus();
        return new Promise(resolve => {
            agentApprovalResolver = resolve;
        });
    }

    function getAgentApprovalPrefix() {
        return String(document.getElementById("agent-command-approval-prefix")?.value || "").trim();
    }

    function appendAgentThinkingRow(text = "Agent 正在规划下一步…") {
        const wrapper = document.getElementById("messages-wrapper");
        const row = document.createElement("div");
        row.className = "chat-row agent-thinking-row";
        row.innerHTML = `<div class="agent-tool-row"><div class="agent-tool-summary"><i data-lucide="bot"></i><span>${escapeHtml(text)}</span></div></div>`;
        wrapper.appendChild(row);
        lucide.createIcons();
        wrapper.scrollTop = wrapper.scrollHeight;
        return row;
    }

    function toolArguments(message) {
        return message?.arguments && typeof message.arguments === "object" ? message.arguments : {};
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
            const seconds = Math.max(0, Math.round(Number(progress.elapsedMs || result.durationMs || 0) / 1000));
            const bytes = Number(progress.stdoutBytes || 0) + Number(progress.stderrBytes || 0) || Number(result.stdoutBytes || 0) + Number(result.stderrBytes || 0);
            if (status === "running") return `运行命令，${seconds}秒，${bytes}字节`;
            return result.exitCode === 0 && !result.timedOut && !result.cancelled ? `运行命令完成，${seconds}秒，${bytes}字节（exitCode 0）` : `运行命令结束，${seconds}秒，${bytes}字节（exitCode ${result.exitCode ?? 1}）`;
        }
        if (name === "finish_task") return "任务完成";
        return status === "running" ? `执行 ${name}` : `${name} 已返回结果`;
    }

    function formatAgentToolDetail(message) {
        if (!message?.result || message.status === "running") return "";
        if (message.result.error) return String(message.result.error).slice(0, 500);
        if (message.toolName === "run_shell" && message.result.stderr) return String(message.result.stderr).trim().slice(0, 500);
        return "";
    }

    function appendAgentToolMessageToUI(message) {
        const wrapper = document.getElementById("messages-wrapper");
        if (!wrapper || !message) return null;
        const row = document.createElement("div");
        row.className = `chat-row agent-tool-row-wrapper`;
        row.dataset.agentToolId = message.toolId || "";
        const failed = message.status === "error" || (message.status === "done" && message.result && message.result.success === false);
        row.innerHTML = `<div class="agent-tool-row${failed ? " failed" : ""}"><div class="agent-tool-summary"><i data-lucide="${TOOL_ICONS[message.toolName] || "wrench"}"></i><span class="agent-tool-summary-text"></span></div><div class="agent-tool-detail"></div></div>`;
        row.querySelector(".agent-tool-summary-text").textContent = formatAgentToolSummary(message);
        row.querySelector(".agent-tool-detail").textContent = formatAgentToolDetail(message);
        wrapper.appendChild(row);
        lucide.createIcons();
        wrapper.scrollTop = wrapper.scrollHeight;
        return row;
    }

    function updateAgentToolMessageUI(message) {
        const row = document.querySelector(`[data-agent-tool-id="${CSS.escape(String(message.toolId || ""))}"]`);
        if (!row) return appendAgentToolMessageToUI(message);
        const failed = message.status === "error" || (message.status === "done" && message.result && message.result.success === false);
        const toolRow = row.querySelector(".agent-tool-row");
        if (toolRow) toolRow.classList.toggle("failed", failed);
        const summary = row.querySelector(".agent-tool-summary-text");
        const detail = row.querySelector(".agent-tool-detail");
        if (summary) summary.textContent = formatAgentToolSummary(message);
        if (detail) detail.textContent = formatAgentToolDetail(message);
        lucide.createIcons();
    }

    async function buildAgentMessages(chat) {
        const latestUser = [...(chat.messages || [])].reverse().find(message => message?.role === "user" && message.hidden !== true);
        const compacted = buildCompactedChatMessages(chat);
        const history = compacted.filter(message => message !== latestUser);
        const result = [{
            role: "system",
            content: chat.agentFixedPrompt || AgentProtocol.buildFixedAgentPrompt({
                systemPrompt: chat.agentSystemPrompt || systemPrompt,
                environment: chat.agentEnvironment || chat.agentWorkspace || ""
            })
        }];
        for (const message of history) {
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
        result.push({ role: "user", content: AgentProtocol.formatCurrentTime() });
        if (latestUser) result.push(await buildSingleApiMessage(latestUser, chat, true));
        return result;
    }

    async function requestAgentModel(chat, model) {
        const messages = await buildAgentMessages(chat);
        const promptCacheKey = String(localStorage.getItem("prompt_cache_key") || "").trim();
        const cacheControl = String(localStorage.getItem("cache_control") || "").trim();
        const basePayload = {
            model,
            temperature: currentTemp,
            messages,
            stream: true,
            ...(maxTokensLimit > 0 ? { max_tokens: maxTokensLimit } : {}),
            ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
            ...(cacheControl ? { cache_control: cacheControl } : {})
        };
        const preferredEndpoint = getRequestEndpoint();
        abortController = new AbortController();
        const { response, endpoint, requestBody } = await fetchEndpointWithFallback(basePayload, preferredEndpoint, abortController.signal);
        lastPromptCacheDebug = logPromptCacheDebug(requestBody, lastPromptCacheDebug);
        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new Error(`Agent API error: ${response.status}${detail ? ` - ${detail.slice(0, 500)}` : ""}`);
        }
        if (!response.body || typeof response.body.getReader !== "function") {
            const payload = await response.json();
            return { text: extractNonStreamingResponseText(payload, endpoint), reasoning: "" };
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = "";
        let sseBuffer = "";
        let sawSSE = false;
        const consume = block => {
            const event = parseSSEEventBlock(block);
            if (!event.data) return;
            sawSSE = true;
            if (event.data === "[DONE]") return;
            const payload = JSON.parse(event.data);
            const streamError = getStreamingErrorMessage(payload);
            if (streamError) throw new Error(streamError);
            const update = extractStreamingUpdate(payload, endpoint);
            fullText = mergeStreamingText(fullText, update.contentDelta, update.contentSnapshot);
        };
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            sseBuffer += decoder.decode(value, { stream: true });
            const parts = sseBuffer.split(/\r?\n\r?\n/);
            sseBuffer = parts.pop() || "";
            parts.forEach(consume);
        }
        sseBuffer += decoder.decode();
        if (sseBuffer.trim()) {
            if (/^(?:event:|data:|id:)/m.test(sseBuffer)) consume(sseBuffer);
            else if (!sawSSE) {
                const payload = JSON.parse(sseBuffer.trim());
                fullText = mergeStreamingText(fullText, "", extractNonStreamingResponseText(payload, endpoint));
            }
        }
        return { text: fullText, reasoning: "" };
    }

    function appendAgentHiddenAssistant(chat, rawText, model, reasoning) {
        if (!rawText && !reasoning) return;
        chat.messages.push({
            role: "assistant",
            content: String(rawText || ""),
            model,
            reasoning: String(reasoning || ""),
            hidden: true,
            agentToolResponse: true
        });
        chat.updatedAt = Date.now();
        persistAgentChats();
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
        if (call.name === "run_shell") {
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
                        const prefix = getAgentApprovalPrefix() || policy.suggestedPrefix;
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
                        executionId: message.executionId
                    });
                } finally {
                    clearInterval(progressTimer);
                    agentCurrentExecutionId = "";
                }
            }
        } else if (call.name === "read_file_range" || call.name === "write_file" || call.name === "edit_file") {
            result = await window.electronAPI.executeAgentTool({
                chatId: chat.id,
                name: call.name,
                arguments: call.arguments || {}
            });
        } else {
            result = { success: false, error: `unknown tool: ${call.name}` };
        }
        message.result = result || { success: false, error: "tool did not return a result" };
        message.status = message.result.success === false || (call.name === "run_shell" && message.result.exitCode !== 0) ? "error" : "done";
        message.content = message.result.rejected
            ? String(message.result.error || "")
            : JSON.stringify(message.result);
        await persistAgentToolMessage(chat, message);
        updateAgentToolMessageUI(message);
        return true;
    }

    async function requestAgentProtocolCorrection(chat, model, rawText) {
        chat.messages.push({
            role: "tool",
            name: "agent_protocol",
            toolName: "agent_protocol",
            arguments: {},
            status: "error",
            result: { success: false, error: "模型没有返回有效的工具调用 JSON。请继续执行任务，并按协议返回工具调用对象。" },
            content: "模型没有返回有效的工具调用 JSON。请继续执行任务，并按协议返回工具调用对象。",
            toolId: `${chat.id}-${Date.now()}-${agentToolSequence += 1}`
        });
        const message = chat.messages[chat.messages.length - 1];
        appendAgentToolMessageToUI(message);
        await persistAgentToolMessage(chat, message);
    }

    async function requestAgentLoop(model, chat) {
        if (!chat?.agentEnabled) return requestAI("", model, chat);
        if (isAgentTaskRunning()) return;
        if (!(await refreshAgentWorkspace(chat))) return;
        agentTaskChatId = chat.id;
        agentStopRequested = false;
        isGenerating = true;
        document.getElementById("send-btn")?.classList.add("hidden");
        document.getElementById("stop-btn")?.classList.remove("hidden");
        const thinkingRow = appendAgentThinkingRow();
        let invalidResponses = 0;
        try {
            while (!agentStopRequested) {
                if (thinkingRow && !thinkingRow.isConnected) break;
                const result = await requestAgentModel(chat, model);
                if (agentStopRequested) break;
                const parsed = AgentProtocol.parseSequentialToolCalls(result.text);
                if (parsed.calls.length > MAX_TOOL_CALLS_PER_RESPONSE) {
                    throw new Error(`单次模型回复包含 ${parsed.calls.length} 个工具调用，超过 30 个上限，Agent 已终止`);
                }
                if (!parsed.calls.length) {
                    appendAgentHiddenAssistant(chat, result.text, model, result.reasoning);
                    invalidResponses += 1;
                    if (invalidResponses >= 3) {
                        const responseText = parsed.text || "模型连续返回空回复。";
                        chat.messages.push({ role: "assistant", content: `${responseText}\n\nAgent 协议错误：模型未调用 finish_task，循环已终止。`, model, agentFinal: true });
                        break;
                    }
                    await requestAgentProtocolCorrection(chat, model, result.text);
                    continue;
                }
                invalidResponses = 0;
                appendAgentHiddenAssistant(chat, result.text, model, result.reasoning);
                for (const call of parsed.calls) {
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
                        chat.messages.push(finishMessage);
                        appendAgentToolMessageToUI(finishMessage);
                        await persistAgentToolMessage(chat, finishMessage);
                        const finalText = parsed.text || "任务已完成。";
                        chat.messages.push({ role: "assistant", content: finalText, model, reasoning: result.reasoning || "", agentFinal: true });
                        chat.updatedAt = Date.now();
                        persistAgentChats();
                        renderChatHistory();
                        await renderMessagesWithResolvedRefs(chat.messages);
                        return;
                    }
                    if (!(await executeAgentToolCall(chat, call))) return;
                    if (agentStopRequested) return;
                }
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
            if (thinkingRow?.isConnected) thinkingRow.remove();
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
    window.resolveAgentYoloWarning = resolveAgentYoloWarning;
    window.appendAgentToolMessageToUI = appendAgentToolMessageToUI;
    window.populateAgentSettings = populateAgentSettings;
    window.saveAgentCommandSettings = saveAgentCommandSettings;
    window.requestAgentLoop = requestAgentLoop;
})();
