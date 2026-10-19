# 路线图实施与验收核对

核对日期：2026-10-15；最终完整检查基准：`a0fff7c`，工具平台部署基于 `5ea6900`。范围来自[实施路线图](../plans/serverless-feature-roadmap.md)的阶段 0–5、各阶段验收与共享核心行为。阶段 0–5 的必做项已完成；本轮逐项核对源码、断言、完整运行结果和平台报告。功能证据与资源证据分别记录；本地模拟通过不能证明真实供应商质量或免费账单。

## 功能条目

表中“通过”指当前实现和对应本地回归已核对。阶段 0 的真实平台测量另列，不能用这一列代替。

| 条目                                 | 当前实现与证据                                                                                                                                                                                                                                                                                                                                                                    | 结果                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 0.1 原链路基线及计量口径             | [测量脚本](../../scripts/measurements/stream-baseline.ts)、[改造前报告](../measurements/stream-baseline.json)、[指标定义](../measurements/stream-measurements.md)；区分实际经过时间、SQL 游标计数与平台 CPU                                                                                                                                                                       | 已记录                   |
| 0.2 任务、日志、快照和偏移           | [类型](../../shared/streaming/protocol.ts)、[流日志](../../worker/streaming/journal.ts)、[SQLite 定义](../../worker/conversation/schema.ts)；[日志单测](../../tests/unit/streaming/stream-journal.test.ts)检查提交／整理事务与失败回滚                                                                                                                                            | 通过                     |
| 0.3 普通聊天 DO＋Alarm               | [Conversation](../../worker/conversation/durable-object.ts)先提交输入／配置／认领再连接上游；[Alarm 回归](../../tests/integration/generation/alarm.spec.ts)验证重入、原生重置、停止静默上游及尾部保存失败                                                                                                                                                                         | 通过                     |
| 0.4 实时预览、保存确认和有界缓冲     | [缓冲](../../worker/generation/buffer.ts)、[同步](../../shared/streaming/sync.ts)、[缓存写入](../../src/features/chat/snapshot-writer.ts)；[流式回归](../../tests/e2e/chat/streaming.spec.ts)检查预览先于保存、失败不确认、慢订阅和低频缓存                                                                                                                                       | 通过                     |
| 0.5 四协议原始流解析与最终校验       | [共用解析器](../../shared/streaming/provider-stream.ts)、[请求构造](../../worker/providers/stream.ts)；[逐字节恢复单测](../../tests/unit/streaming/provider-stream.test.ts)及原生流式回归检查 UTF-8／SSE／JSON 任意切分、正文、思考、终态和用量                                                                                                                                   | 通过                     |
| 0.6 重连、跨设备、日志整理           | Conversation 的同步入口与最终事务；流式回归比较持久化前缀、实时尾部、完整快照及实例中断；[聊天回归](../../tests/e2e/chat/chat.spec.ts)验证页面关闭、离线和第二设备                                                                                                                                                                                                                | 通过                     |
| 0.7 资源验证与个人预算               | [普通聊天](../measurements/stream-measurements.md)、[当前工具平台样本](../measurements/tools-cloudflare-measurements.md)、[容量限制](../../worker/platform/resource-limits.ts)、[原生容量回归](../../tests/e2e/platform/resource-limits.spec.ts)；CPU 高样本及采样缺失单列                                                                                                        | 已测个人原型负载，见边界 |
| 1.1 独立 URL 与 SPA                  | [路由](../../src/app/useConversationRoute.ts)、[SPA 配置](../../wrangler.jsonc)；[导航回归](../../tests/e2e/chat/navigation.spec.ts)及[生产离线回归](../../tests/pwa/navigation.spec.ts)覆盖直达、登录、刷新、前进／后退及无效 URL                                                                                                                                                | 通过                     |
| 1.2 对话管理与持久化删除             | [Library](../../worker/library/durable-object.ts)、[对话操作](../../src/features/chat/ConversationActions.tsx)；[管理回归](../../tests/e2e/library/management.spec.ts)检查排序、第二设备、停止与删除、清理重试、迟到 outbox 和删除游标分页                                                                                                                                        | 通过                     |
| 1.3 当前／跨对话搜索与定位           | [页面搜索](../../src/features/chat/ConversationSearch.tsx)、[增量索引](../../worker/search/index.ts)；[搜索回归](../../tests/e2e/chat/search.spec.ts)和[跨对话回归](../../tests/e2e/library/library-search.spec.ts)检查正文／思考、分页、统一范围、删除过滤、索引失败和 Markdown 高亮                                                                                             | 通过                     |
| 1.4 引用、复制、代码、公式及图表     | [消息渲染与操作](../../src/app/App.tsx)；[消息操作回归](../../tests/e2e/chat/message-actions.spec.ts)及搜索回归检查剪贴板、输入框引用、Shiki token、KaTeX、Mermaid、插件失败与流式滚动                                                                                                                                                                                            | 通过                     |
| 1.5 文本导出及可恢复备份             | [备份结构](../../shared/backup/backup.ts)、[ZIP 编解码](../../shared/backup/codec.ts)、[页面入口](../../src/app/App.tsx)；[备份回归](../../tests/e2e/backup/backup.spec.ts)实际下载三种文本格式及 ZIP，并恢复独立 URL，检查密钥排除                                                                                                                                               | 通过                     |
| 2.1 分支、版本和任务关系             | 当前消息使用完整 `parentId` 父链、独立 `revisionOf` 及任务运行 ID；[Conversation](../../worker/conversation/durable-object.ts)、[分支回归](../../tests/e2e/chat/conversation-branches.spec.ts)检查模型实际收到的路径                                                                                                                                                              | 通过                     |
| 2.2 编辑／重新生成分支及指定消息复制 | [页面](../../src/app/App.tsx)、Conversation 与 Library；[复制回归](../../tests/e2e/backup/conversation-copy.spec.ts)检查根到所选消息路径、独立 ID、旧分支、无效父链、用户末尾及生成中已保存前缀                                                                                                                                                                                   | 通过                     |
| 2.3 助手修订与单条删除               | [原位编辑](../../src/features/chat/MessageEditor.tsx)、Conversation；[修订／删除回归](../../tests/e2e/chat/message-mutations.spec.ts)检查幂等、父链保留、后续上下文、索引、同步回放、备份和焦点                                                                                                                                                                                   | 通过                     |
| 2.4 会话参数与配置快照               | [共用配置规则](../../shared/conversation/settings.ts)、[设置窗口](../../src/features/chat/ConversationSettings.tsx)；[参数回归](../../tests/e2e/chat/conversation-settings.spec.ts)检查继承、空提示词、未设输出上限、能力过滤、跨设备和离线固定                                                                                                                                   | 通过                     |
| 2.5 提示词预设、用量和计时           | [预设](../../src/features/presets/PromptPresets.tsx)、[生成信息](../../src/features/chat/GenerationMetadata.tsx)、[元数据](../../shared/streaming/generation.ts)；[预设回归](../../tests/e2e/presets/prompt-presets.spec.ts)和[用量回归](../../tests/e2e/chat/generation-metadata.spec.ts)覆盖复制语义、缺失报告、首输出、部分报告及取消                                          | 通过                     |
| 3.1 模型能力和窗口                   | [解析规则](../../shared/models/metadata.ts)、[编辑入口](../../src/features/providers/ModelMetadataFields.tsx)；[元数据回归](../../tests/e2e/providers/model-metadata.spec.ts)检查手动优先、原生目录刷新、未知回退、恢复自动及任务固定                                                                                                                                             | 通过                     |
| 3.2 输入估算和完整轮次预算           | [预算](../../shared/conversation/context-budget.ts)、[有界估算](../../shared/conversation/token-estimate.ts)、[页面估算](../../src/features/chat/ContextEstimate.tsx)；[预算回归](../../tests/e2e/chat/context-budget.spec.ts)检查云端拒绝、窗口类型、分支、近似标识和草稿保留                                                                                                    | 通过                     |
| 3.3 手动及默认关闭的自动摘要         | [摘要规则](../../shared/conversation/summaries.ts)、[摘要入口](../../src/features/chat/SummaryDialog.tsx)、Conversation；[摘要回归](../../tests/e2e/chat/summaries.spec.ts)检查费用提示、先保存后回答、旧事实、失败不重发、刷新／第二设备与重置                                                                                                                                   | 通过                     |
| 3.4 摘要查看、重生成和覆盖边界       | 同一摘要规则及回归检查父链 ID 覆盖、增量摘要、旁支排除、原文保留、停用／删除、复制和备份重映射                                                                                                                                                                                                                                                                                    | 通过                     |
| 4.1 私有附件存储和管理               | [存储](../../worker/attachments/store.ts)、[上传](../../src/features/attachments/attachment-upload.ts)、[管理窗口](../../src/features/attachments/AttachmentDialog.tsx)；[附件回归](../../tests/e2e/attachments/attachments.spec.ts)检查鉴权、进度、取消、配额、第二设备和失败清理                                                                                                | 通过                     |
| 4.2 图片输入与视觉能力               | [图片处理](../../src/features/attachments/chat-image.ts)、[模型输入](../../worker/providers/stream.ts)、[预览](../../src/features/attachments/ImagePreviews.tsx)；[图片回归](../../tests/e2e/attachments/images.spec.ts)验证四协议原生输入、仅图片、页面关闭、能力拒绝及分支引用                                                                                                  | 通过                     |
| 4.3 轻量文本、代码和 CSV             | [解析](../../worker/attachments/parser.ts)、[边界](../../shared/attachments/documents.ts)、[私有预览](../../src/features/attachments/DocumentPreviews.tsx)；[文档回归](../../tests/e2e/attachments/documents.spec.ts)检查四协议、受限 CSV、预算、失败、离线及删除竞争                                                                                                             | 通过                     |
| 4.4 有文本 PDF                       | [浏览器提取](../../src/features/attachments/chat-pdf.ts)、[独立 Worker 加载](../../src/features/attachments/pdf-loader.ts)；[PDF 回归](../../tests/e2e/attachments/pdf.spec.ts)与[生产资源回归](../../tests/pwa/pdf.spec.ts)运行实际 pdfjs，检查页数／期限／内容边界及先保存再接受                                                                                                | 通过                     |
| 4.5 附件复制、备份及删除             | [复制登记](../../worker/backup/copies.ts)、[暂存恢复](../../worker/backup/imports.ts)、Library；[附件复制](../../tests/e2e/backup/attachment-copy.spec.ts)与[附件备份](../../tests/e2e/backup/attachment-backup.spec.ts)检查独立文件、重映射、源删除、发布、幂等及中断清理                                                                                                        | 通过                     |
| 5.1 工具持久化与过程展示             | [状态日志](../../worker/web-tools/task-journal.ts)、[Workflow](../../worker/web-tools/workflow.ts)、[公开流](../../worker/web-tools/stream-relay.ts)、[展示](../../src/features/web-tools/ToolActivity.tsx)；[原生状态](../../tests/integration/web-tools/tool-task-journal.spec.ts)和[编排回归](../../tests/e2e/web-tools/tool-workflow.spec.ts)检查恢复、失败、幂等、隐私与预算 | 通过                     |
| 5.2 明确配置的搜索／网页读取及来源   | [Tavily 适配器](../../worker/web-tools/service.ts)、[额度与设置](../../worker/web-tools/settings.ts)、[网页设置](../../src/features/web-tools/WebToolSettings.tsx)；[服务回归](../../tests/integration/web-tools/web-tool-service.spec.ts)验证生产适配器、固定端点、共享额度、期限与错误，来源在页面有可打开的 HTTPS 链接；平台样本仍使用模拟外部响应                             | 通过集成与已测平台负载   |
| 5.3 默认关闭的会话开关与有限权限     | 共用设置、会话参数和页面发送入口；[网页回归](../../tests/e2e/web-tools/web-tool-ui.spec.ts)检查四协议、独立启用、能力与配置预检、自动保存、离线、复制／恢复及下一新对话关闭                                                                                                                                                                                                       | 通过                     |

消息正文、思考、图片和文件使用当前 `parts` 结构；工具过程使用独立且严格验证的公共状态，私有续接只保存在执行日志。普通聊天仍只使用 DO，Workflow 只为已启用的工具任务编排；没有保留普通聊天的旧 Workflow 执行路径，也没有添加版本迁移。

## 共享核心行为

| 验收行为           | 实际检查                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 关闭页面后继续     | 聊天、图片、文档、PDF、摘要及工具回归在接受后关闭唯一页面，随后从云端或第二设备读取终态                            |
| 断网恢复已保存进度 | 原生流式回归保存半个 UTF-8／SSE 事件后重连；客户端与云端共享解析器，最终正文、思考和用量一致                       |
| 第二设备一致       | 导航、管理、参数、预设、附件、摘要及工具场景比较云端持久化内容和另一个浏览器 context                               |
| 预览与保存确认分开 | 流式回归检查 `liveOffset` 与 `durableOffset`、生成中导出、缓存节流、失败保存后丢弃未确认尾部及终态日志整理         |
| 请求幂等及配置固定 | 同 ID 返回原结果，冲突拒绝；模型、摘要和工具调用计数不增加，设置变化不改变已接受输入或配置                         |
| 停止后无新步骤     | Alarm、摘要和 Workflow 回归分别停止排队／静默上游／运行模型／工具，检查后续模型与外部尝试计数不增加                |
| 失败保留已保存内容 | EOF、取消尾部写入失败、SQL 容量、DO 重置、摘要及工具失败均检查已有前缀和原始消息，不发布虚假完成或自动重复未知请求 |

## 逐阶段验收

以下逐项对应路线图各阶段的“验收”，与上方 29 个功能条目及七项共享行为共同构成完成检查。完整运行的测试文件、用例名称和结果保存在[最终验收报告](../measurements/final-acceptance.json)。

| 阶段 | 核对的验收内容                                                                                                       | 当前证据与结论                                                                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | 四协议实时／最终一致、任意分段、离线继续、双设备、回放边界、慢订阅、保存失败、停止／重入／重启、持久化导出与日志整理 | `streaming`、`alarm`、`chat`、`resource-limits` 回归及协议／日志单测通过；断言比较正文、思考、偏移、快照和实际模型请求计数。真实平台负载及个人余量见[普通聊天测量](../measurements/stream-measurements.md)，容量与采样边界保留 |
| 1    | URL 直达／刷新／历史、跨设备管理、正文定位、独立恢复、代码／公式流式滚动                                             | 导航、管理、两类搜索、消息操作、备份、聊天及生产 PWA 回归通过；页面标记验证 SPA 未整页刷新，恢复使用独立 ID，渲染检查实际 Shiki／KaTeX／Mermaid 内容                                                                           |
| 2    | 当前分支上下文、重连、配置快照与继承、供应商用量和缺失值                                                             | 分支、复制、消息修订、会话参数、预设和生成元数据回归通过；检查实际保存的模型输入，不把旁支加入上下文，不为缺失用量补 0。历史版本继续保留在同一对话中                                                                           |
| 3    | 早期事实、摘要覆盖与分支、刷新／换设备幂等、近似估算与未知回退、失败保留原文                                         | 上下文预算、元数据和摘要回归通过；fixture 只有实际请求包含旧事实才返回相应回答，同时检查摘要先保存、调用次数、覆盖 ID 和原始消息                                                                                               |
| 4    | 接受后关闭页面、第二设备私有读取、视觉限制、解析失败、附件删除与备份                                                 | 附件、图片、文档、真实 pdfjs、独立复制和 ZIP 备份回归通过；核对原始字节、摘要、引用重映射、清理和未配置 R2 时的聊天可用性。Office 托管解析仍是条件项                                                                           |
| 5    | 过程断线恢复、重复请求、超时／预算停止、来源链接、未知能力限制                                                       | 原生工具日志、Workflow、生产 Tavily 适配器和网页配置回归通过；核对模型／外部尝试次数、后续步骤未启动、私有数据隔离与终态通知清空。[平台 11 项场景](../measurements/tools-cloudflare-measurements.md)另有证据                   |

## 最终验证命令与结果

- `pnpm check`：在干净的 `a0fff7c` 工作树上单次完整运行成功，退出码为 0；包含下述四个阶段，以本轮结果替代之前分批通过的口径。
- `pnpm test`：285 项通过，失败、取消、跳过及待办均为 0，包含游标计数、两类日志、报告隐私及执行器身份检查。
- `pnpm build`：应用／Worker／工具类型检查和生产构建通过。动态加载的部分语言／图表模块仍有大于 500 kB 的构建提示。
- `pnpm test:e2e`：30 个文件、246 项全部通过，单次运行 21.5 分钟；覆盖本表所有阶段及共享行为，使用原生 Cloudflare 本地运行时。
- `pnpm test:pwa`：最新生产构建的 2 项全部通过，验证离线 URL／正文／思考／主题高亮及真实 PDF Worker、中文 CMaps 与字体。
- 根 `tsconfig.json` 检查与平台 fixture／执行器测试的独立严格 TypeScript 检查通过；完整命令见最终验收报告。检查期间没有修改代码，测试网页服务使用 5174／5175 和隔离存储；测试结束后两个端口均已释放，日常 5173 服务保留。
- 新增报告可解析，验收文档的本地证据链接有效，`git diff --check` 通过。
- `pnpm measure stream --output /tmp/everchat-final-stream.json`：在 `12d9cb0` 上完成三场景，报告保存为 [stream-final.json](../measurements/stream-final.json)。在线正文、在线正文加思考和首次预览后关闭唯一订阅均完整保存；检查点分别为 3／4／7，实际 SQL 写入为 32／37／52 行。
- 工具 Workflow／服务 30 项原生回归通过。新 HTTP 401 清理断言在修复前失败，修复后 HTTP 401／429 都验证通知自动清空；不人工触发 Alarm。
- `pnpm measure tools`：默认七场景通过，报告为 [tools-baseline.json](../measurements/tools-baseline.json)。四协议、断开订阅、服务拒绝及轮次上限均验证完整终态、私有清理和两个 DO 无待触发 Alarm；运行时身份与自建端口冲突另外验证通过。指标定义见[工具资源测量](../measurements/tool-measurements.md)。
- Responses 的 [90,000 码元](../measurements/tools-large.json)及[一分钟以上](../measurements/tools-sustained.json)负载另行通过。长流首次因 Library 自然休眠丢失计数被拒绝；本地诊断增加只读观察后复测通过，明确排除自然休眠／活跃时长结论。
- [专用平台入口和执行器](../measurements/tool-platform-validation.md)关闭上述计数，使用原生生产 Workflow、无 R2 的临时环境，通过本地九项功能、90,000 码元和 77.5 秒长流；生成期间不轮询 Library，终态接口不调用过期处理。三份报告标记 `runtime: local`，远程指标脚本拒绝将其作为平台窗口；专用 Worker dry-run 打包通过，随后部署见下条。
- 后续以 `5ea6900` 在用户确认的 Workers Free 账户完成[11 项工具平台场景](../measurements/tools-cloudflare-measurements.md)，含 12 个 Workflow、22 次模型／22 次模拟工具请求。关闭诊断计数；真实 Worker／DO／Workflow 样本及终态 SQLite 分配单列。退避后 Workflow 图表补齐 12 个成功、90 个操作、71ms CPU。Worker、Workflow、两个 namespace 和验证 Secrets 已核实清理。DO 汇总在固定窗口中非单调、CPU 高样本、取消／断流及 SQL 存储无采样均保留，不写成精确账单、零开销或严格低于 10ms。

本地测试只操作临时空间与模拟上游；后续平台验证创建并清理了明确命名的隔离资源。普通聊天历史报告及当前工具报告分开记录，均未修改正式配置，也没有实际模型／搜索付费请求。

## 资源证据与结论边界

阶段 0 的隔离 Workers Free 报告已核对：用户确认套餐，诊断计数关闭；[9 项功能](../measurements/cloudflare-functional.json)、[3 项一分钟以上生成](../measurements/cloudflare-sustained.json)、[30 次终态重连](../measurements/cloudflare-reconnect.json)及[大历史优化前](../measurements/cloudflare-history-before.json)／[优化后](../measurements/cloudflare-history-after.json)均有完整报告。三次验证各有远程资源清理确认；CPU、活跃时长、SQL、请求和采样边界见[测量说明](../measurements/stream-measurements.md)。

当前容量由代码限制：最多 128 个对话、每个 SQLite 32 MiB；开始生成预留 16 MiB，写入到 30 MiB 停止；Library 搜索写入事务按整个数据库 256 MiB 检查；附件另有每空间 512 MiB、512 个及每日 100 次尝试。限制是应用保留预算，不是账户账单或所有部署共享的总量保证。

以下广泛结论仍缺少证据，不属于本次已证明的原型能力：

1. **当前工具任务的资源边界。** 已有七场景本地计数与 11 项真实平台场景，分别记录 Worker／DO CPU、活跃时长、SQL 和 Workflow CPU／步骤／状态增长；普通聊天报告不再被用来代替工具路径。图表延迟到达、个别 CPU 样本高于 10ms，`storageRate` 也不是引擎保留存储或账单；不能据此宣称所有请求严格低于限制或整个账户长期免费。
2. **账户级实际存储及长期共享额度。** 历史 GraphQL 存储样本缺失，SQLite 分配只是保留预算参考；其他应用及用户负载无法从当前报告排除。原型容量与 507 错误处理不等于全部免费资源长期可用。
3. **真实服务质量和账户权限。** Tavily 适配器通过模拟 HTTP 集成，实际密钥权限、结果质量及第三方抓取隔离没有被这些测试证明；真实模型生成的摘要质量同样不由固定 fixture 证明。

阶段 0 按路线图历史记录在“已测个人负载＋容量保护”边界收敛。当前工具本地计量、关闭计数的平台验证与远程清理也已完成。本轮核实平台功能报告的场景完整性、三个工具功能报告的 SHA-256、清理标记及验收文档的本地证据链接；没有为缺失的 SQL 存储采样再次部署。个人原型的完成结论保持这一既定边界，不将本地计数当作 CPU 或账单，也不将长期账户保证加入完成条件。

## 条件项与范围

手动排序、同会话新话题历史及跨对话记忆在计划中允许后补或按实际需要引入；Office 文档解析以先验证托管服务为条件。第 5 节的自动命名、图片生成、供应商专用接入及其他按需功能没有在本次自动扩展。原型仍只提供有界只读联网调用，不提供桌面执行环境、代码沙箱、本地桥接或全权限执行。

结论：阶段 0–5 的必做功能、各阶段验收、七项共享行为、当前完整本地检查和已测个人平台负载均已核对，路线图原型实施完成。条件项与明确排除项保持原范围；上述资源采样、真实服务质量和账户共享额度边界继续有效。
