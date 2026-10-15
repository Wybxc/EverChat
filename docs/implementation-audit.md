# 路线图实施与验收核对

核对日期：2026-10-15；功能核对基准：`12d9cb0`，工具测量及终态清理补充基于 `e9a174c` 后的检查点。范围来自[实施路线图](serverless-feature-roadmap.md)的阶段 0–5、各阶段验收与共享核心行为。这里分别记录功能证据和资源证据；本地模拟通过不能证明真实供应商质量或当前版本的免费账单。

## 功能条目

表中“通过”指当前实现和对应本地回归已核对。阶段 0 的真实平台测量另列，不能用这一列代替。

| 条目 | 当前实现与证据 | 结果 |
|---|---|---|
| 0.1 原链路基线及计量口径 | [测量脚本](../scripts/stream-baseline.ts)、[改造前报告](measurements/stream-baseline.json)、[指标定义](stream-measurements.md)；区分实际经过时间、SQL 游标计数与平台 CPU | 已记录 |
| 0.2 任务、日志、快照和偏移 | [类型](../shared/types.ts)、[流日志](../worker/stream-journal.ts)、[SQLite 定义](../worker/conversation-schema.ts)；[日志单测](../tests/stream-journal.test.ts)检查提交／整理事务与失败回滚 | 通过 |
| 0.3 普通聊天 DO＋Alarm | [Conversation](../worker/conversation.ts)先提交输入／配置／认领再连接上游；[Alarm 回归](../tests/e2e/alarm.spec.ts)验证重入、原生重置、停止静默上游及尾部保存失败 | 通过 |
| 0.4 实时预览、保存确认和有界缓冲 | [缓冲](../worker/generation-buffer.ts)、[同步](../shared/stream-sync.ts)、[缓存写入](../src/snapshot-writer.ts)；[流式回归](../tests/e2e/streaming.spec.ts)检查预览先于保存、失败不确认、慢订阅和低频缓存 | 通过 |
| 0.5 四协议原始流解析与最终校验 | [共用解析器](../shared/provider-stream.ts)、[请求构造](../worker/provider.ts)；[逐字节恢复单测](../tests/provider-stream.test.ts)及原生流式回归检查 UTF-8／SSE／JSON 任意切分、正文、思考、终态和用量 | 通过 |
| 0.6 重连、跨设备、日志整理 | Conversation 的同步入口与最终事务；流式回归比较持久化前缀、实时尾部、完整快照及实例中断；[聊天回归](../tests/e2e/chat.spec.ts)验证页面关闭、离线和第二设备 | 通过 |
| 0.7 资源验证与个人预算 | [平台及本地报告](stream-measurements.md)、[容量限制](../worker/resource-limits.ts)、[原生容量回归](../tests/e2e/resource-limits.spec.ts)；当前工具路径尚无真实平台用量 | 部分证据，见下文 |
| 1.1 独立 URL 与 SPA | [路由](../src/useConversationRoute.ts)、[SPA 配置](../wrangler.jsonc)；[导航回归](../tests/e2e/navigation.spec.ts)及[生产离线回归](../tests/pwa/navigation.spec.ts)覆盖直达、登录、刷新、前进／后退及无效 URL | 通过 |
| 1.2 对话管理与持久化删除 | [Library](../worker/library.ts)、[对话操作](../src/ConversationActions.tsx)；[管理回归](../tests/e2e/management.spec.ts)检查排序、第二设备、停止与删除、清理重试、迟到 outbox 和删除游标分页 | 通过 |
| 1.3 当前／跨对话搜索与定位 | [页面搜索](../src/ConversationSearch.tsx)、[增量索引](../worker/search-index.ts)；[搜索回归](../tests/e2e/search.spec.ts)和[跨对话回归](../tests/e2e/library-search.spec.ts)检查正文／思考、分页、归档、索引失败和 Markdown 高亮 | 通过 |
| 1.4 引用、复制、代码、公式及图表 | [消息渲染与操作](../src/App.tsx)；[消息操作回归](../tests/e2e/message-actions.spec.ts)及搜索回归检查剪贴板、输入框引用、Shiki token、KaTeX、Mermaid、插件失败与流式滚动 | 通过 |
| 1.5 文本导出及可恢复备份 | [备份结构](../shared/backup.ts)、[ZIP 编解码](../shared/archive-codec.ts)、[页面入口](../src/App.tsx)；[备份回归](../tests/e2e/backup.spec.ts)实际下载三种文本格式及 ZIP，并恢复独立 URL，检查密钥排除 | 通过 |
| 2.1 分支、版本和任务关系 | 当前消息使用完整 `parentId` 父链、独立 `revisionOf` 及任务运行 ID；[Conversation](../worker/conversation.ts)、[分支回归](../tests/e2e/conversation-branches.spec.ts)检查模型实际收到的路径 | 通过 |
| 2.2 编辑／重新生成分支及指定消息复制 | [页面](../src/App.tsx)、Conversation 与 Library；[复制回归](../tests/e2e/conversation-copy.spec.ts)检查根到所选消息路径、独立 ID、旧分支、无效父链、用户末尾及生成中已保存前缀 | 通过 |
| 2.3 助手修订与单条删除 | [修订窗口](../src/MessageMutationDialog.tsx)、Conversation；[修订／删除回归](../tests/e2e/message-mutations.spec.ts)检查幂等、父链保留、后续上下文、索引、同步回放、备份和焦点 | 通过 |
| 2.4 会话参数与配置快照 | [共用配置规则](../shared/conversation-settings.ts)、[设置窗口](../src/ConversationSettings.tsx)；[参数回归](../tests/e2e/conversation-settings.spec.ts)检查继承、空提示词、未设输出上限、能力过滤、跨设备和离线固定 | 通过 |
| 2.5 提示词预设、用量和计时 | [预设](../src/PromptPresets.tsx)、[生成信息](../src/GenerationMetadata.tsx)、[元数据](../shared/generation.ts)；[预设回归](../tests/e2e/prompt-presets.spec.ts)和[用量回归](../tests/e2e/generation-metadata.spec.ts)覆盖复制语义、缺失报告、首输出、部分报告及取消 | 通过 |
| 3.1 模型能力和窗口 | [解析规则](../shared/model-metadata.ts)、[编辑入口](../src/ModelMetadataFields.tsx)；[元数据回归](../tests/e2e/model-metadata.spec.ts)检查手动优先、原生目录刷新、未知回退、恢复自动及任务固定 | 通过 |
| 3.2 输入估算和完整轮次预算 | [预算](../shared/context-budget.ts)、[有界估算](../shared/token-estimate.ts)、[页面估算](../src/ContextEstimate.tsx)；[预算回归](../tests/e2e/context-budget.spec.ts)检查云端拒绝、窗口类型、分支、近似标识和草稿保留 | 通过 |
| 3.3 手动及默认关闭的自动摘要 | [摘要规则](../shared/summaries.ts)、[摘要入口](../src/SummaryDialog.tsx)、Conversation；[摘要回归](../tests/e2e/summaries.spec.ts)检查费用提示、先保存后回答、旧事实、失败不重发、刷新／第二设备与重置 | 通过 |
| 3.4 摘要查看、重生成和覆盖边界 | 同一摘要规则及回归检查父链 ID 覆盖、增量摘要、旁支排除、原文保留、停用／删除、复制和备份重映射 | 通过 |
| 4.1 私有附件存储和管理 | [存储](../worker/attachments.ts)、[上传](../src/attachment-upload.ts)、[管理窗口](../src/AttachmentDialog.tsx)；[附件回归](../tests/e2e/attachments.spec.ts)检查鉴权、进度、取消、配额、第二设备和失败清理 | 通过 |
| 4.2 图片输入与视觉能力 | [图片处理](../src/chat-image.ts)、[模型输入](../worker/provider.ts)、[预览](../src/ImagePreviews.tsx)；[图片回归](../tests/e2e/images.spec.ts)验证四协议原生输入、仅图片、页面关闭、能力拒绝及分支引用 | 通过 |
| 4.3 轻量文本、代码和 CSV | [解析](../worker/document-parser.ts)、[边界](../shared/documents.ts)、[私有预览](../src/DocumentPreviews.tsx)；[文档回归](../tests/e2e/documents.spec.ts)检查四协议、受限 CSV、预算、失败、离线及删除竞争 | 通过 |
| 4.4 有文本 PDF | [浏览器提取](../src/chat-pdf.ts)、[独立 Worker 加载](../src/pdf-loader.ts)；[PDF 回归](../tests/e2e/pdf.spec.ts)与[生产资源回归](../tests/pwa/pdf.spec.ts)运行实际 pdfjs，检查页数／期限／内容边界及先保存再接受 | 通过 |
| 4.5 附件复制、备份及删除 | [复制登记](../worker/copy-jobs.ts)、[暂存恢复](../worker/archive-imports.ts)、Library；[附件复制](../tests/e2e/attachment-copy.spec.ts)与[附件备份](../tests/e2e/attachment-backup.spec.ts)检查独立文件、重映射、源删除、发布、幂等及中断清理 | 通过 |
| 5.1 工具持久化与过程展示 | [状态日志](../worker/tool-task-journal.ts)、[Workflow](../worker/tool-workflow.ts)、[公开流](../worker/tool-stream-relay.ts)、[展示](../src/ToolActivity.tsx)；[原生状态](../tests/e2e/tool-task-journal.spec.ts)和[编排回归](../tests/e2e/tool-workflow.spec.ts)检查恢复、失败、幂等、隐私与预算 | 通过 |
| 5.2 明确配置的搜索／网页读取及来源 | [Tavily 适配器](../worker/web-tool-service.ts)、[额度与设置](../worker/web-tool-settings.ts)、[网页设置](../src/WebToolSettings.tsx)；[服务回归](../tests/e2e/web-tool-service.spec.ts)验证生产适配器、固定端点、共享额度、期限与错误，来源在页面有可打开的 HTTPS 链接 | 通过本地集成 |
| 5.3 默认关闭的会话开关与有限权限 | 共用设置、会话参数和页面发送入口；[网页回归](../tests/e2e/web-tool-ui.spec.ts)检查四协议、独立启用、能力与配置预检、自动保存、离线、复制／恢复及下一新对话关闭 | 通过 |

消息正文、思考、图片和文件使用当前 `parts` 结构；工具过程使用独立且严格验证的公共状态，私有续接只保存在执行日志。普通聊天仍只使用 DO，Workflow 只为已启用的工具任务编排；没有保留普通聊天的旧 Workflow 执行路径，也没有添加版本迁移。

## 共享核心行为

| 验收行为 | 实际检查 |
|---|---|
| 关闭页面后继续 | 聊天、图片、文档、PDF、摘要及工具回归在接受后关闭唯一页面，随后从云端或第二设备读取终态 |
| 断网恢复已保存进度 | 原生流式回归保存半个 UTF-8／SSE 事件后重连；客户端与云端共享解析器，最终正文、思考和用量一致 |
| 第二设备一致 | 导航、管理、参数、预设、附件、摘要及工具场景比较云端持久化内容和另一个浏览器 context |
| 预览与保存确认分开 | 流式回归检查 `liveOffset` 与 `durableOffset`、生成中导出、缓存节流、失败保存后丢弃未确认尾部及终态日志整理 |
| 请求幂等及配置固定 | 同 ID 返回原结果，冲突拒绝；模型、摘要和工具调用计数不增加，设置变化不改变已接受输入或配置 |
| 停止后无新步骤 | Alarm、摘要和 Workflow 回归分别停止排队／静默上游／运行模型／工具，检查后续模型与外部尝试计数不增加 |
| 失败保留已保存内容 | EOF、取消尾部写入失败、SQL 容量、DO 重置、摘要及工具失败均检查已有前缀和原始消息，不发布虚假完成或自动重复未知请求 |

## 当前验证命令与结果

- `pnpm test`：最新 283 项通过，新增原生游标惰性计数、两类日志和报告隐私检查。
- `pnpm build`：内部应用／Worker／工具类型检查和生产构建通过。
- 改动测试与 fixture 的独立严格 TypeScript 检查通过；`git diff --check` 通过。
- `pnpm test:e2e`：首次完整运行 245 项，244 项通过；搜索高亮的即时读取断言失败。改为等待 Markdown 重绘后的实际高亮，4 项搜索场景复测通过。联网网页 12 项分批通过，包含之后新增的附件无效参数场景。当前 246 项不同场景均有通过结果，不宣称单次完整 246 项运行。
- `pnpm test:pwa`：最新生产构建的 2 项通过。
- `pnpm measure:stream --output /tmp/everchat-final-stream.json`：在 `12d9cb0` 上完成三场景，报告保存为 [stream-final.json](measurements/stream-final.json)。在线正文、在线正文加思考和首次预览后关闭唯一订阅均完整保存；检查点分别为 3／4／7，实际 SQL 写入为 32／37／52 行。
- 工具 Workflow／服务 30 项原生回归通过。新 HTTP 401 清理断言在修复前失败，修复后 HTTP 401／429 都验证通知自动清空；不人工触发 Alarm。
- `pnpm measure:tools`：默认七场景通过，报告为 [tools-baseline.json](measurements/tools-baseline.json)。四协议、断开订阅、服务拒绝及轮次上限均验证完整终态、私有清理和两个 DO 无待触发 Alarm；运行时身份与自建端口冲突另外验证通过。指标定义见[工具资源测量](tool-measurements.md)。
- Responses 的 [90,000 码元](measurements/tools-large.json)及[一分钟以上](measurements/tools-sustained.json)负载另行通过。长流首次因 Library 自然休眠丢失计数被拒绝；本地诊断增加只读观察后复测通过，明确排除自然休眠／活跃时长结论。

以上测试只操作临时本地空间与模拟上游。真实 Cloudflare 测量报告为已完成历史证据，列在下一节；本次没有部署、创建远程资源或实际模型／搜索请求。

## 资源证据及未通过的广泛结论

阶段 0 的隔离 Workers Free 报告已核对：用户确认套餐，诊断计数关闭；[9 项功能](measurements/cloudflare-functional.json)、[3 项一分钟以上生成](measurements/cloudflare-sustained.json)、[30 次终态重连](measurements/cloudflare-reconnect.json)及[大历史优化前](measurements/cloudflare-history-before.json)／[优化后](measurements/cloudflare-history-after.json)均有完整报告。三次验证各有远程资源清理确认；CPU、活跃时长、SQL、请求和采样边界见[测量说明](stream-measurements.md)。

当前容量由代码限制：最多 128 个对话、每个 SQLite 32 MiB；开始生成预留 16 MiB，写入到 30 MiB 停止；Library 搜索写入事务按整个数据库 256 MiB 检查；附件另有每空间 512 MiB、512 个及每日 100 次尝试。限制是应用保留预算，不是账户账单或所有部署共享的总量保证。

以下结论仍缺少证据，不能标为已验收：

1. **当前工具任务在 Workers Free 上的 CPU、活跃时长、SQL 和 Workflow 引擎用量。** 工具路径增加服务端解析、私有日志及 SDK 回放，普通聊天的平台报告不能证明它。已有七场景可重复本地计数，区分模型轮次、两类流、Conversation／Library SQL、步骤回调及引用结果大小；真实平台样本和引擎内部资源仍缺失。
2. **账户级实际存储及长期共享额度。** 历史 GraphQL 存储样本缺失，SQLite 分配只是保留预算参考；其他应用及用户负载无法从当前报告排除。原型容量与 507 错误处理不等于全部免费资源长期可用。
3. **真实服务质量和账户权限。** Tavily 适配器通过模拟 HTTP 集成，实际密钥权限、结果质量及第三方抓取隔离没有被这些测试证明；真实模型生成的摘要质量同样不由固定 fixture 证明。

阶段 0 已按路线图历史记录在“已测个人负载＋容量保护”边界收敛，不为缺失的存储采样反复部署或无止境调优。工具本地测量检查点已完成；下一步按[已列出的平台负载](tool-measurements.md#下一次平台验证负载)准备隔离验证入口和执行脚本，关闭诊断计数，再记录真实平台资源和清理证据。本次没有部署，不使用本地计数冒充 CPU 或账单。

## 条件项与范围

手动排序、同会话新话题历史及跨对话记忆在计划中允许后补或按实际需要引入；Office 文档解析以先验证托管服务为条件。第 5 节的自动命名、图片生成、供应商专用接入及其他按需功能没有在本次自动扩展。原型仍只提供有界只读联网调用，不提供桌面执行环境、代码沙箱、本地桥接或全权限执行。

结论：阶段 0–5 的功能实现及本地原型验收已具备证据；广泛的当前版本免费层适配仍不成立。整体目标保持进行中，后续工作由上述明确缺口驱动，不以功能测试通过替代资源验收，也不自动扩大到条件项。
