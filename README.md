<div align="center">

![Logo](logo.png)

# AIUI
### Your Next Gen Vibe Coding Toolkit

基于浏览器前端与 Electron 的 AI 对话桌面应用，覆盖文字聊天、Canvas 编码、语音聊天、附件解析、图像生成和本地 Windows 打包。

[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Version](https://img.shields.io/badge/version-V5.3.0-blue)]()

</div>

---

## 项目概览

AIUI 是一个以单页前端为核心的 AI 工作台，同时提供 Electron 桌面壳。当前版本重点覆盖以下能力：

- `/canvas` 编码模式：在对话旁直接生成和编辑代码画布。
- 多模型聊天：可配置 API Key、Base URL、模型列表和默认模型。
- 语音聊天模式：使用 Silero VAD、讯飞流式听写和 Fish Audio HTTP TTS。
- 附件解析：支持图片、`.docx`、`.pptx`、`.xlsx`、`.txt`、`.md` 等文件。
- 图像生成增强：支持在提示词中写入 `16:9`、`4:3`、`1:1` 等宽高比关键词。
- 上下文压缩：支持自动摘要、手动 `/compact` 和独立摘要模型。

---

## 最近更新

### V5.3.0

- 语音聊天字幕字号和行间距微调，黑白界面的长文本显示更紧凑。
- AI 回应字幕支持按句自动跟随滚动，当前播报句会保持在可视区域中部附近。
- 用户仍可手动滚动查看上下文；5 秒无操作后会自动回到跟随模式。
- AI 生成文字与用户识别文字都加入了淡入动画。

### V5.2.0

- 图像生成 / 编辑支持提示词宽高比关键词，并自动映射到图像请求尺寸。
- 图像重试会保留原始提示词并重新计算比例参数。

### V5.1.0 / V5.0.0

- 新增 Electron 语音聊天入口与独立语音页面。
- 支持模型列表编辑、上下文压缩、语音轮次回传当前对话。
- 增加 Windows Portable 与 Setup 构建配置。

完整记录见 [UPDATE.md](UPDATE.md)。

---

## 核心功能

### 1. Canvas 编码模式

- 在输入框发送 `/canvas` 后，右侧会进入代码画布模式。
- 画布基于 CodeMirror，支持语法高亮、行号与手动编辑。
- AI 可通过 `[replace]` 风格的替换指令对画布内容做精确修改。
- 代码画布内容会自动参与上下文，适合持续迭代式编程。

### 2. 语音聊天模式

- 独立 `audiochat.html` 页面，采用纯黑 / 纯白双分区布局。
- 上半区显示 AI 字幕，下半区显示用户识别文本。
- AI 字幕会随当前播报句自动滚动，同时保留用户手动滚动能力。
- 对话中的实时字幕带有淡入效果，阅读反馈更自然。

### 3. 多模型与 API 配置

- 支持自定义 Base URL、API Key、模型列表和默认模型。
- 内置多组模型名称，适合在不同供应商之间切换。
- 模型配置保存在本地，便于个人环境长期使用。

### 4. 图像与附件工作流

- 支持图片粘贴、图片上传和常见 Office 文档解析。
- 图像请求支持提示词中的宽高比关键词。
- 附件内容会被提取后注入当前对话上下文。

### 5. 上下文压缩

- 可在长对话中自动或手动压缩上下文。
- 摘要用于降低发送给模型的上下文长度，不覆盖原始聊天记录。

---

## 运行方式

### 浏览器方式

直接打开 `index.html` 即可运行基础前端界面。

### Electron 方式

```bash
npm install
npm start
```

---

## Windows 构建

项目当前使用 `electron-builder` 生成以下 Windows 产物：

- Portable：`AIUI5.3.0-Portable.exe`
- Setup：`AIUI5.3.0-Setup.exe`

构建命令：

```bash
npm run build
```

构建输出目录为 `dist/`。

---

## 主要文件

- `index.html`：主对话界面与前端逻辑
- `audiochat.html`：语音聊天界面
- `main.js`：Electron 主进程
- `preload.js`：Electron 预加载桥接
- `package.json`：版本、脚本与构建配置
- `UPDATE.md`：版本更新记录

---

## 版本信息

- 当前版本：`V5.3.0`
- 当前构建标识：`build20260802`

---

## License

本项目基于 [MIT License](LICENSE) 发布。
