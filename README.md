![Logo](logo.png)

一个基于浏览器的现代化 AI 对话前端，支持多种大语言模型、聊天历史管理、附件预览与上传、云端同步以及丰富的个性化设置。所有对话数据默认保存在本地，也可通过 LeanCloud 进行云端同步。

### 运行截图：
![main](/screenshot/main.png)

---

## ✨ 功能特性

- 🤖 **多模型支持** – 内置 GPT-5.5、DeepSeek、Claude、Gemini、Qwen、MiniMax 等数十个模型，可随时切换
- 💬 **聊天管理** – 创建、切换、删除对话；侧边栏管理所有历史记录
- 📎 **附件系统**
  - 支持粘贴剪贴板图片
  - 上传图片、`.docx`、`.pptx`、`.xlsx`、`.txt` 等文件
  - 自动提取 Office 文本内容 (Mammoth / pptxtojson / SheetJS)
  - 图片压缩，液态玻璃风格附件卡片预览
- 🌓 **深色 / 浅色主题** – 毛玻璃背景，可自定义背景图片
- 🧠 **AI 个性化**
  - 自定义系统提示词 (System Prompt)
  - 调节回复倾向 (Temperature)
- 💾 **本地 + 云端同步** – 对话数据自动保存至浏览器本地存储，支持 LeanCloud 云端同步
- 🎨 **界面定制** – 字体大小、背景图片切换、液态玻璃 UI 设计
- 📐 **响应式布局** – 适配桌面与移动端
- 🔍 **数学公式渲染** – 使用 KaTeX 渲染 $$ 和 $ 内的公式
- 🌟 **代码高亮** – 由 Highlight.js 提供语法高亮，并支持一键复制代码
- 🧲 **长久记忆库** – 从云端读取开发者维护的记忆信息，帮助 AI 更贴合使用者背景

---

## 🛠 技术栈

| 类别         | 技术 / 库                                              |
| ------------ | ------------------------------------------------------ |
| 前端框架     | 原生 JavaScript (ES6+)                                 |
| 样式         | Tailwind CSS（通过 CDN 加载 `tailwindcss.js`）         |
| 图标         | Lucide Icons                                           |
| Markdown 渲染| Marked                                                  |
| 数学公式     | KaTeX                                                  |
| 代码高亮     | Highlight.js (github-dark 主题)                        |
| DOCX 解析    | Mammoth.js                                             |
| PPTX 解析    | pptxtojson                                             |
| XLSX 解析    | SheetJS (xlsx)                                         |
| 云端存储     | LeanCloud                                              |
| 构建工具     | 无（纯 HTML/CSS/JS）                                   |

---

## 🚀 快速开始

1. **克隆或下载本项目**  
   ```bash
   git clone https://github.com/JHCWColin/AIChat-UI
   cd AIChat-UI-Main
   ```

2. **直接在浏览器中打开**  
   用现代浏览器打开 `index.html` 即可运行。所有依赖均从本地加载，无需构建步骤。

3. **必做：配置 API Key**  
   应用内置了默认 Key 和 Base URL，如果需要自定义：
   - 打开页面 → 点击设置 → 在「API 设置」中填入你的 Key 和 Base URL
   - 修改会保存在浏览器本地存储

4. **配置云端同步**  
   默认使用内置的 LeanCloud 配置。如需使用自己的 LeanCloud 应用，请修改 `LC_CONFIG` 对象（位于 HTML 底部 `<script>` 中）。

---

## 📁 文件结构

```
project-root/
│
├── index.html          # 主应用页面（包含所有 HTML/CSS/JS）
├── logo.png            # 项目 logo（用于 README）
├── README.md           # 项目说明
├── 1.JPG ~ 6.JPG       # 背景图片素材（可在设置中选择）
├── tailwindcss.js
├── lucide.js
├── marked.js
├── katex.min.js
├── katex.min.css
├── highlight.js
├── github-dark.min.css
├── mammoth.min.js
├── pptxtojson.js
└── xlsx.min.js
```

---

## 🧭 使用说明

### 聊天基础操作
- 点击左侧「开启新对话」创建新会话
- 在底部输入框键入消息，按 `Enter` 发送（`Shift + Enter` 换行）
- 可粘贴剪贴板图片，或点击 📎 按钮上传文件
- AI 回复下方的工具栏支持 **复制** 和 **重试**（可切换模型）

### 模型切换
- 输入框上方的下拉菜单选择当前模型
- 重试时也可在弹出菜单中临时更换模型

### 设置
- 点击左侧菜单「设置」进入偏好设置
- 修改系统提示词、回复倾向、主题、字体大小、背景图片
- API Key 及 Base URL 可在设置中覆盖
- 「长久记忆库」为只读展示，内容由开发者维护

### 数据同步
- 对话内容自动存储于浏览器本地存储
- 点击左侧「立即同步云端」手动将本地数据推送到 LeanCloud 并拉取最新数据

### 移动端使用
- 左侧边栏自动隐藏，点击左上角菜单图标呼出
- 遮罩层点击可关闭侧栏

---

## 🔧 API 配置

默认 API 配置内置于代码中，也可在设置面板中覆盖：

| 配置项   | 默认值                       | 说明                       |
| -------- | ---------------------------- | -------------------------- |
| API Key  | `sk-...` | 调用模型的 API 密钥        |
| Base URL | `https://api.***.com/v1`   | 兼容 OpenAI 格式的接口地址 |

配置会保存在 `localStorage`，优先级高于默认值。

---

## 📄 开源许可

本项目采用 **MIT License** 发布，详见 [LICENSE](LICENSE) 文件。

---

## 👤 作者 & 版本

- **开发者**：[JHCWColin](https://github.com/JHCWColin) / [abpdf](https://github.com/abpdf)  
- **版本**：V1.30 (build20260517)

---

## 🙏 致谢

感谢以下开源项目：
- [Tailwind CSS](https://tailwindcss.com/)
- [Lucide](https://lucide.dev/)
- [Marked](https://marked.js.org/)
- [KaTeX](https://katex.org/)
- [Highlight.js](https://highlightjs.org/)
- [Mammoth.js](https://github.com/mwilliamson/mammoth.js)
- [pptxtojson](https://github.com/gitbrent/pptxtojson)
- [SheetJS](https://sheetjs.com/)
- [LeanCloud](https://leancloud.cn/)

---

*欢迎 star 与贡献！*  
