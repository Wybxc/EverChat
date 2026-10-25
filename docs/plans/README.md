# 本轮执行计划

更新日期：2026-10-25。按本索引收录的独立开发／改进目标去重，目前共 **21 项：14 项已实施，6 项待实施，1 项待真机与平台收尾**。已实施项中尚缺真实平台资源证据的检查继续单独保留。本目录的其他文档主要保留已完成实施、历史方案和验证记录，不按文件数量计算待办。

| 计划                                                                                  | 状态                           | 范围                                                                                             |
| ------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| [AI SDK Core 与 UI 深度集成](ai-sdk-core-ui-adoption-plan.md)                         | 已上线，生产功能验收通过       | Core 统一调用与工具容错、UI 类型选择性复用、保留自有同步状态、恢复；资源缺项独立跟进             |
| [同步请求与免费层资源排查](sync-worker-resource-investigation-plan.md)                | 待实施，独立于 Core 发布       | 同步 CPU 尖峰归因、平台 profile 与 DO 指标可用性、同负载资源对照                                 |
| [EverChat MCP Server](everchat-mcp-server-plan.md)                                    | 已上线，生产接口及界面验收通过 | 统一自动化聊天、精确续聊、幂等与分页结果；四个核心工具，可删除 API Key 与管理页                  |
| [MCP 上下文可见性与讨论记录](mcp-discussion-observability-plan.md)                    | 设计完成，待实施               | 实际输入回执、长任务进展、截断与用量、分支读取／导出、文件版本及独立提案／审查；附件传输复用专项 |
| [EverChat MCP 附件](mcp-attachments-plan.md)                                          | 设计完成，待实施               | 批量签发 R2 PUT URL、直传、聊天内自动保存；图片／文本／PDF、小文件入口及离线迁移                 |
| [网页附件 R2 直传](r2-direct-upload-plan.md)                                          | 已上线，本地及生产签名验证通过 | 浏览器预签名 PUT、批量登记、HEAD 接收、防覆盖、进度／取消及延迟清理；PR #9 已合并发布            |
| [AI Elements 与 Chart 界面优化](ai-elements-chart-ui-plan.md)                         | 设计完成，待实施               | 消息／思考与工具／输入组合、统一图表、滚动组件对照与迁移、分享展示复用                           |
| [new-api 连接信息导入](new-api-connection-import-plan.md)                             | 设计完成，待实施               | 粘贴识别、配置预览、地址映射、重复识别和模型获取                                                 |
| [供应商余额与额度](provider-balance-plan.md)                                          | 设计完成，待实施               | DeepSeek、new-api、Sub2API 适配、分层指标、按需查询和缓存；后续扩展 OpenRouter                   |
| [HTML 入口拆分](html-entrypoints-plan.md)                                             | 已实施，本地与生产入口验收通过 | 聊天与分享双 HTML、静态分流、独立启动、按需缓存及 PWA 更新验收                                   |
| [AI SDK 集成完善](ai-sdk-integration-improvements-plan.md)                            | 已实施，完成本地验收           | 诊断透传、完整用量、类型化错误、共享工具参数、结构化流处理及 Core 兼容性实验                     |
| [供应商流解析迁移到 AI SDK](provider-sdk-streaming-plan.md)                           | 已实施，完成本地验收           | 使用匹配协议的 SDK 实时解析，统一应用事件，保留错误、用量、工具续接和低频持久化                  |
| [对话存储重构](conversation-storage-capacity-plan.md)                                 | 已实现，完成本地验收           | 移除持久化同步事件，改用状态同步和生成检查点；消除存储放大，调整容量准入和长历史读取             |
| [前端设计规范遵循](message-editing-density-plan.md#前端设计规范遵循实施与验收)        | 已形成规范并完成全站核查、整改 | 统一并检查间距、控件尺寸、排版、语义色、操作分组、交互状态和移动端可用性                         |
| [DeepSeek Search／Fetch 接入](deepseek-web-tools-plan.md)                             | 已实现，模拟服务验收           | 新增联网服务选择、独立配置、搜索／网页读取适配及错误处理                                         |
| [拖拽上传图片／文件](drag-drop-upload-plan.md)                                        | 已实现，拖放场景验收           | 复用现有附件流程，增加拖放入口、反馈、错误处理及交互边界                                         |
| [思考与联网信息按顺序展示](reasoning-web-tools-flow-plan.md)                          | 已实现，完成本地验收           | 记录每轮工具在思考文字中的位置，合并为一个按执行顺序展示的思考区，覆盖流式、搜索与恢复           |
| [移除在线数据迁移](../operations/offline-storage-migration.md#在线迁移排查2026-10-18) | 已实现，完成本地验收           | 删除历史索引自动回填，提供本地索引重建与维护补丁；保留正常业务同步与任务恢复                     |
| [回答完成通知](answer-completion-notifications-plan.md)                               | A／B 已实现，C 阶段待验收      | 三种通知策略、本实例授权、在线通知、服务端 Web Push、后台条件协调与真机验收                      |
| [用量与费用统计](usage-cost-statistics-plan.md)                                       | 已实施，生产用量入账验收通过   | 实际请求账本、定价、费用估算、供应商／模型汇总、趋势和请求明细                                   |
| [可撤销的只读分享](revocable-readonly-sharing-plan.md)                                | 已实施，生产匿名与撤销验收通过 | 同域公开前端、Access 保护私有 API、分支快照、令牌只读访问、有效期及撤销                          |

费用统计与分享均已实现、通过本地及浏览器验收，生产离线迁移、业务部署、真实用量入账与匿名分享／撤销验收已完成。分享使用同域名，Access 只保护私有后端；旧版 PWA／SW 需先更新一次，附件共享另作后续阶段。两项遵循 Workers Free 资源约束，详见[执行记录](../measurements/usage-sharing-implementation-2026-10-19.md)。

HTML 入口、AI SDK 集成／流解析和存储重构已完成既定实施；思考展示与离线迁移两项沿用现有存储与后台执行机制，验证记录见[思考展示与离线迁移](../measurements/reasoning-tools-offline-migrations-2026-10-18.md)。每个计划内部的实施阶段不重复计为独立计划。

回答完成通知已实现设置、页面通知和服务端 Web Push，生产 VAPID Secrets 已配置；已通过规则、原生运行时、生产 SW 和 Cloudflare 加密路径测试。用户已确认 macOS 后台／退出、iOS 锁屏／关闭 App 后收到通知且点击定位正确；macOS 锁屏、系统权限撤销、专注模式、FCM 实际网关与独立资源测量等仍按 C 阶段验收，详见该计划的真机记录。

竞品视觉对照、部分真机／Access 扩展验证及生产网络耗时测量属于既有计划的收尾事项，单独保留其证据边界；不因主要功能已完成就将这些检查记为已通过。竞品访问仍按用户要求等待授权。

早期实施、测量及尚未执行的外部验收分别记录在[本轮执行结果](../measurements/plan-execution-2026-10-18.md)。费用／分享新增生产证据见上述 10 月 19 日记录；未执行的 DeepSeek 联网服务真实计费、DO CPU／活跃时长和额外真机／竞品访问不伪记为通过。
