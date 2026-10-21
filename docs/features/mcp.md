# MCP 自动化聊天

EverChat 提供同域 `/mcp` 接口，供支持 Streamable HTTP 和自定义请求头的 MCP 客户端调用已配置的模型。每次调用都保存为普通对话，可在网页中查看、搜索和继续。MCP 不提供临时模式或模型 JSON Schema 输出。

## 创建与管理密钥

1. 登录网页，打开「设置 → MCP」。
2. 点击「创建 API 密钥」，填写用途名称，例如“本机自动化”。
3. 复制新密钥并妥善保存。完整值只显示一次，关闭窗口后无法再次读取。
4. 客户端使用页面显示的 MCP 接口地址，并设置 `Authorization: Bearer <密钥>`。

列表显示名称、脱敏 Key、创建日期与最近使用日期；不显示 Tracking ID。支持重命名和删除，重命名不会改变密钥。删除需确认，随后立即拒绝该密钥的新请求。已经接受的后台生成和网页中的普通对话保留；停止生成应调用取消工具。

最近使用时间只在成功认证后更新，同一密钥最多每小时持久化一次，因此属于近似记录。首次使用前显示“未使用”。这不是计费日志，也不会因状态查询不断产生数据库写入。

每个集成应使用独立密钥。它可以发现模型、创建普通对话、继续和读取自己创建的任务、取消自己的生成；不能读取其他密钥或网页创建的历史，不能获取供应商密钥或管理网页设置。新密钥不继承被删除密钥的任务权限。

服务端只保存密钥哈希与列表元数据，前端不把完整密钥写入 localStorage、IndexedDB 或查询缓存。供应商 API 密钥不能代替 MCP 密钥。不要将密钥放在 URL、聊天正文或公开仓库中。

## 客户端连接

连接参数为：

```json
{
  "url": "https://chat.example.com/mcp",
  "headers": {
    "Authorization": "Bearer <刚创建的 EverChat MCP 密钥>"
  }
}
```

这只是连接参数示例，具体外层配置按客户端文档填写。客户端必须支持自定义请求头；仅支持交互式 OAuth 的宿主暂不支持。无需单独 MCP 域名、Cloudflare Service Token 或 Access AUD。

## 四个工具

| 工具                   | 用途                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| `everchat_models_list` | 列出可调用模型、能力和预设；不返回供应商端点、密钥或系统提示词内容 |
| `everchat_chat`        | 新建正常对话并提问，或从明确的 `continuation` 位置继续             |
| `everchat_run_get`     | 等待同一任务、查询状态并分页读取正文和可选思考内容                 |
| `everchat_run_cancel`  | 停止自己的任务，保留已生成内容；重复取消不会新增任务               |

先调用 `everchat_models_list`，使用返回的精确 `modelRef`，避免同名模型产生歧义。首次提问示例为工具 arguments，不是完整 JSON-RPC 请求：

```json
{
  "requestId": "b60fbbac-edcf-43c6-9bf1-d1f1881ab2d5",
  "modelRef": "<模型列表返回的 ref>",
  "prompt": "请给出三项实施建议。",
  "waitMs": 10000
}
```

如果返回 `accepted` 或 `running`，保存 `runRef`，调用查询工具：

```json
{
  "runRef": "<上一步返回的 runRef>",
  "waitMs": 10000,
  "includeReasoning": true
}
```

`waitMs` 默认为 10 秒，范围为 0–20 秒。等待到期、MCP 连接断开或宿主取消等待不会终止后台生成。调用方不要无间隔轮询；需要立即返回时设置 `waitMs: 0`。

终态包含 `completed`、`interrupted`、`failed` 和 `cancelled`。供应商中断且部分回答已正式保留时，可以通过返回的 `continuation` 继续：

```json
{
  "requestId": "58141c29-555e-410c-9d01-a33ca5dceae2",
  "continuation": "<上一次回答返回的位置>",
  "prompt": "展开第二项。"
}
```

续聊未指定模型时继承上次调用；显式指定 `modelRef` 可切换模型。预设／系统提示词、推理强度、Temperature、Top P、上下文预算、输出预算与联网开关均有统一可选参数，完整字段以客户端发现的工具 schema 为准。`presetId` 与 `systemPrompt` 互斥。`webSearch: true` 同时开启现有网页搜索和读取工具，仍需部署者事先配置联网服务。

同一对话同时只允许一个生成，忙碌时明确报错。需要并行比较时，为不同请求创建独立对话。

## 重试、分页与错误

- `requestId` 是业务幂等键，独立于 MCP 请求 ID。传输失败或结果未知时，必须使用**原 requestId 和原参数**重试；仅等待时间可以改变。新 requestId 表示有意发起新模型调用，可能再次计费。
- 同密钥、同 ID、同参数返回原任务；参数不同返回 `IDEMPOTENCY_CONFLICT`。模型配置在接受时冻结，之后改设置不会改变原任务。
- 正文通过 `output.text` 返回。如果 `output.hasMore` 为 true，将 `output.nextCursor` 作为下一次查询的 `outputCursor`，逐页拼接至 false。完成状态不代表当前页已含全文。
- 思考默认不返回。使用 `includeReasoning: true` 读取，并通过独立的 `reasoningCursor` 分页。每页最多 8,192 个 UTF-16 单元，不拆开 Unicode 代理对；不截断总内容。
- 用量只返回供应商确实提供或现有记录可确认的数据；缺失数据不填零。网页费用统计仍由现有请求账本负责。
- 错误提供稳定 code、stage、retryable 和可用 HTTP 状态；不返回可能泄漏凭据的原始供应商响应。`OUTCOME_UNKNOWN` 表示结果未确认，不代表供应商未收到请求，不能擅自换 ID 重试。

首版不提供附件上传、批量历史输入、历史管理或其他 MCP Server 递归调用。

## 部署与存储

网站的 `/api`、`/auth` 继续由现有 Cloudflare Access 保护。`/mcp` 必须允许到达 Worker，随后由 EverChat API Key 鉴权；如果 Access 已经只覆盖私有路径，无需额外设置。如果仍有整站 Access 规则，需单独为精确 `/mcp` 配置 Bypass，不能放开密钥管理接口 `/api/settings/mcp/keys`。

Wrangler 已将 `/mcp` 交给 Worker 优先处理。协议响应禁止缓存，SW 排除该路径；浏览器调用要求同源，原生客户端可以不发送 Origin。未知或已删除的密钥返回 401，跨来源浏览器请求返回 403。

可选服务端变量：

| 变量                 | 作用                                                                                |
| -------------------- | ----------------------------------------------------------------------------------- |
| `MCP_DEFAULT_MODEL`  | 模型目录中返回的精确 ref；配置后首次提问可省略 modelRef，不跟随网页输入框的临时选择 |
| `MCP_ALLOWED_MODELS` | 允许调用的模型 ref 的 JSON 数组；未设置时允许已启用且有凭据的模型                   |

本次将 Conversation／Library 存储版本从 2 升到 3；Library 增加密钥表与轻量幂等请求索引，答案仍只保存在普通消息和现有内容分块中。UsageStore／ShareStore 的版本不变。既有部署必须先按[离线迁移流程](../operations/offline-storage-migration.md#mcp-存储版本-3)完成备份、转换、写回和校验，再部署新业务代码；运行时不会自动升级旧库。

设计、范围和待验收边界见 [MCP 计划](../plans/everchat-mcp-server-plan.md)。
