# 模型推理参数与 Token 计算

核对日期：2026-11-07。实际能力清单和映射以 `model-capabilities.js` 为准；型号名称逐项登记，未登记的私有别名使用“模型默认”，不猜测或发送推理参数。

| 模型系列 | 推理机制 | 默认与范围 |
| --- | --- | --- |
| GPT 6.1 Sol | reasoning effort | medium；low / medium / high / xhigh / max |
| GPT 6.1 Terra、6 Luna、5.6 | reasoning effort | medium；另支持 none |
| GPT 6 Astra | reasoning effort | 默认不发送；可选 low 至 max |
| Claude 4.6 及后续型号 | adaptive thinking + effort | 按型号登记 high 或 medium；部分型号不支持 xhigh |
| Claude 4.5 等旧型号 | 独立 effort 或 thinking budget | 按型号单独登记；budget 必须小于 max_tokens |
| DeepSeek Flash / V4 Pro / V4.1 Flash | thinking 开关 + effort | high；off / low / high / max |
| Grok 4.5 / 4.6 / 4.7 | reasoning effort | high；4.6 / 4.7 另支持 xhigh |
| Gemini 3 / 4 | thinking level | 按型号登记 minimal / low / medium / high |
| Gemini 2.5 | thinking budget | 按型号区分默认预算、自动预算与是否允许关闭 |

UI 统一称“Reasoning depth”，选项使用英文，实际默认档位标注 `(default)`，不单列 Default 选项。没有公开默认档位时显示 Automatic，底层仍省略未指定参数。切换模型仅保留同厂商、同机制且新型号支持的选项，否则恢复该型号默认值。发送请求前清除遗留控制参数，再根据接口映射。Claude 原生参数只发送到 Messages；不向未知的 OpenAI 转接接口猜测 Claude 参数。

Token 计数在 Node worker 内执行，优先使用现有官方本地词表（DeepSeek V4 / V4.1）、已知 OpenAI 编码的本地实现；没有可靠本地词表的型号尝试配置后端提供的官方计数接口。计数接口失败时回退通用 o200k_base，并显示红色“通用预估”。官方接口返回总量时，详情分类占比仍按本地分类比例分配；本地图片、消息封装开销仍为估算。官方闭源模型没有公开兼容词表时，不把旧词表或 Hugging Face 分词引擎本身宣称为精准词表。

词表选择由偏好设置「Tokenizer」中的有序规则决定：模型名默认比较开头（不区分大小写，允许 `openrouter/` 这类厂商前缀），每条规则可单独切换为正则匹配；命中第一条即停止，全部未命中时使用可编辑的「默认」规则。预置规则覆盖 GPT / o 系列（o200k 或 cl100k）、DeepSeek V4 / V4.1、Anthropic Claude（内置 Anthropic 公布的分词器，纯 JS 实现，与官方包逐字符一致），Gemini 因 Google 未公开词表而使用通用 o200k_base 估算，并在可用时由官方 countTokens 接口校准。用户可以停用、删除、编辑或新增规则，并上传 HuggingFace `tokenizer.json`（Qwen、Llama、GLM、Kimi 等）作为精确词表；上传前会先解析并实际编码一段文本，格式不符直接拒绝，文件不会落盘。规则被更靠前的短前缀或正则覆盖、开头重复、正则无效时，界面会标红提示并回退通用估算。

预置规则按厂商覆盖文本模型：OpenAI（gpt-/o1/o3/o4）、Anthropic（claude-，本地词表）、Google（gemini-）、DeepSeek（v4 / v4.1 / flash）、xAI（grok-）、阿里（qwen / qwen-long）、智谱（glm- / glm-5）、月之暗面（kimi / moonshot-）、字节（doubao）、腾讯（hunyuan-）、阶跃（step-）。其中 OpenAI、DeepSeek、Anthropic、Qwen、GLM、Llama、Mistral、Yi、InternLM、Gemma 的词表已内置（从 Hugging Face 下载的官方 tokenizer.json 随应用打包，本地精确计数）；Kimi（月之暗面）仅发布 tiktoken.model、xAI Grok、字节 Doubao、腾讯 Hunyuan、阶跃 Step 没有公开 tokenizer.json，这些规则命中通用 o200k_base 估算并在界面标注「通用预估」，同时保留各自的默认上下文容量，用户可以随时把这些规则改指向自己上传的词表。仅出图、出视频或出音频的厂商（Midjourney、Suno、Kling、Stability AI、Vidu 等）不属于 Token 统计范围，未加入默认规则。

上下文窗口同样由「上下文容量」规则表解析（`512K` / `1k` / `1.5M` / `64万` / 纯数字均支持，按十进制换算），命中顺序与词表规则一致，未命中时回退「默认」规则（初始 128K，可改）。默认容量包含 claude-*（1M / 200K）、gpt-5 / 4.1 / o3 / o4（400K）、gemini-*（1M）、deepseek（256K / 1M）、qwen-long（10M）、qwen（256K）、glm-5（256K）、glm-*（200K）、kimi / moonshot（256K / 128K）、grok-4.1-fast（2M）、grok-*（256K）、doubao（256K）、hunyuan（256K）、step-3（64K）、step-*（32K）。用量条、自动压缩阈值与百分比共用同一结果。

默认列表移除了已获官方确认废弃的 `gemini-3.7-flash`；保留能力配置以兼容用户已有列表。未将 Stable、Legacy 或代理自定义别名推断为废弃。

Claude Sonnet、Opus、Fable 的型号、日期快照及厂商前缀别名统一尝试 Anthropic `count_tokens`，支持 Base URL 带 `/v1`、`/v1/messages` 等完整端点，以及代理的 `/messages/count_tokens` 路径和 Bearer 认证。相同请求的成功计数复用，失败端点短暂退避。代理保留用户原始型号，不猜测或改写 Fable 等别名；实际是否可精确计数取决于后端是否支持该型号。Anthropic 官方 tokenizer 仓库明确说明旧词表从 Claude 3 起不再准确，故不将其用于现代型号的精确本地计数；接口失败时继续显示通用预估。

## 官方资料

- OpenAI [推理指南](https://developers.openai.com/api/docs/guides/reasoning)、[最新型号](https://developers.openai.com/api/docs/guides/latest-model)、[计数接口](https://developers.openai.com/api/docs/guides/token-counting)、[废弃公告](https://developers.openai.com/api/docs/deprecations)
- Anthropic [Effort](https://platform.claude.com/docs/en/build-with-claude/effort)、[Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)、[Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)、[生命周期](https://platform.claude.com/docs/en/about-claude/model-deprecations)
- Anthropic [旧版 tokenizer 的精度限制](https://github.com/anthropics/anthropic-tokenizer-typescript#readme)：官方明确提示 Claude 3 起该算法不再准确。
- DeepSeek [Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)、[Token usage](https://api-docs.deepseek.com/quick_start/token_usage)
- xAI [Reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning)、[OpenAPI](https://docs.x.ai/openapi.json)
- Gemini [Thinking](https://ai.google.dev/gemini-api/docs/thinking)、[OpenAI 兼容接口](https://ai.google.dev/gemini-api/docs/openai)、[Token counting](https://ai.google.dev/gemini-api/docs/tokens)、[废弃公告](https://ai.google.dev/gemini-api/docs/deprecations)

验证：`npm test`；`node_modules/.bin/electron.cmd src/test/desktop-enhancements-smoke.js` 使用独立临时配置和本地模拟服务，覆盖设置窗口、参数映射、询问暂停、统计、计数降级、模型发现、后台进程终止和 ZIP 往返。
