# 模型元数据

核对日期：2026-10-14。阶段 3 第 1 项；Token 估算、上下文预算和摘要压缩在后续检查点实现。

## 数据和优先级

客户端与云端共用 `shared/model-metadata.ts`，逐字段按「手动覆盖 → 供应商模型列表 → 内置条目 → 保守回退」解析。`ProviderModel.reportedMetadata` 保存目录中的已知原生字段，`metadataOverrides` 保存手动设置；思考能力沿用 `reasoningSupport`。有效字段携带来源，设置界面显示来源和自动值，留空或选择「自动」恢复继承。「恢复自动」只清除能力覆盖，不改变提示词、名称或启用状态。

元数据包括上下文窗口、窗口范围、模型最大输出、图片输入、客户端工具调用、JSON Schema 结构化输出、思考能力及可选思维强度。能力描述不代表 EverChat 已提供图片输入、工具执行或结构化生成入口；这些入口按后续阶段实现。供应商对模式和参数组合的限制仍需要相应执行适配。

`contextScope: combined` 表示输入与输出共享窗口；`input` 表示模型目录明确报告的是最大输入容量。[上下文预算](context-budget.md) 区分两者，不把原生最大输入容量误当成总窗口。显式输出上限不能超过已知模型最大输出；共享窗口时也不能超过已知窗口。保守回退不作为确定的供应商拒绝阈值。

模型最大输出与请求输出上限分开。请求默认仍为 `null`，不会自动把元数据最大值或回退值送给供应商；供应商／SDK 的默认值继续生效。元数据数值允许 1–10,000,000 的正整数；当前原型的显式请求输出上限仍为 1–100,000。

任务接受时将有效元数据和字段来源存入任务配置 JSON，后续修改设置不改变已接受任务。解析不发起网络请求，不增加逐 Token 存储；目录只在用户点击「获取」时读取。

## 原生目录

| 协议 | 读取字段 | 范围与限制 |
| --- | --- | --- |
| Anthropic | `max_input_tokens`、`max_tokens`；`capabilities.image_input`、`structured_outputs`、`thinking`、`effort` | 仅接收正整数和明确布尔值；`server_tools` 是托管工具，不能据此认定客户端函数调用已支持。 |
| Gemini | `inputTokenLimit`、`outputTokenLimit`、`thinking`、原生 `displayName` | 过滤仅支持 Embedding 的模型；未返回图片／工具／结构化能力时继续逐字段回退。 |
| OpenAI Chat／Responses | `id` | 目录不提供统一的能力字段；忽略兼容端点中的非标准字段，使用内置条目或手动配置。 |

原生显示名只用于新增模型。重新获取更新已有模型的目录元数据，保留显示名、启用状态、提示词和手动覆盖；目录未列出的手动模型继续保留。修改 API 协议或端点、修改模型 ID 时清除旧报告，手动覆盖保留。分页最多 5 页、总计 200 个模型，新增项默认禁用。

依据：[Claude Models API](https://platform.claude.com/docs/en/api/models/list)、[Gemini Models API](https://ai.google.dev/api/models)。缺失、零、负数、非整数或超出本地边界的原生限制不进入配置；未知字段和密钥不进入元数据。

## 内置条目

只匹配已核对的精确 ID，不用系列前缀推断未来模型。兼容网关可能修改同名模型的限制，用户可手动覆盖。条目仅描述能力，不推荐模型，不保证当前账户有调用权限。

| ID | 窗口 | 最大输出 | 范围 | 官方来源 |
| --- | ---: | ---: | --- | --- |
| `o3` | 200,000 | 100,000 | 输入＋输出 | [OpenAI o3](https://developers.openai.com/api/docs/models/o3) |
| `gpt-4o`、`gpt-4o-2024-08-06` | 128,000 | 16,384 | 输入＋输出 | [OpenAI GPT-4o](https://developers.openai.com/api/docs/models/gpt-4o) |
| `gpt-4o-mini` | 128,000 | 16,384 | 输入＋输出 | [OpenAI GPT-4o Mini](https://developers.openai.com/api/docs/models/gpt-4o-mini) |
| `gpt-5`、`gpt-5-2025-08-07` | 400,000 | 128,000 | 输入＋输出 | [OpenAI GPT-5](https://developers.openai.com/api/docs/models/gpt-5) |
| `gpt-5.4`、`gpt-5.4-2026-03-05` | 1,050,000 | 128,000 | 输入＋输出 | [OpenAI GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4) |
| `gpt-6-sol` | 1,050,000 | 128,000 | 输入＋输出 | [OpenAI GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) |
| `gpt-6-luna` | 1,050,000 | 128,000 | 输入＋输出 | [OpenAI GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) |
| `gpt-6-astra` | 1,050,000 | 128,000 | 输入＋输出 | [OpenAI GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) |
| `gpt-6.1-sol` | 1,050,000 | 128,000 | 输入＋输出 | [OpenAI GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) |
| `deepseek-flash`、`deepseek-v4-pro` | 1,000,000¹ | 393,216 | 输入＋输出 | [DeepSeek 模型表](https://api-docs.deepseek.com/quick_start/pricing/)、[Chat Completions 数值范围](https://api-docs.deepseek.com/api/create-chat-completion/) |
| `gemini-2.5-flash` | 1,048,576 | 65,536 | 仅输入 | [Gemini 2.5 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash) |

¹ DeepSeek 模型表只写 `1M`，内置输入＋输出预算采用 1,000,000 的保守解释；384K 输出使用 API 文档明确给出的 393,216。用户可按实际部署修订窗口。

OpenAI 条目支持图片输入、函数调用和结构化输出，但 GPT-6 Astra／GPT-6.1 Sol 在 Chat Completions 下不支持工具调用。GPT-6 Sol／Luna 的 Chat Completions 工具能力受 `reasoning_effort: none` 条件限制；后续工具执行必须再次检查模式。GPT-5 的强度不含 `none`；GPT-6.1 Sol 不含 `none`／`minimal`。依据：[OpenAI 推理指南](https://developers.openai.com/api/docs/guides/reasoning)。

DeepSeek Flash 支持图片，V4 Pro 不支持；二者支持思考和工具调用。JSON mode 不能当作 JSON Schema 保证，因此内置结构化输出为不支持；手动覆盖可用于不同的兼容部署。强度为关闭、低、高、最高，关闭映射到已有思考开关。依据：[DeepSeek 模型表](https://api-docs.deepseek.com/quick_start/pricing/)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。

Gemini 2.5 Flash 的强度使用当前安装的 AI SDK 映射到 `thinkingBudget`，关闭映射到 0；并非模型原生的 `thinkingLevel` 枚举。

## 未知模型与备份

未识别字段使用 32,768 的共享上下文窗口、8,192 的模型最大输出，图片／工具／结构化／思考能力默认不启用，界面标为「保守回退」或「未识别」。数值是本地规划值，不是供应商规格。手动启用未知模型的思考后，提供低／中／高的回退选项，可自定义实际支持的选项；空列表隐藏强度调节入口。

当前备份格式保留原生报告与手动覆盖，恢复时校验嵌套字段、正整数范围和不重复的强度列表，不携带密钥。备份中的报告与备份端点一同恢复，即使相同供应商 ID 目前使用了其他端点也不丢弃报告；普通设置修改端点时仍清除旧报告。不增加旧缓存、旧格式或 SQL 迁移。
