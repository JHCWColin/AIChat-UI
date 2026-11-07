<div align="center">

![Logo](logo.png)

![preview](screenshot/preview.png)

# Your Next Gen Vibe Coding Toolkit
# Free Yourself with AGENT

一个绑定了令牌后即可像大型AI官网那样Agent服务、文字畅聊、语音聊天、共享屏幕、修改代码的前端AI聊天框架。不依赖任何realtime模型，用http调用方法配合STT、TTS、VAD、预设语音等技术实现实时功能。

[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Version](https://img.shields.io/badge/version-V9.1.0_Release-blue)]()
[![Agent](https://img.shields.io/badge/Agent-AVALIABLE-f5f0e6)]()

</div>

---

## 项目概览

AIUI 是一个以单页前端为核心、同时提供 Electron 桌面壳的 AI 工作台。当前版本重点覆盖以下能力：

- Agent工作流：让AI帮你直接修改文件、运行指令、读取文件等操作。
- 局域网 Agent 网关：在手机浏览器监看桌面当前 Agent 会话，并按授权追加任务消息。
- `/canvas` 编码模式：在对话旁直接生成和编辑代码画布。
- 桌面协作模式：透明置顶字幕、点击穿透、全局快捷键截图与语音上下文协作。
- 语音聊天模式：使用 Silero VAD、讯飞流式听写和 Fish Audio HTTP TTS。
- 多模型聊天：可配置 API Key、Base URL、模型列表和默认模型。
- 上下文用量：按模型选择本地 tokenizer 或估算方式，悬停查看消息、工具与系统提示等用量分解。
- 常驻系统托盘：支持新建或恢复最近会话，并可直接启动语音聊天或桌面协作。
- 语音回放：语音聊天模式生成的 AI 语音可保存并在主对话中回放。
- 附件解析：支持图片、`.docx`、`.pptx`、`.xlsx`、`.txt`、`.md` 等文件。
- 图像生成增强：支持在提示词中写入 `16:9`、`4:3`、`1:1` 等宽高比关键词。
- `/compact` 上下文压缩：支持自动摘要、手动和独立摘要模型。
- Agent Tool Calling：绑定工作区后，可通过标准 JSON 工具调用读取、写入、局部编辑文件并运行 Shell 命令。

---

## 最近更新

### V9.1.0 Release

- 提高背景通透度，去掉组件高光、发光阴影、悬停增亮和扫光。
- 恢复工具调用原来的居中宽度、左边界和缩进。
- 搜索摘要保持单行，超出显示省略号。

### V9.0.0 Release

- 全新模型与推理深度菜单、异步 Token 计数、Agent 用量与性能统计。
- Agent 信息侧栏、询问用户工具、增强工具解析及桌面系统通知。
- 独立偏好设置、可用模型发现、响应式输入框和统一主题布局。
- ZIP 会话导入导出、消息结束时间及三款新背景。
- 完整变更与计数限制请参阅 [更新日志](UPDATE.md)。

### V8.1.0 Release 局域网 Agent 网关

- 新增独立网关控制台和移动端远程页面，HTTP 轮询默认每秒同步。
- 支持网卡选择、端口、分级访问码、设备权限和一键踢线封禁。
- 远程设备仅访问桌面当前 Agent 会话，模型调用和工具执行全部留在桌面。

### V7.3.0 Release 增强中日韩解析能力

### V7.3.0 Release 修改Agent核心提示词

### V7.2.0 Release 修复缓存命中问题

### V7.1.0 Release 兼容Codex Claude Gemini的原生格式
- 当模型不遵循我们的工具调用规则，使用自家的agent工具的工具调用格式，我们也会支持。
- 全方位提升Agent体验，解决了大部分文本错位，正文被当作报错，连续产生空回复的问题。

### V7.0.0 Release Agent正式上线
- Agent 工作区选择后新增信任确认，自动扫描非依赖目录中的 `.txt` 与 `.md` 文件，并显示最多 5 个风险文件路径。
- Agent 首次触发自动上下文压缩前会询问用户，可直接改为不压缩、每 10、15 或 20 轮压缩，或保持当前设置。
- Agent 偏好设置新增内测与 API 分组兼容性警告，所有全屏 Agent 提示统一使用弹入弹出动画。
- Agent 固定提示词现在在会话创建时生成并持久化，包含稳定的会话开始时间。
- 删除每轮请求中插入的动态时间消息，避免第二次提问时改变已有前缀。
- 已存在的旧 Agent 会话会在下一次请求时补入该约束，之后保持不变。
- 普通聊天也会保存会话级 promptPrefix，后续只追加历史消息。
- 每个会话生成稳定的 prompt_cache_key，不同会话不会共用。
- /responses 端点现在保留 prompt_cache_key。


完整记录见 [UPDATE.md](UPDATE.md)。

---

## 核心功能

### Agent 局域网网关

1. 在 Electron 桌面端侧栏的「配置指引」上方点击「Agent 网关」，打开独立控制台；也可从系统托盘打开。
2. 选择监听 IP 和端口。默认优先使用物理网卡的 IPv4 地址，VPN、VMware 等虚拟接口排在后面；需要跨多个接口访问时可选择所有接口。
3. 开启网关，在同一局域网的手机或电脑浏览器中输入控制台显示的完整网址。Windows 防火墙需允许 Electron/AIUI 在所用网络接收入站连接。
4. 使用只读访问码监看，或先在控制台允许远程写入，再使用可写访问码。仅当前激活的 Agent 会话会被共享，切换会话后远程页面自动跟随。
5. 可写设备可以追加消息或继续下一轮任务；Agent 运行时消息进入原有队列，命令审批仍在桌面完成。远程页面不能选择历史会话、修改模型配置或直接调用工具。

控制台可热调轮询间隔（500–2000 毫秒）、会话有效期、设备上限及写入权限，亦可按设备降级、强制下线并封禁重连。更改监听地址或端口前需先关闭网关。关闭控制台窗口不会关闭服务，关闭网关或退出 AIUI 会使远程会话失效；每次启动应用均默认关闭网关。

远程页面同步当前会话的完整回复、全部工具调用及简略信息（例如运行指令第一行、文件路径、搜索关键词），并显示思考过程的开头与结尾几行。回复支持 Markdown 的代码块、表格、列表、链接与引用；页面支持亮暗主题，初次跟随系统，手动选择会被记住。

网关通过普通 HTTP 面向可信局域网提供服务，访问码及会话内容不经过加密传输；请勿将端口映射到公网。独立远程页面不保存模型凭据，网关不提供工作区文件下载、原始工具参数、命令输出或图片下载接口。

### 1. Agent 工作流

![agent-security](screenshot/agent-security.png)
![agent](screenshot/agent.png)

- 点击“+”进入Agent模式，绑定工作区后AI可以在此工作区内行动。
- AI通过五个基础工具来帮你操作本地文件，包括增查改删（CRUD）和运行指令，以及结束任务的工具。
- 处于Agent模式的会话不可退出。
- 用户可以选择指令运行的安全审查方式：仅安全指令和完全访问（YOLO Mode）。

### 2. Canvas 编码模式

![canvas](screenshot/code%20with%20canvas.png)

- 在输入框发送 `/canvas` 后，右侧进入代码画布模式。
- 画布基于 CodeMirror，支持语法高亮、行号与手动编辑。
- AI 可通过 `[replace]` 风格的替换指令精确修改画布内容。

### 3. 语音聊天模式

![audio-chat](screenshot/audiochat.png)
![audio-text](screenshot/audiochat%20can%20be%20saved%20to%20textchat.png)

- 独立 `audiochat.html` 页面，采用上下双分区字幕布局。
- 上半区显示 AI 字幕，下半区显示用户识别文本。
- AI 字幕支持按句自动跟随与逐句淡入。
- 语音聊天生成的 AI 语音可在主对话中按整次回复连续回放。
- 可在偏好设置中一键清除历史语音记录，不影响预制语音与后续新记录。
- 语音聊天可以从文字对话中途开始也可以之后转成文本继续对话。

### 4. 桌面协作模式

![desktop-work](screenshot/desktop%20work.png)

- 透明、无边框、始终置顶的横向字幕窗口默认停靠当前显示器底部。
- AI 与用户语音内容各占一行，白色字幕使用黑色文字阴影保证可读性。
- 除“结束对话”按钮区域外，窗口允许鼠标操作穿透到下层桌面。
- 全局传图快捷键默认是 `Ctrl+A`，截图精细度默认使用 1920px / JPEG 85。
- 多次截图只保留最后一张，并在下一次语音输入时作为用户消息附件发送。
- 可在偏好设置中开启自动传图；每轮语音结束后若没有手动截图，会自动截取鼠标所在显示器。
- 结束协作后，文字、AI 语音记录和截图会写回对应主会话。

### 5. 自动更新

- 仅 Windows Setup 安装版启用，Portable 版本和开发环境会跳过更新检查。
- “自动探测更新”默认开启，可在偏好设置“其他”中关闭。
- 启动时通过 GitHub Release 的 `latest.yml` 比较版本；发现更新后使用系统原生对话框询问用户。
- 下载阶段由 `electron-updater` 使用 Setup 对应的 `.blockmap` 自动执行差分更新。
- 每次 GitHub Release 必须同时上传 Setup 安装包、Setup `.blockmap` 和 `latest.yml`。

### 6. 多模型与 API 配置

![nulti-model-endpoint](screenshot/multi-model-and-endpoint.png)

- 支持自定义 Base URL、API Key、模型列表和默认模型。
- 模型配置保存在本地，适合长期个人环境使用。
- 主界面、语音聊天和桌面协作均支持 `/responses` 与 `/chat/completions`。
- `/responses` 返回 501 时会自动使用 `/chat/completions` 重试。

### 7. 图像与附件工作流

- 支持图片粘贴、图片上传和常见 Office 文档解析。
- 图像请求支持提示词中的宽高比关键词。
- 附件内容会在提取后注入当前对话上下文。

### 8. 上下文压缩

- 可在长对话中自动或手动压缩上下文。
- 摘要用于降低发送给模型的上下文长度，不覆盖原始聊天记录。

---

## 运行方式

npm install
npm start
npm run build  //构建

构建输出目录：`dist/`

测试：`npm test` 运行全部单元与接口回归；`npm run test:gateway-ui` 使用真实 Electron 窗口验证网关认证、监看、桌面消息队列、设备降权与强制下线（模型响应使用本地模拟）。

真实模型回归需显式设置环境变量 `AIUI_AGENT_LIVE_TEST=1`，再执行 `npm run test:agent-live`。此测试使用当前 Windows 用户 AIUI 的 API 连接配置和 `deepseek-flash`，会消耗 API 用量；仅在新建的临时工作区执行文件与进程操作，退出后清理临时配置与工作区，保留不含连接凭据的测试报告。

---

## 版本信息

- 当前版本：`V9.1.0 Release`
- 当前构建标识：`build20261101`

---

## License

本项目基于 [MIT License](LICENSE) 发布。
