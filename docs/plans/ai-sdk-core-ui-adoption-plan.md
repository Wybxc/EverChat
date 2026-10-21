# AI SDK Core 深度集成与 UI 选择性采用

日期：2026-10-21。状态：Core 与工具容错已实现，本地验证及发布验收中；尚未部署。中间提交已推送独立分支 `codex/ai-sdk-core-ui`，尚未更新 main 或触发生产部署。

## 目标与范围调整

让 AI SDK Core 承担模型调用、通用工具参数解析、类型化错误与调用生命周期。EverChat 继续拥有分支、上下文、后台生成、outbox、同步、持久化、权限和费用账本。

2026-10-21，用户根据试接入结果确认：**Core 深度集成，UI 选择性采用，保留 EverChat 自有同步状态。** 本文替代此前让 `Chat/useChat` 全面接管前端的安排。

试接入证明 SDK 可以恢复消息，但需要额外维护活动块 ID、语义重放、批次确认、预览与持久内容去重，以及分支到线性 messages 的投影。收益不足以抵消这些适配层，因此撤销相应实现与迁移计划。实验代码从工作树删除，Git 历史与测量说明保留其结论，不能把实验通过当作生产已采用。

不为使用更多 SDK API 增加产品功能。不增加 MCP 外部工具、知识库、临时对话模式、用户 JSON Schema 输出、语音或图像生成。

## 最终职责

| 职责                           | 实现与边界                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 原生模型协议                   | 现有匹配协议的 Provider V4；保留有界 HTTP 读取及结束证明                                                      |
| 正文、思考、摘要及工具模型轮次 | Core 单轮流；DO 决定何时推进下一轮                                                                            |
| 标题及能力探测                 | Core `generateText`；独立预算、请求账本及版本竞争                                                             |
| 工具 JSON 与参数 Schema        | Core `tool` 与显式运行时校验；EverChat 负责权限、目标策略及执行准入                                           |
| 工具实际执行                   | 现有 DO 任务账本与 Workflow；先认领，再请求，不让 Core 自动执行                                               |
| 私有续接                       | 最小原生 collector：调用身份、Anthropic 签名、Responses 加密资料、Gemini thought signature                    |
| UI 内容类型                    | 直接复用 SDK `TextUIPart`／`ReasoningUIPart` 的公开字段类型，仅 type import                                   |
| UI 消息验证                    | 兼容 SDK 结构的边界才使用 SDK validator；现有附件、分支和备份继续由业务 Schema 验证，不额外构造一份 UIMessage |
| 实时展示与恢复                 | 现有 `StreamSync`、`useConversation`、outbox 和 WebSocket；单一状态所有者                                     |
| 渲染                           | 现有 shadcn、Streamdown、MessageScroller；视觉组件改造归其他计划                                              |

`UIMessage` 不是新的数据库格式。当前没有需要接收完整 SDK UIMessage 的生产接口，因此不保留未使用的整消息投影与 validator。正文／思考类型复用不加载 SDK 浏览器运行时，不引入 `@ai-sdk/react`。

## Core 的实施约束

### 请求与生命周期

- 精确锁定 `ai@7.0.145`，复用现有 Provider V4。流入口采用公开的 `experimental_streamTextLowMemory`；不使用内部文件或 `_internal` 开关。升级时重新验证协议与资源。
- 每个 DO 模型轮次只允许一次实际请求；`maxRetries: 0`，不做流内自动重发，不开启 Core 多步循环。错误不能隐式增加模型费用。
- 不向工具提供直接执行联网请求的 `execute`。Core 解析参数，DO 在确认原生流完整、身份明确、权限通过并持久认领后执行。
- `wrapLanguageModel` 在同一条流上收集必要原生资料，不另 tee 一份完整响应。普通生成不读取最终聚合全文；声明工具时，锁定版本仍有本轮内容聚合开销，明确保留此限制。
- 标题与能力探测使用 `generateText`；标题响应 256 KiB、探测 64 KiB，允许取消。能力不匹配不抹去有效响应的计费用量。历史压缩继续使用普通单轮流与现有摘要覆盖规则。
- 使用 Core 的类型化错误及有界公开诊断，关闭原始 warning 日志和生产遥测；不记录完整输入、密钥、原始输出或私有续接。

### 资料完整性

- Anthropic 分片签名拼接、redacted 内容、Responses 加密资料、全文优先／摘要回退、Gemini thought signature 均保持无损。
- Core 的 `responseMessages` 不作为完整私有续接的唯一来源；这些字段在安装版本中不能完全覆盖。
- 原生 ID 缺失／重复、签名缺失、异常 EOF、SSE／JSON 损坏、结束后内容仍明确停止；不补齐截断参数，不执行不完整调用。
- 有正文的中断回答继续作为正式版本保存，并进入后续上下文。网络订阅错误不等于后台生成失败。

### 工具容错

- 无效 JSON／参数、未知工具形成身份明确且不可执行的失败候选；同轮合法调用继续执行。失败结果匹配原调用，供模型纠正。
- 公开网页与引用目标允许 HTTP／HTTPS，Fetch URL 最多 8192 字符；服务端点仍限定 HTTPS。保留凭据、内网、本地、非网页协议与自定义端口边界，不静默改写 URL。
- DeepSeek 查询按 128 个 Unicode 字符校验。模型 JSON Schema 与含 Unicode 自定义检查的运行时 Schema 分开；`strict: true` 不能代替运行时校验。
- 搜索来源逐条过滤，标题合理回退；根结构错误、全部不可用、凭据泄漏与真实空结果区分处理。
- 单工具 15 秒超时为局部失败；用户取消、全局期限或存储失败停止任务。认证／余额／额度错误禁止后续实际服务请求，模型可根据已有结果收尾。
- 连续相同失败且没有进展时关闭工具，不恢复固定轮数上限。不采用需要额外付费请求的自动 `repairToolCall`。
- Core `timeout.toolMs` 只控制其 `execute`，不能替代现有 Workflow 执行期限；局部失败在实际业务执行边界落实。

## 保留、删除与不采用

已删除试验用 `AbstractChat` 批次引擎、活动 ID 重放、SDK Chunk wire、UIMessage 全量投影与校验、新有序内容表及其专用测试，移除 `@ai-sdk/react`。这些均未进入生产 schema，不需要数据库迁移。

保留生产缓冲的异步背压和检查点准备／提交边界：等待保存后再读上游，合并慢写入期间的 tick；事务前准备，事务内重新核对 run、终态和游标，再同步保存；回滚后丢弃已推进解析器。这些改进不依赖 SDK UI，也能防止写入堆积与过期检查点覆盖。

以下定制模块继续使用，并明确原因：

| 模块                                   | 保留原因                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| `shared/streaming/provider-stream.ts`  | 解析 EverChat 应用事件，维护可恢复的双通道内容与容量边界；不是手写供应商 SSE 解析器 |
| `shared/streaming/sync.ts`             | preview／commit 去重、确认、缺口与权威快照恢复，SDK UI 不提供这些语义               |
| `src/features/chat/useConversation.ts` | 单连接、分页、Access 恢复、多设备和后台任务订阅                                     |
| `shared/web-tools/reasoning-flow.ts`   | 当前存储按思考位置展示工具过程；不为 SDK 接入改写存储                               |
| `worker/providers/tool-turn.ts`        | 缩减后的私有身份与协议续接，通用参数解析已交给 Core                                 |

其他公开 API 按实际收益处理：

- `convertToModelMessages`：不使用。服务端已选择分支、摘要并校验附件，直接构造 `ModelMessage` 更简单；不先构造 UIMessage 再转回。
- `pruneMessages`：不使用。现有上下文预算与摘要包含分支覆盖规则，不能由通用裁剪替代，也不应裁掉续接签名或工具结果。
- provider registry：不增加。已有运行时供应商配置与统一 `providerModel` 工厂，另建 registry 会产生第二份配置。
- `smoothStream`：不使用。客户端已有更新节奏，服务端不增加计时器、延迟或活跃时长。
- `useCompletion`／`useObject`：当前无对应独立交互场景。
- UI validators：未来若出现原生 SDK UIMessage 输入，再在该单一边界采用；不为现在的业务消息增加转换层。已验证锁定 SDK 的 Standard Schema 适配存在 Valibot 失败结果误判，现有工具使用显式 `safeParse(...).success` 回调。

## 实施与验收

| 阶段           | 状态与交付                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 0 架构与版本   | 已完成四协议及资源对照，依据试接入与用户确认修订 UI 采用范围                                                                  |
| 1 工具容错     | 已实现局部参数／执行失败、来源容错、目标策略和无进展收尾                                                                      |
| 2 Core 调用    | 已接入普通生成、摘要、工具轮次、标题与探测；删除对应通用解析                                                                  |
| 3 精简 UI 采用 | 删除全量接管试验，复用兼容消息类型；不改 SQL／wire，不迁移数据                                                                |
| 4 验证与发布   | 本地回归、平台功能与工具长时场景分别有完成记录；分钟级正文／思考、离线生成与 30 次终态重连已完成；免费层 CPU 评估和发布待完成 |

目标沿用“实现 AI SDK Core 与 UI 深度集成计划”，完成范围按本次用户确认的边界执行。中间版本不推送触发生产自动部署；最终版本验证通过后提交发布。

验收包含：

1. 四协议正文、思考、工具多轮及用量；Responses 全文／摘要、Anthropic 签名和 Gemini thought signature。
2. 错误粒度、HTTP 来源、无效参数与合法调用同轮执行、超时、认证／额度失败、异常 EOF 与错误正文脱敏。
3. 每次请求与费用账本对应，不隐式重试；断线、DO 重启、多客户端、MCP 发起与页面关闭不重复执行。
4. 分支、编辑、重新生成、摘要、outbox、备份、分享、取消及保留中断回答；Access、MCP Key 与匿名分享权限。
5. 原有滚动、焦点、移动输入、WebKit Markdown 与 PWA 行为不回归；分享入口不引入私有聊天运行时。
6. `pnpm test`、运维原生测试、构建、相关 E2E／PWA、变更文件格式检查和 diff 检查。
7. 普通流和工具流的同负载请求数、检查点、SQL 行数及数据库分配；不增加逐 token SQL／IndexedDB，不持久化原始流或同步事件。保持 100 ms 预览、1500 ms 检查点。
8. Cloudflare Workers Free 的包体、启动、CPU、内存及活跃时长另行验证。本地墙钟和 SQL 计数不充当平台资源证据；缺少证据的项保持待验收。

补测修复心跳状态与 live commit 的游标竞态，504 项单元、11 项流式 E2E、56 项 PWA、类型检查与构建通过。2026-10-22 的新隔离窗口完成默认 16,000 字输入下的三项分钟级生成：84,000 字正文、84,000 字正文加 84,000 字思考并反复重连，以及客户端离线后继续生成；均与持久状态一致。另完成 30 次终态重连，未重发模型请求。

本次 tail 采集 342 条事件，列表与快照 Worker 样本分别最大 3／10 ms；同步连接仍有 17／18 ms 两个高样本。已取得 CPU profile，但混有 Library、搜索、GC 和 idle 栈，不能归因 stateless 尖峰。混合资源查询达到预算，缩小后的 Worker 与 DO 查询均为空，不解释为零消耗。只读历史日志确认尖峰属于 stateless 同步请求，但无可用 trace spans，尚不能定位函数级 CPU 耗时。**免费层 CPU 评估与正式发布仍待完成。** 本次只更新独立分支，不迁移数据库。结果与清理状态见[本轮补测记录](../measurements/ai-sdk-core-stream-resume-2026-10-22.json)。

临时 Worker、两个 namespace、域名绑定、Access 应用和策略已核对删除，本机凭据文件已移除。服务令牌删除请求提交后，最终核对曾受自动审批超时和 API 403 阻碍；下一轮在新的控制台页面确认服务令牌列表为空，清理已完成。确认时间不等于实际删除时间。本轮清理超过约定的 20 分钟，明确记为未按时完成。此前一轮的迟延与失败仍保留在[前次验证记录](../measurements/ai-sdk-core-final-validation-2026-10-21.json)。

## 数据与上线

本次不改变生产 SQL、公开消息、传输或浏览器缓存格式；不需要历史转换，不清空草稿／outbox，不新增在线兼容或迁移逻辑。现有本地运维转换仅同步适配异步准备接口。

最终发布前核对无中间试验路径，生成构建并复核隔离资源结果；发布后核对 Access、长对话、匿名分享、MCP 保存正常对话及通知定位。仍遵循[离线运维原则](../operations/offline-storage-migration.md)：将来确需格式迁移时由本地维护执行，不在读取、连接或启动中转换。

## 证据与参考

- [实施与资源记录](../measurements/ai-sdk-core-adoption-2026-10-21.md)
- [原始故障与 Robustness 排查](../measurements/provider-tool-robustness-2026-10-21.md)
- [此前 Core 对照](../measurements/ai-sdk-integration-2026-10-20.md)
- 官方 [Core 文本生成](https://ai-sdk.dev/docs/ai-sdk-core/generating-text)、[工具](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)、[中间件](https://ai-sdk.dev/docs/ai-sdk-core/middleware)、[错误](https://ai-sdk.dev/docs/ai-sdk-core/error-handling)、[UI 消息持久化](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence)。API 行为以锁定版本公开源码与真实夹具为准。
