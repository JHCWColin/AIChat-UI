"use strict";

// Run with Electron: electron src/test/memory-smoke.js
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, dialog, session } = require("electron");

const profile = mkdtempSync(path.join(os.tmpdir(), "aiui-memory-smoke-"));
app.setPath("userData", profile);
app.disableHardwareAcceleration();
require("../main/main");

const memoryTool = "manage_memory";
const ordinaryMemory = "用户偏好代码示例采用四格缩进。";
const revisedMemory = "用户偏好代码示例采用两格缩进。";
const agentMemory = "用户希望测试报告使用简体中文。";
const audioMemory = "用户偏好语音回复简洁。";
const desktopMemory = "用户偏好桌面协作时先总结屏幕。";
const ignoredMemory = "这项内容不应被记忆。";
const firstQuestion = "请采用我的代码风格偏好。";
const agentQuestion = "记住我的测试报告语言偏好。";
const audioQuestion = "测试一段语音应答。";
const desktopQuestion = "测试一次桌面协作。";
const disabledQuestion = "现在测试关闭记忆。";
const updateQuestion = "修改代码缩进偏好。";
const deleteQuestion = "忘记我的语音回复偏好。";
const ordinaryAnswer = "我会按照你的偏好提供代码示例。";
const agentAnswer = "之后会用简体中文撰写测试报告。";
const voiceAnswer = "语音回复只包含这句话。";
const requests = [];
const images = [];

function completion(body) {
    const user = body.messages.findLast(message => message.role === "user")?.content;
    if (body.messages.some(message => message.role === "tool")) return { text: "" };
    if (user === firstQuestion) return { text: ordinaryAnswer, memory: ordinaryMemory };
    if (user === agentQuestion) return { text: `${agentAnswer}\n{"tool_call":{"name":"finish_task","arguments":{}}}`, memory: agentMemory };
    if (user === audioQuestion) return { text: voiceAnswer, memory: audioMemory };
    if (user === desktopQuestion) return { text: voiceAnswer, memory: desktopMemory };
    if (user === disabledQuestion) return { text: "记忆已关闭。", memory: ignoredMemory };
    if (user === updateQuestion) return { text: "我会采用新偏好。", operation: { action: "update", previous_text: ordinaryMemory, text: revisedMemory }, dsml: true };
    if (user === deleteQuestion) return { text: "明白了。", operation: { action: "delete", previous_text: audioMemory } };
    return { text: "已收到。" };
}

const server = http.createServer(async (request, response) => {
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type" };
    if (request.method === "OPTIONS") {
        response.writeHead(204, headers).end();
        return;
    }
    const isImageRequest = ["/v1/images/generations", "/v1/images/edits"].includes(request.url);
    if (request.method !== "POST" || (!isImageRequest && request.url !== "/v1/chat/completions")) {
        response.writeHead(404, headers).end();
        return;
    }
    try {
        let source = "";
        for await (const chunk of request) source += chunk;
        if (isImageRequest) {
            images.push({ url: request.url, source });
            response.writeHead(200, { ...headers, "Content-Type": "application/json" });
            response.end(JSON.stringify({ data: [{ b64_json:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jENQAAAAASUVORK5CYII=" }] }));
            return;
        }
        const body = JSON.parse(source);
        requests.push(body);
        const { text, memory, operation = memory ? { action: "add", text: memory } : null, dsml } = completion(body);
        response.writeHead(200, { ...headers, "Content-Type": "text/event-stream" });
        const emit = (delta, finish_reason = null) => {
            response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        };
        if (text) emit({ content: text });
        if (dsml) {
            emit({ content: "\n<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name=\"manage_memory\">" });
            for (const [key, value] of Object.entries(operation)) {
                emit({ content: '<｜｜DSML｜｜ parameter name="' + key + '" string="true">' + value + '\\' });
                emit({ content: '</｜｜DSML｜｜ parameter> ' });
            }
            emit({ content: "\\</｜｜DSML｜｜ invoke> \\</｜｜DSML｜｜ calls>" });
        } else if (operation) {
            const args = JSON.stringify(operation);
            emit({ tool_calls: [{ index: 0, id: `memory-${requests.length}`, type: "function",
                function: { name: memoryTool, arguments: args.slice(0, 13) } }] });
            emit({ tool_calls: [{ index: 0, function: { arguments: args.slice(13) } }] });
        }
        emit({}, operation && !dsml ? "tool_calls" : "stop");
        response.end("data: [DONE]\n\n");
    } catch (error) {
        response.destroy(error);
    }
});

const evaluate = (win, fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function until(read, label) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        const value = await read();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${label}`);
}

async function send(win, text) {
    const requestIndex = requests.length;
    await evaluate(win, async question => {
        document.getElementById("user-input").value = question;
        await sendMessage();
    }, text);
    assert.ok(requests[requestIndex], `the mock received a request for ${text}`);
    return requests[requestIndex];
}

function fixedPrefix(body) {
    return {
        system: body.messages.filter(message => message.role === "system"),
        tools: body.tools,
        cacheKey: body.prompt_cache_key
    };
}

function conversation(win) {
    return evaluate(win, () => ({
        messages: chats.find(chat => chat.id === activeChatId).messages,
        displayed: document.getElementById("messages-wrapper").innerText
    }));
}

async function assertPrivate(win, expectedAnswer, memory) {
    const { messages, displayed } = await conversation(win);
    assert.ok(displayed.includes(expectedAnswer));
    assert.ok(!displayed.includes(memoryTool) && !displayed.includes(memory));
    assert.ok(!JSON.stringify(messages).includes(memoryTool) && !JSON.stringify(messages).includes(memory));
}

async function assertActivity(win, counts, expectedLabel) {
    const latest = await evaluate(win, () => {
        const chat = chats.find(item => item.id === activeChatId);
        const rows = document.querySelectorAll('#messages-wrapper .message-content-col');
        const status = rows[rows.length - 1]?.querySelector('.message-memory-activity');
        return {
            counts: chat.messages.findLast(message => message.role === 'assistant')?.memoryActivity ?? null,
            label: status?.textContent ?? null,
            positionedAfterAnswer: status?.previousElementSibling?.classList.contains('ai-bubble') ?? false
        };
    });
    assert.deepEqual(latest, { counts, label: expectedLabel, positionedAfterAnswer: Boolean(expectedLabel) });
}

async function checkSpecialMode(main, mode) {
    const question = mode === "desktop" ? desktopQuestion : audioQuestion;
    const memory = mode === "desktop" ? desktopMemory : audioMemory;
    const requestIndex = requests.length;
    await evaluate(main, kind => startConversationMode(kind), mode);
    const voiceWindow = await until(() => BrowserWindow.getAllWindows().find(win => (
        mode === "desktop" ? /audiochat\.html\?mode=desktop$/.test(win.webContents.getURL())
            : /audiochat\.html$/.test(win.webContents.getURL())
    )), `${mode} window`);
    await until(() => evaluate(voiceWindow, () => typeof controller !== "undefined" && Boolean(controller.session)), `${mode} session loaded`);
    try {
        const result = await evaluate(voiceWindow, async text => {
            const spoken = [];
            controller.enqueueSpeech = value => spoken.push(value);
            controller.playPresetVoice = async () => {};
            controller.turns.push({ role: "user", content: text });
            await controller.respond(text);
            return { spoken, displayed: controller.aiElement.innerText, turns: controller.turns };
        }, question);
        assert.deepEqual(result.spoken, [voiceAnswer]);
        assert.ok(result.displayed.includes(voiceAnswer));
        assert.ok(!result.displayed.includes(memoryTool) && !result.displayed.includes(memory));
        assert.deepEqual(result.turns.map(turn => ({ role: turn.role, content: turn.content })), [
            { role: "user", content: question }, { role: "assistant", content: voiceAnswer }
        ]);
        const body = requests[requestIndex];
        assert.ok(body?.tools?.some(tool => tool.function?.name === memoryTool));
        assert.ok(JSON.stringify(fixedPrefix(body)).includes(ordinaryMemory));
    } finally {
        voiceWindow.close();
        await until(() => voiceWindow.isDestroyed(), `${mode} window closed`);
    }
    await until(async () => (await conversation(main)).messages.some(message => message.content === question), `${mode} transcript imported`);
    await assertPrivate(main, voiceAnswer, memory);
    await assertActivity(main, { created: 1 }, 'Created 1 memory');
}

const watchdog = setTimeout(() => { console.error("Memory smoke test timeout"); app.exit(1); }, 110000);
app.whenReady().then(async () => {
    let exitCode = 0;
    try {
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        session.defaultSession.setPermissionRequestHandler((_contents, permission, decide) => decide(permission !== "media"));
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [profile] });
        const main = await until(() => BrowserWindow.getAllWindows().find(win => /index\.html$/.test(win.webContents.getURL())), "main window");
        await until(() => evaluate(main, () => Boolean(window.AIUIMemory && document.getElementById("input-max-lines"))), "main initialized");
        const base = `http://127.0.0.1:${server.address().port}/v1`;
        await evaluate(main, baseUrl => {
            closeSetupGuide();
            localStorage.setItem("first_setup_guide_shown", "1");
            localStorage.setItem("desktop_shortcut", "Ctrl+Alt+Shift+F11");
            localStorage.setItem("agent_native_notifications", "false");
            applyApiSettings({ api_key: "test-only", base_url: baseUrl, request_endpoint: "/chat/completions",
                max_tokens_limit: "0", model_list: '["memory-smoke"]', selected_model: "memory-smoke" });
            toggleSettings();
        }, base);
        const prefs = await until(() => BrowserWindow.getAllWindows().find(win => /preferences=1/.test(win.webContents.getURL())), "preferences window");
        const ready = () => evaluate(prefs, () => Boolean(document.getElementById("input-max-lines") && document.getElementById("settings-modal").classList.contains("modal-active")));
        await until(ready, "preferences initialized");
        const memoryChecked = () => evaluate(prefs, () => document.getElementById("memory-enabled-toggle").checked);
        const toggleMemory = () => evaluate(prefs, () => document.getElementById("memory-enabled-toggle").click());
        assert.equal(await memoryChecked(), true);
        assert.equal(await evaluate(prefs, () => {
            const section = document.getElementById("section-ai-chat");
            const memory = document.getElementById("memory-enabled-toggle");
            const system = document.getElementById("sys-prompt");
            return section.contains(memory) && (memory.compareDocumentPosition(system) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        }), true);

        const first = await send(main, firstQuestion);
        assert.equal(first.tools?.[0]?.function?.name, memoryTool);
        assert.ok(!JSON.stringify(fixedPrefix(first)).includes(ordinaryMemory));
        await assertPrivate(main, ordinaryAnswer, ordinaryMemory);
        await assertActivity(main, { created: 1 }, 'Created 1 memory');
        await evaluate(main, async () => {
            const chat = chats.find(item => item.id === activeChatId);
            await renderMessagesWithResolvedRefs(chat.messages, true);
        });
        await assertActivity(main, { created: 1 }, 'Created 1 memory');
        const second = await send(main, "继续刚才的话题。");
        assert.deepEqual(fixedPrefix(second), fixedPrefix(first));
        await send(main, firstQuestion);
        await assertActivity(main, null, null);

        await evaluate(main, () => createNewChat());
        const next = await send(main, "开启一个新对话。");
        assert.ok(JSON.stringify(fixedPrefix(next)).includes(ordinaryMemory));
        await checkSpecialMode(main, "audio");
        await checkSpecialMode(main, "desktop");

        await toggleMemory();
        assert.equal(await memoryChecked(), false);
        await new Promise(resolve => {
            prefs.webContents.once("did-finish-load", resolve);
            prefs.webContents.reload();
        });
        await until(ready, "reloaded preferences");
        assert.equal(await memoryChecked(), false);
        const disabled = await send(main, disabledQuestion);
        assert.ok(!disabled.tools?.length);
        assert.ok(!JSON.stringify(fixedPrefix(disabled)).includes(ordinaryMemory));
        await assertPrivate(main, "记忆已关闭。", ignoredMemory);
        await toggleMemory();

        await evaluate(main, async () => {
            createNewChat();
            const chat = chats.find(item => item.id === activeChatId);
            const selection = await electronAPI.selectAgentWorkspace(chat.id);
            await electronAPI.confirmAgentWorkspace(chat.id, selection.path, selection.selectionId);
            chat.agentEnabled = true;
            chat.agentWorkspace = selection.path;
            chat.agentWorkspaceAvailable = true;
        });
        const agent = await send(main, agentQuestion);
        assert.ok(agent.tools?.some(tool => tool.function?.name === memoryTool));
        assert.ok(JSON.stringify(fixedPrefix(agent)).includes(ordinaryMemory));
        await assertPrivate(main, agentAnswer, agentMemory);
        await assertActivity(main, { created: 1 }, 'Created 1 memory');

        await evaluate(main, () => createNewChat());
        const afterAgent = await send(main, "检查 Agent 更新后的记忆。");
        assert.ok(JSON.stringify(fixedPrefix(afterAgent)).includes(agentMemory));
        assert.ok(JSON.stringify(fixedPrefix(afterAgent)).includes(audioMemory));
        assert.ok(JSON.stringify(fixedPrefix(afterAgent)).includes(desktopMemory));
        assert.ok(!JSON.stringify(fixedPrefix(afterAgent)).includes(ignoredMemory));

        await send(main, updateQuestion);
        await assertPrivate(main, "我会采用新偏好。", revisedMemory);
        await assertActivity(main, { updated: 1 }, 'Updated 1 memory');
        await send(main, deleteQuestion);
        await assertPrivate(main, "明白了。", audioMemory);
        await assertActivity(main, { deleted: 1 }, 'Deleted 1 memory');
        await evaluate(main, () => createNewChat());
        const revised = JSON.stringify(fixedPrefix(await send(main, "使用修订后的记忆。")));
        assert.ok(revised.includes(revisedMemory));
        assert.ok(!revised.includes(ordinaryMemory) && !revised.includes(audioMemory));
        const displayedMemories = await evaluate(prefs, () => document.getElementById("memory-list").innerText);
        assert.ok(displayedMemories.includes(revisedMemory));
        assert.ok(!displayedMemories.includes(ordinaryMemory) && !displayedMemories.includes(audioMemory));
        assert.equal(await evaluate(prefs, () => {
            const button = document.querySelector('#memory-list button');
            return button?.getAttribute('aria-label') === '删除记忆' && Boolean(button.querySelector('svg')) && !button.textContent.trim();
        }), true);

        await evaluate(main, async () => {
            createNewChat();
            const input = document.getElementById("user-input");
            switchToImageGeneration();
            input.value = "Draw one circle";
            await sendMessage();
            switchToImageEdit();
            input.value = "Make it blue";
            await sendMessage();
        });
        assert.deepEqual(images.map(image => image.url), ["/v1/images/generations", "/v1/images/edits"]);
        assert.ok(images.every(({ source }) => !source.includes(memoryTool) && !source.includes(revisedMemory)));
        console.log("Memory smoke passed");
    } catch (error) {
        console.error(error.stack || error);
        exitCode = 1;
    } finally {
        clearTimeout(watchdog);
        server.close();
        app.exit(exitCode);
    }
});
