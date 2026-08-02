<div align="center">

![Logo](logo.png)

# Your Next Gen Vibe Coding Toolkit.  
# 你的下一代AI编码工具。

**仅需 `/canvas`，然后描述你的需求。**

一个基于浏览器的现代化 AI 对话前端，支持 Canvas 编码画布、数十种大语言模型、  
附件预览与上传、云端同步以及丰富的个性化设置。

[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Version](https://img.shields.io/badge/version-V5.2.0-blue)]()

</div>

---

## 📸 运行截图

![主界面](/screenshot/ai.png)

---

## ✨ 核心功能

### 🎨 Canvas 编码模式
- 在输入框输入 **`/canvas`** 一键激活编码模式，对话区域右侧自动生成代码画布。
- 画布由 **CodeMirror** 驱动，支持语法高亮、行号显示、代码折叠。
- AI 通过 `[replace]` 语法精准修改代码（start/end 行号 + 代码块），前端实时解析并更新画布。
- 每次修改的代码行以 **暗绿色背景** 高亮，一目了然。
- 用户可在非生成状态下**手动编辑**画布代码，支持 **VSCode 同款等宽字体**。
- 画布内代码自动附加至 AI 上下文，形成**人机协作编程**。

### 🤖 多模型支持
内置 GPT-5.5、DeepSeek、Claude、Gemini、Qwen、MiniMax、GLM 等 **50+** 个模型，可随时切换。

### 💬 聊天管理
创建、切换、删除对话；侧边栏管理所有历史记录。

### 📎 附件系统
- 支持粘贴剪贴板图片
- 上传图片、`.docx`、`.pptx`、`.xlsx`、`.txt`、`.md` 等文件
- 自动提取 Office 文本内容（Mammoth / pptxtojson / SheetJS）
- 图片压缩，液态玻璃风格附件卡片预览

### 🌓 主题与界面
- 深色 / 浅色主题切换，毛玻璃背景，6 张可选背景图片
- 对话字体大小调节 + **Canvas 代码字号独立调节**
- 液态玻璃 UI 设计，响应式布局适配桌面与移动端

### 🧠 AI 个性化
- 自定义系统提示词（System Prompt）
- 调节回复倾向（Temperature）

### 💾 数据同步
对话数据自动保存至浏览器本地存储，支持 LeanCloud 云端同步。

### 🔍 其他
- 使用 KaTeX 渲染 `$$` 和 `$` 内的数学公式
- Highlight.js 提供语法高亮，一键复制代码
- 云端长久记忆库，帮助 AI 更贴合使用者背景

---

## 🛠 技术栈

| 类别 | 技术 / 库 |
| --- | --- |
| 前端框架 | 原生 JavaScript (ES6+) |
| 样式 | Tailwind CSS（本地文件） |
| 图标 | Lucide Icons |
| Markdown 渲染 | Marked |
| 数学公式 | KaTeX |
| 代码高亮 | Highlight.js (github-dark 主题) |
| Canvas 编辑器 | CodeMirror 5 |
| DOCX 解析 | Mammoth.js |
| PPTX 解析 | pptxtojson |
| XLSX 解析 | SheetJS (xlsx) |
| 云端存储 | LeanCloud |
| Token 预估 | gpt-3-encoder |
| 构建工具 | 无（纯 HTML/CSS/JS，零依赖构建） |

---

## 🚀 快速开始

### 1. 克隆项目
```bash
git clone https://github.com/JHCWColin/AIChat-UI.git
cd AIChat-UI-Main
```

### 2. 打开即用
用现代浏览器（Chrome / Edge / Firefox）打开 `index.html` 即可运行。
所有依赖均为本地文件，**无需构建步骤**。

### 3. 配置 API Key
应用内置了默认 Key 和 Base URL。如需自定义：
- 打开页面 → 点击设置 → 在「API 设置」中填入你的 Key 和 Base URL
- 修改会保存在浏览器本地存储

### 4. 配置云端同步（可选）
默认使用内置的 LeanCloud 配置。如需使用自己的 LeanCloud 应用：
- 修改 `index.html` 底部 `<script>` 中的 `LC_CONFIG` 对象

---

## 📁 文件结构

```
AIChat-UI-Main/
├── index.html            # 主应用页面（包含所有 HTML/CSS/JS）
├── README.md             # 项目说明
├── LICENSE               # MIT 开源协议
├── logo.png              # 项目 logo
├── screenshot/           # 运行截图
├── 1.JPG ~ 6.JPG         # 背景图片素材（可在设置中选择）
├── tailwindcss.js
├── lucide.js
├── marked.js
├── katex.min.js
├── katex.min.css
├── highlight.js
├── github-dark.min.css
├── mammoth.min.js
├── pptxtojson.js
├── xlsx.min.js
└── gpt-3-encoder.min.js
```

---

## 🧭 使用说明

### Canvas 编码模式
1. 在输入框输入 **`/canvas`** 并发送，激活编码模式。
2. 对话区域右侧将出现 Canvas 代码编辑器。
3. 描述你的需求，AI 将以 `[replace]` 格式返回修改指令。
4. Canvas 中新增或修改的行将以 **暗绿色背景** 高亮。
5. AI 生成完毕后，你可**自由编辑** Canvas 中的代码。

### 模型切换
输入框上方的下拉菜单选择当前模型。重试时也可在弹出菜单中临时更换模型。

### 设置
点击侧边栏「设置」进入偏好设置面板，可调整系统提示词、回复倾向、主题、字体大小、Canvas 代码大小、背景图片及 API 配置。

### 数据同步
对话内容自动存储于浏览器本地存储。点击侧边栏「云端同步」手动将本地数据推送至 LeanCloud 并拉取最新数据。

### 移动端
左侧边栏自动隐藏，点击左上角菜单图标呼出。

---

## 📄 开源许可

本项目基于 **MIT License** 发布，详见 [LICENSE](LICENSE) 文件。

---

## 👤 作者 & 版本

- **开发者**：[JHCWColin](https://github.com/JHCWColin) / [abpdf](https://github.com/abpdf)
- **版本**：V5.2.0 (build20260803)

---

## 🙏 致谢

感谢以下开源项目：

- [Tailwind CSS](https://tailwindcss.com/)
- [Lucide](https://lucide.dev/)
- [Marked](https://marked.js.org/)
- [KaTeX](https://katex.org/)
- [Highlight.js](https://highlightjs.org/)
- [CodeMirror](https://codemirror.net/)
- [Mammoth.js](https://github.com/mwilliamson/mammoth.js)
- [pptxtojson](https://github.com/gitbrent/pptxtojson)
- [SheetJS](https://sheetjs.com/)
- [LeanCloud](https://leancloud.cn/)

---

*⭐ 欢迎 star 与贡献！*
