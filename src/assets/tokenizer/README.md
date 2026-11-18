# Offline DeepSeek tokenizer assets

The runtime reads these local gzip files lazily through Node.js in Electron's
preload process. No HTTP request, model weights, browser `fetch`, or Python
environment is required. `build-tokenizer.cjs` verifies the uncompressed SHA-256
against `manifest.json` before building the runtime.

## Sources (verified 2026-11-01)

- `deepseek-v4.json.gz`: original `tokenizer.json` from DeepSeek's official
  [offline tokenizer archive](https://cdn.deepseek.com/api-docs/deepseek_v4_tokenizer.zip),
  linked by the [Token Usage documentation](https://api-docs.deepseek.com/quick_start/token_usage).
- `deepseek-v41.json.gz`: DeepSeek's
  [recipe V4.1 tokenizer](https://github.com/deepseek-ai/deepseek-recipe/blob/main/static/tokenizers/v41/tokenizer.json),
  Git blob `3abdf13e3488acc65e11e6a57f073f6673175c3a`. The recipe modifies one
  added image token. This copy restores id `129264` to the upstream
  `<｜deepseek_image｜>`, `special: false`, following the official
  [V4.1 provenance notes](https://github.com/deepseek-ai/deepseek-recipe/blob/main/static/tokenizers/v41/README.md).
  Upstream comparison revision is `6821d6ad3681a4b137b066b76094fa82ebd0a380`
  of `deepseek-ai/DeepSeek-V4-Flash-Vision-Exp`.

The two families are kept separate; they are not assumed interchangeable.
Whitespace is minified before gzip compression without changing JSON values.
Both vocabularies are MIT licensed by DeepSeek; retain `LICENSE.DeepSeek`.
The bundled tokenizer implementation is `@huggingface/tokenizers` (Apache-2.0).

## Model selection

- Explicit `deepseek-v4-pro*` and `deepseek-v4` use the V4 asset.
- Explicit `deepseek-v4.1-*` and `deepseek-v41-*` use the V4.1 asset.
- `deepseek-flash` uses V4.1 as documented on DeepSeek's
  [model details page](https://api-docs.deepseek.com/quick_start/pricing/) on
  2026-11-01. Its displayed tokenizer label explicitly includes the alias.
- Unversioned `deepseek-chat`, `deepseek-reasoner`, legacy `deepseek-v4-flash`,
  and unrecognized families use the generic reference estimate. A relay can
  map aliases differently, so AIUI does not claim an exact tokenizer match.

Only text tokenization uses these exact vocabularies. Message framing, image
patches, server-side templates, and hidden reasoning-token accounting remain
estimates and are labeled separately in the context breakdown.

## Additional bundled open-model vocabularies (added 2026-11-14)

These `tokenizer.json` files are downloaded verbatim from Hugging Face and are
loaded the same lazy, offline way. Each family's license is noted below.

- `qwen.json.gz` — `Qwen/Qwen3-0.6B` `tokenizer.json` (Apache-2.0). Used for
  the `qwen` prefix (Qwen3 / Qwen2.5 share this vocabulary).
- `glm.json.gz` — `zai-org/GLM-4.5` `tokenizer.json` (MIT). Used for the `glm-`
  prefix (GLM-4.5 and later; GLM-4 does not publish a tokenizer.json).
- `llama.json.gz` — `NousResearch/Meta-Llama-3.1-8B` `tokenizer.json` (Llama 3.1
  Community License). Used for the `llama-` prefix.
- `mistral.json.gz` — `mistralai/Mistral-7B-v0.3` `tokenizer.json` (Apache-2.0).
  Used for the `mistral` prefix.
- `yi.json.gz` — `01-ai/Yi-1.5-9B` `tokenizer.json` (Apache-2.0). Used for the
  `yi-` prefix.
- `internlm.json.gz` — `internlm/internlm2_5-7b` `tokenizer.json` (Apache-2.0).
  Used for the `internlm` prefix.
- `gemma.json.gz` — `unsloth/gemma-3-1b-it` `tokenizer.json` (Gemma Terms of Use).
  Used for the `gemma-` prefix.

Not bundled because no `tokenizer.json` is published: Kimi (Moonshot) ships a
`tiktoken.model`, xAI Grok, ByteDance Doubao, Tencent Hunyuan, StepFun Step, and
Google Gemini. Those families keep the general-purpose estimate and can still be
pointed at an uploaded vocabulary.
