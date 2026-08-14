# INDEX.md — 代码地图 / 快速定位指南

> 目的：让一个**没有任何上下文**的 AI 或开发者，只看这份文件就能快速理解 `index.html` 与 `voicechat-api.js` 的结构、每段代码的功能，以及它们之间的调用关系，从而快速定位「要改哪一段」。

---

## 一、文件总览

| 文件 | 作用 |
|------|------|
| `index.html` | **主窗口**：聊天界面 + 全部前端逻辑（单文件，含 CSS / HTML / 内联 JS） |
| `voicechat-api.js` | **语音/协作窗口共用的 API 适配层**，暴露 `window.VoiceChatAPI`（流式请求 + 响应解析） |
| `audiochat.html` | 语音聊天 / 桌面协作实际运行的窗口，引用 `voicechat-api.js` |
| `desktopwork.html` | 只是 `location.replace('./audiochat.html?mode=desktop')` 的空壳重定向 |
| `main.js` | Electron 主进程：窗口管理、托盘、自动更新、科大讯飞 STT、Fish Audio TTS、IPC |
| `preload.js` | 预加载桥，把主进程能力暴露为 `window.electronAPI.*` |

**核心结论**：`index.html` 是独立、自包含的前端（浏览器直接打开也能跑基础功能）；它通过 `window.electronAPI` 与 Electron 主进程通信。`voicechat-api.js` 只被 `audiochat.html` 使用，**不被** `index.html` 直接引用，但它复刻了 `index.html` 内部的流式请求逻辑（见下文「代码之间的联系」）。

---

## 二、`index.html` 结构

整个文件分三大块，按行号划分（行号会随编辑变动，改前用 `grep -n` 确认）：

| 行号范围（约） | 块 | 说明 |
|---|---|---|
| 1–2085 | `<head>` + `<style>` | 引入第三方库 + 全部 CSS |
| 2086–2964 | `<body>` HTML | 界面骨架（侧边栏、聊天区、输入区、Canvas、设置弹窗等） |
| 2965–7446 | `<script>` 内联 JS | 全部业务逻辑 |

### 2.1 `<head>`（1–23 行）：第三方库

`tailwindcss.js`、`lucide.js`（图标）、`marked.js`（Markdown 渲染）、`dompurify.min.js`（XSS 清洗）、`katex.min.js`（公式）、`highlight.js`、`mammoth.min.js`（docx 解析）、`pptxtojson.js`（pptx）、`xlsx.min.js`（xlsx）、`codemirror.min.js`（代码画布）、`javascript.min.js`。

### 2.2 CSS（24–2085 行）

大量自定义样式，重点记住几个通用类：

- `:root` / `body.theme-light` / `body.theme-dark`：主题变量（`--accent-primary` 等）。**换主题色要改这里**。
- `.cloud-toggle`（约 1750 行）：**通用开关滑块**（名字里有 cloud 但已与云端无关，被自动更新、开发者模式等多个设置复用，别删）。
- `.user-bubble` / `.ai-bubble`（约 147/396/577 行）：聊天气泡样式。

### 2.3 `<body>` HTML 骨架（2086–2964 行）

| 行号（约） | 区块 | 关键 id |
|---|---|---|
| 2086–2099 | 侧边栏 | `#sidebar`、`#chat-history`（会话历史列表） |
| 2101–2110 | 顶部栏 | `#active-chat-title`、`#canvas-toggle-btn` |
| 2111–2305 | 主聊天区 | `#messages-wrapper`、`#user-input`、`#model-select`、`#send-btn`、`#stop-btn`、`#attach-menu`、`#voice-btn` |
| 2307–2321 | Canvas 画布 | `#canvas-panel`、`#canvas-codemirror`、`#canvas-status` |
| 2323–2336 | 重试弹层 / 图片灯箱 | `#retry-popover`、`#retry-model-select`、`#image-lightbox` |
| 2338–2352 | 语音提示 / 回放 | `#voice-notification`、`#voice-replay-island` |
| 2353–2942 | 设置弹窗 | `#settings-modal`，内含多个 `section-*` 分区（见下） |
| 2943–2964 | 确认弹窗 | `#compact-confirm-modal`、`#danger-confirm-modal` |

**设置弹窗分区**（`<nav>` 内 `data-section` 与 `section-*` 一一对应）：
`ai-chat`(对话设置) / `appearance`(外观) / `coding`(编码) / `api`(API配置) / `desktop-work`(桌面协作) / `other`(其他) / `voice-chat`(语音聊天) / `advanced`(开发调试) / `guide`(使用指导) / `about`(关于)。

> 切换分区逻辑在 JS 的 `switchSettingsSection()`（约 5435 行）；每个分区的回填逻辑是一组 `populateXxxSettings()` 函数。

### 2.4 内联 `<script>` 业务逻辑（2965–7446 行）

按功能域分组（行号为当前近似值）：

#### (a) 常量 & 全局状态（2966–2990、4292–4352）
- 2966–2979：`DEFAULT_*` 常量（API Key、Base URL、语音模型、讯飞/Fish 凭据等）。**改默认值在这。**
- 4292–4352：运行时全局变量（`chats`、`activeChatId`、`systemPrompt`、`currentTemp`、`currentAttachments`、模型列表等）。状态几乎都持久化到 `localStorage`。

#### (b) 弹窗动画 & API 配置读取（2992–3028）
- `openAnimatedModal` / `closeAnimatedModal`：设置弹窗的淡入淡出。
- `getAPIKey()` / `getBaseURL()`：读 localStorage 的 API 配置。

#### (c) 图片存储 ImageStore（约 3028–3102）
- 基于 **IndexedDB**（库名 `AIChatImages`）的 `storeImage / getImage / deleteImage`。附件图片以 base64 存 IndexedDB，消息里只存 `imageRef` 引用。

#### (d) 语音回放（约 3200–3463）
- `VoiceReplay` 类 + `playVoiceRecord()`：AI 语音的连续回放播放器（进度条、暂停、拖动）。

#### (e) 旧数据迁移 & 引用解析（3468–3561）
- `resolveMessageReferences()`：把消息里的图片引用还原成真实数据。
- `migrateOldChats()`：老版本数据结构升级。
- `getLastImageInChat()`：取对话最后一张图（用于生成请求上下文）。

#### (f) 上下文压缩（3563–3800）
- `ensureContextCompactionState` / `getCompleteConversationTurns` / `requestContextSummary` / `compactConversationTurns` / `performAutomaticCompaction` / `requestManualCompaction`。
- 核心：把长对话按轮次摘要成独立摘要，降低发给模型的上下文。`/compact` 命令 → `requestManualCompaction`。

#### (g) API 请求组装（3802–3893）
- `buildSingleApiMessage` / `buildAPIMessagesWithTemp` / `buildAPIMessagesWithContext`：把聊天记录 + 附件 + 画布上下文组装成 `messages` 数组。

#### (h) 端点与流式解析（3894–4291）
- `getRequestEndpoint()`：决定用 `/responses` 还是 `/chat/completions`。
- `buildResponsesInputFromMessages` / `buildRequestPayloadForEndpoint`：把 chat 消息转成两种端点的请求体。
- `extractStreamingUpdate` / `extractResponsesOutputText` / `extractChatCompletionUpdate` / `mergeStreamingText` / `parseSSEEventBlock`：解析 SSE 流式输出。
- `fetchEndpointWithFallback()`：**实际发请求**；`/responses` 返回 501 时自动回退 `/chat/completions`。
- `logPromptCacheDebug` / `comparePromptCachePrefixes`：Prompt Cache 命中调试。

#### (i) 日志系统（4324–4335、6985–7040）
- `shouldLog` / `appendLog` / `exportLogs` / `clearLogs`：按 `logLevel` 记录到内存 + localStorage，可导出。

#### (j) 模型列表管理（4346–4424）
- `loadModelList` / `renderModelOptions` / `applyTextModelList` / `onModelSelectionChange`：主模型选择器与重试选择器的同步更新。

#### (k) 图片模式 & 精细度（4432–4522）
- `IMAGE_MODELS` 列表 + `getImageDetailConfig` / `onImageDetailChange`：图片生成的精细度档位。

#### (l) Markdown / 数学 / 清洗渲染（4530–4670）
- `extractAndPreserveMath` / `restoreAndRenderMath` / `renderMathFormulas`：KaTeX 公式保护与渲染。
- `sanitizeHtml`（DOMPurify 兜底）→ `renderAssistantMarkdown`（marked 解析 + 清洗）→ `renderThinkingText`（思考文本加粗）→ `escapeHtml`。
- **所有 AI 输出渲染都要过 `renderAssistantMarkdown` + `sanitizeHtml`，防 XSS。改渲染链路在这。**

#### (m) 附件处理（4670–5048）
- `compressImage` / `estimateTotalTokens` / `updateTokenEstimate`。
- `triggerFileInput` / `handleFileSelect` / `extractTextFromDocx/Pptx/Xlsx` / `readFileAsAttachment` / `removeAttachment` / `clearAttachments` / `renderAttachmentPreviews` / `handlePaste`。

#### (n) 消息渲染（5088–5263）
- `renderMessagesWithResolvedRefs` / `renderMessages` / `appendMessageToUI`：把消息画到界面（气泡、复制/重试按钮、思考区、画布替换提示）。

#### (o) 设置弹窗逻辑（5306–5630）
- `toggleSettings` / `switchSettingsSection`（分区切换 + 各自 populate）/ `populateXxxSettings()` / `saveSettings()`（**保存设置的入口**）/ `generateVoiceChatPreset`。
- `setTemp` / `setFontSize` / `setTheme` / `setAccentColor` / `setBackgroundImage` / `setCanvasFontSize` / `setLayoutMode` / `applyLayoutMode`：各种外观/布局设置。

#### (p) 更新日志展示（5491–5562）
- `parseUpdateLog` / `loadUpdateLog` / `toggleUpdateHistory`：读主进程的 `getUpdateLog`，渲染「关于」里的更新记录。

#### (q) 输入框 & 重试（5736–5806）
- `autoResize` / `resetInputState`。
- `syncRetrySelect` / `openRetryMenu` / `confirmRetry` / `stopGeneration`：重试模型选择、停止生成。

#### (r) Canvas 编码模式（5808–5978）
- `getCanvasCode` / `setCanvasCode` / `updateCanvasPanelForChat` / `buildCanvasContextString`。
- `parseAndApplyReplaceBlocks` / `replaceBlocksToSummary`：解析 AI 的 `canvas[replace]with[N行]` 指令并应用到 CodeMirror 画布。

#### (s) 会话管理（5978–6079）
- `renderChatHistory` / `filterChats` / `deleteChat` / `createNewChat` / `switchChat`：会话增删改查、持久化到 `ai_chats`。

#### (t) 发送消息（6081–6157）
- `sendMessage()`：主入口。处理 `/compact`、`/canvas`、图片模式，组装用户消息、写 localStorage、自动压缩、调 `requestAI`。

#### (u) 语音聊天 / 桌面协作桥接（6204–6392）
- `hasImageInChat` / `getVoiceChatSettingsSnapshot` / `startConversationMode` / `startAudioChat` / `startDesktopWork`。
- `applyCompletedAudioChat()`：语音/协作结束后，把轮次写回主会话。
- Electron IPC：`onAudioChatCompleted`、`onTrayAction`（托盘命令）。

#### (v) 图片生成 / 编辑（6415–6712）
- `switchToImageGeneration` / `switchToImageEdit` / `exitImageMode`。
- `parseImageAspectRatio` / `sendImageMessage` / `retryImageGeneration`。

#### (w) 语音输入（6717–6844）
- `toggleVoiceRecording` / `encodeWAV` / `transcribeAudio` / `insertTextAtCursor`：录音 → 转文字 → 插入输入框（转写走 `voiceModel`，实际 STT 由主进程科大讯飞完成）。

#### (x) 启动入口（6861–6944）
- `window.onload`：**应用初始化**。加载主题/模型/会话、`renderChatHistory`、绑定事件、注册 `onUpdateAvailable` 等。

#### (y) 自动更新 & 日志开关（7041–7131）
- `onAutoUpdateToggleChange` / `showAvailableUpdateVersion` / `showCurrentVersionLatest` / `onLogLevelChange` / `onRecordLogsToggleChange` / `populateOtherSettings` / `populateAdvancedSettings`。

#### (z) 核心请求 `requestAI`（7158–结束）
- **AI 对话的主函数**：构建 system + messages → `fetchEndpointWithFallback` 流式接收 → 逐 token 渲染 → 完成后写入消息并持久化。改「如何请求/渲染 AI 回复」在这。

---

## 三、`voicechat-api.js` 结构（共 204 行）

一个**自包含 IIFE**，不依赖其他库，最终只暴露 `window.VoiceChatAPI = { buildPayload, streamText }`。**只被 `audiochat.html`（语音聊天 / 桌面协作窗口）使用**，`index.html` 不引用它。

### 3.1 函数地图（按行号）

| 行号 | 函数 | 作用 |
|---|---|---|
| 2–18 | `extractText(value)` | 统一提取纯文本：兼容 string / 数组（取 `part.text` / `part.output_text`）/ 对象（`text` / `output_text` / `content`） |
| 20–45 | `buildResponsesInput(messages)` | 把消息数组转成 `/responses` 的 `input`：**无图片** → 拼成 `user:` / `assistant:` 纯文本；**有图片** → 逐 part 转成 `input_text` / `input_image` / `input_file` |
| 47–60 | `buildPayload(basePayload, endpoint)` | 端点适配：非 `/responses` 原样透传；是 `/responses` 则拆解 `system`→`instructions`、`messages`→`input`、`max_tokens`→`max_output_tokens`，并丢掉 `prompt_cache_key`/`cache_control` |
| 62–73 | `extractResponsesOutput(payload)` | 从 `/responses` 完整响应抽最终文本：优先 `output_text`，否则遍历 `output[]` 里 `message`/`assistant` 项的 `content` |
| 75–93 | `extractUpdate(payload, endpoint)` | 单个 SSE 事件 → `{delta?, snapshot?}`：区分 `/chat/completions` 的 `choices[].delta/message` 与 `/responses` 的 `response.*` 事件类型 |
| 95–103 | `mergeText(current, delta, snapshot)` | 增量/快照合并：`delta` 追加、`snapshot` 去重与回退（用 `startsWith` 判定完整文本） |
| 105–114 | `parseEvent(block)` | 解析 SSE 块，返回 `{data, eventType}`（识别 `data:` / `event:` 行） |
| 116–201 | `streamText(options)` | **核心入口**，完整流程见 3.2 |
| 203 | 导出 | `window.VoiceChatAPI = { buildPayload, streamText }` |

### 3.2 `streamText` 流程（116–201）

1. 定端点：`/chat/completions` 或 `/responses`（`preferredEndpoint`）。
2. `buildPayload` 组装请求体 → `fetch(baseUrl + endpoint)`，带 `Authorization: Bearer`。
3. **501 回退**：`/responses` 返回 501 → 丢弃响应、切到 `/chat/completions` 重发，并回调 `options.onFallback(endpoint)`。
4. 非 2xx → 抛错（附前 300 字符详情）。
5. 无流式 body → 一次性解析后 `onText(text)`。
6. 有流式 → `getReader()` 逐块读，按 `\n\n` 切 SSE 块 → 逐块 `consumeEvent`（`parseEvent` + `JSON.parse`）→ `applyPayload`（错误 / 增量 / 快照）→ 累积 `fullText` 并 `onText(fullText)`。
7. 返回 `{ text, endpoint }`。

### 3.3 关键点 / 改动提示

- 与 `index.html` 内的流式逻辑**功能重复**（见 4.3），改请求格式或解析逻辑时**两处必须同步**。
- `buildPayload` 只对 `/responses` 做转换；`/chat/completions` 的 payload 直接透传。
- 图片识别只看 `image_url` / `input_image` / `input_file` 三种 part 类型；其余文本统一 `input_text`。
- 错误事件：`response.error` / `response.failed` 或 payload 内出现 `error.message` 都会抛错。

---

## 四、代码之间的联系（重点）

### 4.1 数据流（主链路）

```
用户输入 → sendMessage() (index.html)
        → 组装 chat.messages + 附件/画布上下文
        → requestAI() (index.html)
        → fetchEndpointWithFallback() → fetch(base_url + /responses 或 /chat/completions)
        → 流式解析 → appendMessageToUI 逐字渲染
        → 写 localStorage('ai_chats') + renderChatHistory()
```

### 4.2 `index.html` ↔ Electron（`preload.js` / `main.js`）

- `index.html` 通过 `window.electronAPI.*`（由 `preload.js` 的 `contextBridge` 暴露）调主进程。
- 主要 IPC：
  - `openAudioChat` / `openDesktopWork` → 主进程开 `audiochat.html` / `desktopwork.html` 窗口。
  - `audio-chat:completed`（`onAudioChatCompleted`）→ 语音/协作结束后，主进程把轮次回传，`applyCompletedAudioChat` 写回主会话。
  - `generateVoicePreset` / `requestFishSpeech` / `startXunfei` → 语音预制、TTS、STT。
  - `updateAppState` / `signalRendererReady` / `onTrayAction` → 托盘与主进程状态同步。
  - `onUpdateAvailable` / `onUpdateNotAvailable` → 自动更新提示。

### 4.3 `voicechat-api.js` 与 `index.html` 的关系

- **不是** index.html 的依赖；它是给 `audiochat.html` 用的独立适配层。
- 但它与 index.html 里的这段逻辑**功能重复**：
  - `voicechat-api.js` 的 `streamText` ≈ `index.html` 的 `fetchEndpointWithFallback` + 流式解析函数。
  - `buildPayload` ≈ `buildRequestPayloadForEndpoint` + `buildResponsesInputFromMessages`。
  - `extractUpdate`/`extractResponsesOutput` ≈ `extractStreamingUpdate`/`extractResponsesOutputText`。
- **改 API 请求/解析格式时，两处要同步改**，否则语音/协作窗口和主聊天窗口行为会不一致。

### 4.4 持久化（localStorage 键速查）

| 键 | 含义 |
|---|---|
| `ai_chats` | 所有会话（JSON 数组，含 messages/canvas/contextCompaction） |
| `api_key` / `base_url` | API 配置 |
| `sys_prompt` / `chat_temp` | 系统提示词 / 温度 |
| `model_list` / `selected_model` | 模型列表 / 当前模型 |
| `theme` / `font_size` / `accent_color` / `bg_image` / `layout_mode` | 外观 |
| `voice_model` / `voice_*` / `xf_*` | 语音转写与 TTS 凭据 |
| `max_tokens_limit` / `auto_summary_interval` | 上下文与预算 |
| `developer_mode` / `log_level` / `record_logs` | 调试 |
| 图片 | IndexedDB 库 `AIChatImages`（不存 localStorage） |

---

## 五、快速定位：想改 X，去哪找

| 想改什么 | 位置 |
|---|---|
| AI 请求方式 / 端点 / 回退 | `index.html` `fetchEndpointWithFallback` + `buildRequestPayloadForEndpoint`（约 4002–4291） |
| AI 回复如何渲染 / Markdown / 防 XSS | `renderAssistantMarkdown` + `sanitizeHtml`（约 4610–4642） |
| 发送消息流程 | `sendMessage`（6081）+ `requestAI`（7158） |
| 会话存储 / 增删 | `createNewChat` / `deleteChat` / `switchChat`（6022–6079）+ localStorage `ai_chats` |
| 上下文压缩 | `performAutomaticCompaction` / `compactConversationTurns`（3563–3800） |
| Canvas 编码 / replace 指令 | `parseAndApplyReplaceBlocks` / `buildCanvasContextString`（5808–5978） |
| 设置弹窗 / 保存设置 | `switchSettingsSection` / `saveSettings`（5435、5631）+ HTML `section-*` |
| 模型列表 / 选择器 | `loadModelList` / `onModelSelectionChange`（4346–4424） |
| 附件 / 文档解析 | `handleFileSelect` / `extractTextFromDocx` 等（4746–5048） |
| 语音输入转文字 | `toggleVoiceRecording` / `transcribeAudio`（6717–6844） |
| 语音/协作窗口的流式请求 | `voicechat-api.js` 的 `streamText`（116） |
| Electron 主进程 / 托盘 / 更新 / STT / TTS | `main.js` |
| 主进程↔渲染进程桥 | `preload.js` |
| 默认值（API Key、URL、模型等） | `index.html` 顶部 `DEFAULT_*`（2966–2979） |
| 界面骨架 / 布局 | `index.html` body（2086–2964） |
| 主题色 / 样式 | `index.html` CSS（24–2085，重点 `:root` 变量与 `.cloud-toggle`） |

---

## 六、Agent Tool Calling（V7.0.0 Canary 4）

### 7.1 文件与主链路

| 文件 | 作用 |
|---|---|
| `agent-protocol.js` | 固定 Tool Definitions/Core Rules、连续独立 JSON 对象与交错正文段解析、当前时间格式化。浏览器和 Node 测试均可复用。 |
| `agent-tools.js` | 主进程使用的工作区 realpath 校验、行范围读取、覆盖写入、唯一文本替换、行差异生成、Shell 执行器和命令前缀匹配。 |
| `agent-ui.js` | Agent 会话绑定、上下文组装、正文/工具顺序渲染、模型请求循环、工具结果 IndexedDB 持久化、正文内命令授权、可折叠 diff/命令输出和绿竖线工具状态。 |
| `alwaysAllowedCommand.txt` | 发布包内置安全命令前缀；用户增项写入 Electron `userData/alwaysAllowedCommand.user.txt`。 |
| `test/agent-*.test.js` | 不调用 AI API 的协议、路径、文件、白名单和 Shell 单元测试。 |

### 7.2 Agent Loop 顺序

```
固定 system 前缀（Tool Definitions → Core Rules → 用户提示 → Environment）
        → 历史消息与完整 Tool Result
        → Current Time
        → Latest User Message
        → 模型连续独立 JSON Tool Call
        → 主进程执行并追加 role=tool 历史
        → 再次请求模型
        → finish_task → 显示最终文本并结束
```

Agent 工具 JSON 不直接渲染给用户。解析器将单次回复拆成有序正文段和工具段，清理 `<json>` 包装和多余空行；可见 Agent 文本在进入 Markdown/KaTeX 前还会再次剥离工具对象。模型 SSE 事件按 `id` 或 `sequence_number` 去重，因此正文、工具提示可以交错显示且不会在后续任务中重复 JSON。`finish_task` 提示嵌在最终回复正文和模型/复制页脚之间。`read_file_range`、`write_file`、`edit_file`、`run_shell` 和 `finish_task` 使用强调色图标、绿竖线和动态行数/字符数/毫秒耗时/字节数展示。写入/编辑差异与 Shell 输出可以点击工具提示展开或折叠，并按 Agent 设置保留 10、20、50 行或完整显示。工具消息不会被上下文压缩删除；Agent 自动压缩按已完成的用户任务轮次统计，内部循环调用不计数。

### 7.3 Electron IPC

`preload.js` 暴露 `selectAgentWorkspace`、`getAgentWorkspace`、`executeAgentTool`、`checkAgentCommand`、`saveAgentCommandAdditions` 和 Shell 进度/取消接口；`main.js` 通过 `agent-workspaces.json` 绑定会话与工作区，并在每次文件操作再次校验路径和符号链接边界。

---

## 七、备注（给后续 AI 的提醒）

- 2026-08 已**彻底移除 LeanCloud 云端同步与云端记忆**相关代码：`getLCConfig`、`syncData`、`pushToCloud`、`lcFetch`、`fetchMemoriesFromCloud`、`renderMemoriesToSettings`、`DEFAULT_LC_*`、`lcObjectId` 等符号已不存在于 `index.html`。数据只存本地（localStorage + IndexedDB）。若在别处看到这些符号，说明是旧文档/旧分支。
- `index.html` 单文件近 7500 行，改前用 `grep -n "函数名" index.html` 确认最新行号，本 md 行号仅作近似参考。
- 改 API 解析逻辑时务必同步 `index.html` 与 `voicechat-api.js` 两处。
