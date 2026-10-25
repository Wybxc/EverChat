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

## 工具与帮助

| 工具                           | 用途                                                                  |
| ------------------------------ | --------------------------------------------------------------------- |
| `everchat_help`                | 获取全部工具的用法、参数 schema、注意事项和调用示例，也可按工具名查询 |
| `everchat_models_list`         | 列出可调用模型、能力和预设；不返回供应商端点、密钥或系统提示词内容    |
| `everchat_chat`                | 新建正常对话并提问，或从明确的 `continuation` 位置继续                |
| `everchat_run_get`             | 等待同一任务、查询状态并分页读取正文和可选思考内容                    |
| `everchat_run_cancel`          | 停止自己的任务，保留已生成内容；重复取消不会新增任务                  |
| `everchat_run_context_get`     | 分页读取自己任务的输入回执、来源、排除清单及可读取的逻辑文本          |
| `everchat_run_usage_get`       | 按模型步骤分页读取 Token 依据、价格快照元数据与费用估计               |
| `everchat_conversations_list`  | 分页发现当前 Key 获授权的正常对话                                     |
| `everchat_conversation_read`   | 发现分支 head，逐页读取指定分支的结构化记录                           |
| `everchat_conversation_export` | 逐页导出指定分支或轮次范围的 Markdown                                 |

初次接入可调用 `everchat_help({})` 查看完整说明，或调用 `everchat_help({ "tool": "everchat_chat" })` 只查看某个工具。帮助只返回静态用法，不读取供应商配置、不创建对话、不调用模型；与其他工具一样需要有效的 MCP 密钥。附件功能仍在规划中，不在当前可调用工具内。

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
- 运行中也可读取已持久化的内容。追上尾部时保存 `resumeCursor`，稍后从此处继续；`contentFinal` 表示是否还会追加。供应商替换先前文本时返回 `OUTPUT_CHANGED`，应丢弃该通道已拼接的内容并不带游标重读。查询不会强制保存实时尾部。
- 思考默认不返回。使用 `includeReasoning: true` 读取，并通过独立的 `reasoningCursor` 分页。每页最多 8,192 个 UTF-16 单元，不拆开 Unicode 代理对；不截断总内容。
- `completion` 与分页独立：运行中为 `null`，终态的 `truncated: true` 表示供应商因长度结束。应先读完现有页面，再由调用方用新 `requestId` 与明确 `continuation` 请求继续生成。断流、取消和未知结束原因不会冒充长度截断。
- `progress` 返回可观测阶段、时间与持久化长度。可区分尚未认领、准备输入、等待供应商、生成、等待工具及最终保存；思考已输出而正文为空也可辨认。`stale` 只提示一分钟未观察到业务进展，不等于失败，不会自动取消或另起计费调用。旧记录没有回填的进展数据时为 `null`。查询不产生 SQL 心跳，`pollAfterMs` 提供建议等待时间。
- 用量字段缺失时显式返回 `null`，真实零保留。`dimensions` 给出来源、已知小计和覆盖步骤数；有任何模型步骤缺少某字段时，小计不冒充完整总量。`finalized` 表示任务结束，独立于 `completeness`。原始数字冲突时保留并标记 `inconsistent_usage`。
- 错误提供稳定 code、stage、retryable 和可用 HTTP 状态；不返回可能泄漏凭据的原始供应商响应。`OUTCOME_UNKNOWN` 表示结果未确认，不代表供应商未收到请求，不能擅自换 ID 重试。

首版不提供附件上传、批量历史输入、历史管理或其他 MCP Server 递归调用。

## 输入回执与用量明细（实现分支，尚未发布）

`context` 摘要给出所选／省略／摘要覆盖的数量、实际估算方法与回执状态。`pending` 尚未完成最终组装；`assembled` 已在发送边界组装并保存依据；`submission_attempted` 已尝试发出请求。这些均不证明供应商完整接收或模型理解。历史请求没有回执时为 `unavailable`，不根据当前配置重建。

`providerResponse` 单独返回供应商实际报告的响应 ID、模型 ID 与时间（可得时）；不作为资料完整送达的证明。回执的生成参数标记 `parameterEvidence: "application_requested"`，表示应用请求的参数；供应商仍可能忽略不支持的设置，不能把配置值当成供应商已接受的事实。

`everchat_run_context_get` 默认读取首个步骤的 manifest，按 `nextCursor` 遍历；后续工具步骤以 `previousStepId` 引用前一步，只记录新的工具资料。用 `view: "exclusions"` 查看省略和摘要覆盖的消息 ID；用 `view: "text"`、`step` 和 manifest 的 `item` 读取逻辑文本。过大元数据在清单中标为 `details: "metadata_view"`，用 `view: "metadata"` 分页拼接完整 JSON；`textUnit` 标记游标位置的单位。普通消息、摘要包装和应用生成文本按当时依据还原，删除的来源返回 `content_unavailable`。系统提示词默认 `redacted`；网页所有者可在创建／编辑 Key 时授权读取有效提示词，只有授权后新请求保存全文，关闭权限立即拒绝继续读取，历史请求不回填。文件当前仅返回版本、指纹、实际选区和校验元数据，全文有界读取仍待附件阶段完成。工具内容为 `scope: "public_projection"`，不含供应商私有思考签名或加密续接。请求指纹不附带 HTTP 正文、鉴权头或 base64。

`everchat_run_usage_get` 复用账本，按模型步骤分页；`scope: "answer_model_steps"` 不含自动标题、摘要和网页服务费用。`pending_accounting` 表示账本尚未追上任务，查询不会补算或改变价格。费用以十进制币种字符串返回，基于当时价格快照，属于估算；不把不同币种相加。用 `view: "costs"` 按币种精确汇总所有模型步骤，联网搜索／读取费用单列且不计入回答模型费用；自动标题与摘要因属于其他任务而明确列为排除项。未完全定价时 `amount` 为 null、`knownSubtotal` 保留已知金额，账本变化后费用分页需重新读取。

## 讨论记录与导出（实现分支，尚未发布）

Key 创建的对话会登记显式读取授权，包含以后在该对话中通过网页追加的消息。其他 Key 及网页独立创建的对话默认不可见；知道 ID、URL 或 ref 不会取得授权。撤销 Key 后拒绝后续读取，已经下载的内容无法远程撤回。存量授权只在离线迁移中从无歧义的 MCP 创建记录建立。

先调用 `everchat_conversations_list` 取得 `conversationRef`；调用 `everchat_conversation_read` 并指定 `view: "branches"` 发现分支，再用明确的 `headId` 读取。结果按照提问／回答轮次排列，摘要作为有覆盖边界的附加记录，兄弟分支不混入。长正文、可选思考、附件 JSON 元数据、摘要覆盖列表及可选公开工具资料均可跨页；按 messageId 和通道合并片段，游标保持不透明。

读取固定对话 revision 和 epoch，任意并发修改均保守返回 `SNAPSHOT_CHANGED`，需丢弃旧分页并重新开始。默认拒绝仍在生成的分支；显式 `includeActive: true` 时返回持久化片段并标记 `partial`。不会强刷生成缓冲或为读取调用模型。

`everchat_conversation_export` 使用同样的 head 与读取参数，支持 `fromRound`／`toRound`。逐页拼接 `text` 即为 Markdown，保留模型、时间、消息与分支引用、附件版本和摘要边界；不附带原文件、base64、预签名 URL 或供应商私有续接资料。数据变化时也须重新导出，不能继续拼接旧快照。

`progress.firstContentAt` 和 `lastContentAt` 是持久检查点观察到内容的时间，包含缓冲等待；实际网络首输出时间由既有生成计时单独记录。

## 部署与存储

网站的 `/api`、`/auth` 继续由现有 Cloudflare Access 保护。`/mcp` 必须允许到达 Worker，随后由 EverChat API Key 鉴权；如果 Access 已经只覆盖私有路径，无需额外设置。如果仍有整站 Access 规则，需单独为精确 `/mcp` 配置 Bypass，不能放开密钥管理接口 `/api/settings/mcp/keys`。

Wrangler 已将 `/mcp` 交给 Worker 优先处理。协议响应禁止缓存，SW 排除该路径；浏览器调用要求同源，原生客户端可以不发送 Origin。未知或已删除的密钥返回 401，跨来源浏览器请求返回 403。

可选服务端变量：

| 变量                 | 作用                                                                                |
| -------------------- | ----------------------------------------------------------------------------------- |
| `MCP_DEFAULT_MODEL`  | 模型目录中返回的精确 ref；配置后首次提问可省略 modelRef，不跟随网页输入框的临时选择 |
| `MCP_ALLOWED_MODELS` | 允许调用的模型 ref 的 JSON 数组；未设置时允许已启用且有凭据的模型                   |

当前实现分支要求 Conversation／Library 存储版本 4，新增紧凑的生成进展记录；正式站点仍以实际部署版本为准。答案继续只保存在普通消息和既有内容分块中。UsageStore／ShareStore 的版本不变。既有部署必须先按[离线迁移流程](../operations/offline-storage-migration.md)完成备份、转换、写回和校验，再部署新业务代码；运行时不会自动升级旧库。旧记录不伪造进展时间。

设计、范围和待验收边界见 [MCP 计划](../plans/everchat-mcp-server-plan.md)。

后续的实际输入回执、运行进展、完整分支读取／导出、附件版本及独立提案／审查见[上下文可见性与讨论记录改进计划](../plans/mcp-discussion-observability-plan.md)，这些扩展尚未上线。
