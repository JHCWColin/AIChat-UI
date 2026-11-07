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

默认列表移除了已获官方确认废弃的 `gemini-3.7-flash`；保留能力配置以兼容用户已有列表。未将 Stable、Legacy 或代理自定义别名推断为废弃。

Claude Sonnet、Opus、Fable 的型号、日期快照及厂商前缀别名统一尝试 Anthropic `count_tokens`，支持 Base URL 带 `/v1`、`/v1/messages` 等完整端点，以及代理的 `/messages/count_tokens` 路径和 Bearer 认证。相同请求的成功计数复用，失败端点短暂退避。代理保留用户原始型号，不猜测或改写 Fable 等别名；实际是否可精确计数取决于后端是否支持该型号。Anthropic 官方 tokenizer 仓库明确说明旧词表从 Claude 3 起不再准确，故不将其用于现代型号的精确本地计数；接口失败时继续显示通用预估。

## 官方资料

- OpenAI [推理指南](https://developers.openai.com/api/docs/guides/reasoning)、[最新型号](https://developers.openai.com/api/docs/guides/latest-model)、[计数接口](https://developers.openai.com/api/docs/guides/token-counting)、[废弃公告](https://developers.openai.com/api/docs/deprecations)
- Anthropic [Effort](https://platform.claude.com/docs/en/build-with-claude/effort)、[Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)、[Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)、[生命周期](https://platform.claude.com/docs/en/about-claude/model-deprecations)
- Anthropic [旧版 tokenizer 的精度限制](https://github.com/anthropics/anthropic-tokenizer-typescript#readme)：官方明确提示 Claude 3 起该算法不再准确。
- DeepSeek [Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)、[Token usage](https://api-docs.deepseek.com/quick_start/token_usage)
- xAI [Reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning)、[OpenAPI](https://docs.x.ai/openapi.json)
- Gemini [Thinking](https://ai.google.dev/gemini-api/docs/thinking)、[OpenAI 兼容接口](https://ai.google.dev/gemini-api/docs/openai)、[Token counting](https://ai.google.dev/gemini-api/docs/tokens)、[废弃公告](https://ai.google.dev/gemini-api/docs/deprecations)

验证：`npm test`；`node_modules/.bin/electron.cmd test/desktop-enhancements-smoke.js` 使用独立临时配置和本地模拟服务，覆盖设置窗口、参数映射、询问暂停、统计、计数降级、模型发现、后台进程终止和 ZIP 往返。
