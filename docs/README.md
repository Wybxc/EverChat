# 文档索引

[返回项目首页](../README.md)

## 使用与贡献

- [使用指南](user-guide.md)：配置供应商、聊天、分支、附件、搜索、分享与通知。
- [开发指南](development.md)：本地环境、Access 联调、格式化、测试与测量。
- [测试说明](../tests/README.md)：测试分层、夹具、发现规则及执行入口。
- [界面语言与翻译维护](features/i18n.md)：词条组织、语言偏好、错误和导出文案。

## 部署与运维

- [自行部署](operations/self-hosting.md)：资源配置、Access 路径和可选 Secrets。
- [现有生产部署记录](operations/cloudflare-deployment.md)：已部署资源、自动构建、原生告警和线上验收。
- [离线存储迁移](operations/offline-storage-migration.md)：维护窗口、备份、转换、应用、校验和回滚。

## 架构与约束

- [运行架构与数据流](architecture/runtime.md)：后台生成、分层流处理、持久化、状态同步及安全边界。
- [模块与运行环境](architecture/modules.md)：目录职责、依赖方向和原子性边界。
- [前端设计规范](architecture/frontend-design-standard.md)：布局、尺寸、语义色、交互状态及可访问性。
- [免费层资源政策](architecture/free-tier-resource-policy.md)：应用保护预算、平台依据和容量取舍。
- [应用限制审查](architecture/application-limit-audit.md)：限制的来源、改动与验证范围。
- 工具执行：[协议](architecture/tool-protocol.md)、[任务状态](architecture/tool-task-state.md)、[执行流程](architecture/tool-workflow.md)。

## 功能专题

| 主题         | 文档                                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模型与上下文 | [模型元数据](features/model-metadata.md)、[上下文预算](features/context-budget.md)、[历史摘要](features/history-summaries.md)                                                                        |
| 文件输入     | [对话文件](features/attachments.md)、[图片](features/images.md)、[文本与 CSV](features/documents.md)、[PDF](features/pdf.md)                                                                         |
| 数据保留     | [附件复制](features/attachment-copies.md)、[附件备份](features/attachment-backups.md)                                                                                                                |
| 联网工具     | [服务实现](features/web-tool-service.md)、[DeepSeek 接入及实施记录](plans/deepseek-web-tools-plan.md)、[思考与工具过程](plans/reasoning-web-tools-flow-plan.md)                                      |
| 用量与分享   | [费用统计方案](plans/usage-cost-statistics-plan.md)、[只读分享方案](plans/revocable-readonly-sharing-plan.md)、[执行记录](measurements/usage-sharing-implementation-2026-10-19.md)                   |
| 通知         | [回答通知方案与真机记录](plans/answer-completion-notifications-plan.md)                                                                                                                              |
| 自动化聊天   | [MCP 接入与密钥管理](features/mcp.md)、[设计与实施范围](plans/everchat-mcp-server-plan.md)、[附件扩展计划](plans/mcp-attachments-plan.md)、[本地验收](measurements/mcp-implementation-2026-10-21.md) |

## 设计、计划与验收

[执行计划索引](plans/README.md)记录各项工作的状态，不以文档数量计算待办。带日期的方案和测量是对应版本的设计与证据；早期描述可能已被后续实现取代，使用操作以[使用指南](user-guide.md)为入口，当前资源预算以[免费层资源政策](architecture/free-tier-resource-policy.md)为准。

- 功能演进：[Serverless 路线图](plans/serverless-feature-roadmap.md)、[早期实施与验收核对](architecture/implementation-audit.md)。
- 新增接入：[EverChat MCP Server](plans/everchat-mcp-server-plan.md)、[new-api 连接信息导入设计](plans/new-api-connection-import-plan.md)、[供应商余额与额度](plans/provider-balance-plan.md)；功能调研：[DSH 热门插件借鉴](research/dsh-plugins-review-2026-10-20.md)。
- 界面设计：[AI Elements 与 Chart 优化](plans/ai-elements-chart-ui-plan.md)、[shadcn/ui 迁移](plans/shadcn-ui-migration-plan.md)、[首轮优化](plans/frontend-refinement-plan.md)、[紧凑布局](plans/frontend-compact-layout-plan.md)、[消息编辑与密度](plans/message-editing-density-plan.md)。
- 交互体验：[慢连接加载](plans/slow-connection-ui-plan.md)、[对话体验](plans/conversation-experience-improvement-plan.md)、[侧栏操作](plans/sidebar-conversation-actions-plan.md)、[阅读导航](plans/conversation-message-navigation-plan.md)、[分支导航](plans/conversation-branch-navigation-plan.md)、[PWA 与移动端](plans/pwa-mobile-navigation-theme-plan.md)。
- 工程整理：[模块划分](plans/project-organization-plan.md)、[配置与脚本](plans/repository-configuration-and-scripts-plan.md)、[i18n 架构](plans/i18n-architecture-plan.md)、[Access 迁移](plans/cloudflare-access-migration-plan.md)。
- [Base UI 迁移记录](migrations/base-ui/project.md)：逐组件变更、交互差异、验证结果与包体积对比；[cmdk 依赖调研](research/cmdk-radix-dependency-2026-10-21.md)及 [Command 替换实施](migrations/base-ui/command.md)。
- [测量命令与报告入口](measurements/README.md)：流处理、工具、通知、用量和分享的复现方法与平台证据。
- [WebKit 流式结束滚动排查](measurements/webkit-stream-completion-scroll-2026-10-18.md)、[分享全文加载记录](measurements/sharing-fulltext-2026-10-19.md)。

界面参考图片保留在 `references/`；测量原始 JSON 保留在 `measurements/`，与对应说明一起阅读。
