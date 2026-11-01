(function () {
    "use strict";

    const api = window.electronAPI;
    if (!api?.isElectron || !api.publishGatewaySnapshot) return;

    const TOOL_ACTIVITY = Object.freeze({
        read_file_range: "读取文件", write_file: "写入文件", edit_file: "编辑文件",
        multi_edit_file: "编辑文件", run_shell: "运行指令", start_process: "启动进程",
        read_process_output: "检查进程", stop_process: "停止进程", list_processes: "检查进程",
        list_dir: "查看目录", glob_files: "查找文件", grep_files: "搜索文件",
        delete_path: "删除文件", move_path: "移动文件", copy_path: "复制文件",
        view_image: "查看图片", update_plan: "更新任务计划", web_search: "搜索网页",
        browse_web: "浏览网页", _claude_insert_text: "编辑文件", _claude_undo_edit: "撤销编辑",
        _codex_apply_patch: "编辑文件", finish_task: "任务完成", agent_protocol: "调整请求格式"
    });
    const handledRequests = new Map();
    let previousSignature = "";
    let lastPublishedAt = 0;

    function plainText(value) {
        return String(value || "");
    }

    function summaryLine(value) {
        return plainText(value).split(/\r\n|\n|\r/, 1)[0].slice(0, 240);
    }

    function toolDetail(message) {
        const args = message.arguments && typeof message.arguments === "object" ? message.arguments : {};
        const name = String(message.toolName || message.name || "unknown");
        if (name === "run_shell" || name === "start_process") return summaryLine(args.command);
        if (name === "web_search") return summaryLine(args.query);
        if (name === "browse_web") return summaryLine(args.url);
        if (name === "move_path" || name === "copy_path") return summaryLine(`${args.from || ""} → ${args.to || ""}`);
        if (name === "update_plan") {
            const plan = Array.isArray(args.plan) ? args.plan : [];
            const current = plan.find(item => item?.status === "in_progress");
            return summaryLine(`${plan.length} 个步骤${current?.step ? ` · 正在进行：${current.step}` : ""}`);
        }
        if (name === "glob_files" || name === "grep_files") {
            return summaryLine([args.pattern, args.path].filter(Boolean).join(" · "));
        }
        // Deliberate allowlist: file/process identity and search target are useful
        // summaries; file contents, patches, environment and tool output stay local.
        for (const key of ["path", "dir_path", "process_id", "query", "url", "pattern"]) {
            if (typeof args[key] === "string" && args[key]) return summaryLine(args[key]);
        }
        return "";
    }

    function thinkingPreview(value) {
        const lines = plainText(value).split(/\r\n|\n|\r/).filter(line => line.trim());
        const omittedLines = Math.max(0, lines.length - 6);
        return { content: omittedLines
            ? [...lines.slice(0, 3), `…省略 ${omittedLines} 行…`, ...lines.slice(-3)].join("\n")
            : lines.join("\n"), omittedLines };
    }

    function thinkingMessage(id, reasoning, status, durationMs) {
        const preview = thinkingPreview(reasoning);
        if (!preview.content && status !== "running") return null;
        return { id, role: "assistant", kind: "thinking", status,
            content: preview.content || "正在思考…", omittedLines: preview.omittedLines,
            durationMs: Math.max(0, Number(durationMs) || 0) };
    }

    function currentChat() {
        return typeof activeChatId !== "undefined" && typeof chats !== "undefined"
            ? chats.find(chat => String(chat.id) === String(activeChatId)) : null;
    }

    function projectSnapshot() {
        const chat = currentChat();
        if (!chat?.agentEnabled) {
            return { chatId: null, title: "等待桌面端激活 Agent 会话", agentEnabled: false,
                running: false, status: "unavailable", activity: "仅共享桌面当前的 Agent 会话",
                messages: [], queuedCount: 0 };
        }
        const taskRunning = Boolean(window.isAgentTaskRunning?.(chat.id));
        const compacting = typeof contextCompactionRunning !== "undefined" && contextCompactionRunning;
        const running = taskRunning || (typeof isGenerating !== "undefined" && isGenerating) || compacting;
        const source = Array.isArray(chat.messages) ? chat.messages : [];
        const messages = [];
        const hiddenReasoningByTurn = new Map();
        let turn = 0;
        // Visible answer records can repeat reasoning already persisted in the
        // corresponding hidden Agent response. Keep the actual thinking turn once.
        for (const message of source) {
            if (message?.role === "user") turn += 1;
            if (message?.role === "assistant" && message.hidden && String(message.reasoning || "").trim()) {
                if (!hiddenReasoningByTurn.has(turn)) hiddenReasoningByTurn.set(turn, new Set());
                hiddenReasoningByTurn.get(turn).add(String(message.reasoning).trim());
            }
        }
        turn = 0;
        for (let index = 0; index < source.length; index += 1) {
            const message = source[index];
            if (!message || !["user", "assistant", "tool"].includes(message.role)) continue;
            if (message.role === "user") turn += 1;
            if (message.role === "assistant" && String(message.reasoning || "").trim()) {
                const reasoning = String(message.reasoning);
                if (message.hidden || !hiddenReasoningByTurn.get(turn)?.has(reasoning.trim())) {
                    const thinking = thinkingMessage(message.gatewayThinkingId || `${chat.id}:${index}:thinking`,
                        reasoning, "done", message.thinkingDurationMs);
                    if (thinking) messages.push(thinking);
                }
            }
            // Hidden assistant contents contain protocol JSON and are not prose.
            if (message.role !== "tool" && message.hidden) continue;
            let content;
            let status;
            if (message.role === "tool") {
                content = TOOL_ACTIVITY[message.toolName || message.name] || "使用工具";
                status = message.status === "running" && running ? "running"
                    : message.status === "error" || message.result?.success === false ? "error" : "done";
            } else {
                content = String(message.content || "");
                if (message.role === "assistant") {
                    content = window.AgentProtocol?.stripToolCallsForDisplay
                        ? window.AgentProtocol.stripToolCallsForDisplay(content) : content;
                }
                content = plainText(content);
                if (!content.trim()) continue;
            }
            messages.push({ id: `${chat.id}:${index}`, role: message.role, content,
                kind: message.role === "tool" ? "tool" : "message", ...(status ? { status } : {}),
                ...(message.role === "tool" ? { toolName: String(message.toolName || message.name || "unknown"),
                    detail: toolDetail(message), durationMs: Math.max(0, Number(message.taskDurationMs) || 0) } : {}) });
        }
        const liveThinking = window.getGatewayAgentThinkingState?.();
        const currentlyThinking = running && liveThinking && String(liveThinking.chatId) === String(chat.id);
        if (currentlyThinking && !messages.some(message => message.id === liveThinking.id)) {
            const thinking = thinkingMessage(liveThinking.id, liveThinking.reasoning, "running", liveThinking.durationMs);
            if (thinking) messages.push(thinking);
        }
        const activeTool = [...messages].reverse().find(message => message.role === "tool" && message.status === "running");
        const waitingApproval = Boolean(document.querySelector(".agent-command-approval-row:not(.leaving)"));
        const disconnected = window.agentReconnectNotice === "连接已断开";
        const reconnecting = running && Boolean(window.agentReconnectNotice);
        const status = compacting ? "compacting" : waitingApproval ? "waiting-approval"
            : reconnecting ? "reconnecting" : currentlyThinking ? "thinking" : running ? "running" : "idle";
        const activity = compacting ? "正在整理上下文" : waitingApproval ? "等待电脑端确认操作权限"
            : reconnecting ? "正在恢复模型连接" : disconnected ? "模型连接已断开，等待下一轮任务"
                : currentlyThinking ? "正在思考" : activeTool ? `${activeTool.content}${activeTool.detail ? ` · ${activeTool.detail}` : ""}`
                    : running ? "Agent 正在运行" : "等待下一轮任务";
        return { chatId: String(chat.id), title: summaryLine(chat.title || "Agent 会话"), agentEnabled: true,
            running, status, activity, messages,
            queuedCount: Array.isArray(window.queuedAgentMessages) ? window.queuedAgentMessages.filter(entry =>
                !entry || typeof entry !== "object" || String(entry.gatewayChatId) === String(chat.id)).length : 0 };
    }

    function publish(force = false) {
        try {
            const snapshot = projectSnapshot();
            const signature = JSON.stringify(snapshot);
            const now = Date.now();
            if (!force && signature === previousSignature && now - lastPublishedAt < 1000) return;
            previousSignature = signature;
            lastPublishedAt = now;
            api.publishGatewaySnapshot({ ...snapshot, updatedAt: now });
        } catch (error) {
            console.warn("[AgentGateway] 无法同步会话摘要", error?.message || error);
        }
    }

    async function receiveMessage(request) {
        const requestId = typeof request?.requestId === "string" ? request.requestId : "";
        if (!requestId || requestId.length > 160) return;
        let resultPromise = handledRequests.get(requestId);
        if (!resultPromise) {
            resultPromise = Promise.resolve().then(async () => {
                if (typeof window.submitGatewayAgentMessage !== "function") {
                    return { accepted: false, error: "桌面 Agent 尚未就绪" };
                }
                return window.submitGatewayAgentMessage(request);
            }).catch(() => ({ accepted: false, error: "桌面端未能接收消息，请稍后重试" }));
            handledRequests.set(requestId, resultPromise);
            // Keep pending requests until settled; retain recent acknowledgements for retries.
            if (handledRequests.size > 256) {
                const oldest = handledRequests.keys().next().value;
                handledRequests.get(oldest).finally(() => {
                    if (handledRequests.size > 256) handledRequests.delete(oldest);
                });
            }
        }
        const result = await resultPromise;
        api.completeGatewayMessage?.(requestId, result);
        publish(true);
    }

    const button = document.getElementById("agent-gateway-btn");
    if (button) {
        button.hidden = false;
        button.style.display = "flex";
        button.addEventListener("click", async () => {
            try { await api.openAgentGateway(); }
            catch (error) { window.showVoiceNotification?.(`无法打开 Agent 网关：${error.message}`, true, 3500); }
        });
    }
    api.onGatewayMessage?.(receiveMessage);
    const timer = setInterval(publish, 500);
    window.addEventListener("load", () => publish(true), { once: true });
    window.addEventListener("beforeunload", () => {
        clearInterval(timer);
        api.publishGatewaySnapshot({ chatId: null, title: "桌面端正在重新加载", agentEnabled: false,
            running: false, status: "unavailable", activity: "桌面端暂不可用", messages: [], queuedCount: 0, updatedAt: Date.now() });
    }, { once: true });
    publish(true);
})();
