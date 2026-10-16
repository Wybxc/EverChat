# 模块与运行环境

本项目保留一个 pnpm 包。模块按功能归属，运行环境由目录及类型检查明确区分。

| 位置                   | 职责                                                 | 依赖方向                                                    |
| ---------------------- | ---------------------------------------------------- | ----------------------------------------------------------- |
| `src/app`              | 登录、路由、页面与设置装配                           | 客户端功能、平台组件、shared                                |
| `src/features`         | 聊天、供应商、附件、备份、侧栏、预设、联网界面及状态 | 自己的规则、明确的跨功能契约、platform、shared              |
| `src/platform`         | HTTP、通用存储、自动保存、主题、浏览器能力           | 浏览器／第三方库；不认识聊天数据库                          |
| `worker/http`          | API 装配、鉴权、来源检查、错误映射                   | 各业务的 `routes.ts`                                        |
| `worker/conversation`  | Conversation DO 的事务、任务生命周期、Alarm 协调     | 消息存储、订阅、生成、搜索、工具任务                        |
| `worker/library`       | Library DO 的对话索引、RPC 与维护调度                | 供应商存储、附件、预设、备份任务、搜索                      |
| `shared`               | 业务契约及可跨环境复用的纯规则                       | 标准 Web API；不依赖 src、worker、Node、React 或 Cloudflare |
| `shared/auth`          | Access 身份／会话契约、同源返回路径规则              | 标准 Web API                                                |
| `scripts/dev`          | Node 临时签名与独立本地 Worker 入口                  | jose、Vite、生产验证器；生产入口不依赖它                    |
| `scripts/models`       | 更新模型元数据快照                                   | Node、模型目录规则                                          |
| `scripts/measurements` | 本地／隔离 Cloudflare 验证与测量                     | 测量支持及测试运行时                                        |

各业务直接导入明确文件。`types.ts`／`protocol.ts` 只放契约；算法、校验和协议应用分别命名，不建立全局重导出入口。shadcn 的 `src/components/ui`、`src/lib/utils.ts` 与根配置沿用工具约定。

## 状态与原子性

- `useChatDraft` 持有编辑草稿，`useOutbox` 持有待发送请求与投递锁。`useLibraryIndex` 持有索引查询与本地合并，`useChatAttachments` 管理准备／上传／解析和取消。App 协调导航、当前分支、发送与界面操作。请求身份、父消息和导航版本仍在入队时固定。
- `platform/storage` 持有唯一的 IndexedDB／内存／localStorage 缓存和退出 epoch；`features/chat/cache` 管理聊天墓碑、快照键与延迟写入检查，不复制缓存。
- `SettingsPanel` 持有唯一的 `SettingsAutosave`，其生命周期独立于弹窗内容；切换 Tab、关闭再打开窗口不会重建保存实例。供应商编辑器与模型选项接受同一个实例，身份变化时仍按原有 epoch 和退出规则失效。
- `AppFrame` 复用身份确认前后的页面布局；私密内容仍等待身份验证与缓存归属检查。设置 Tab 和本地主题不依赖供应商查询，远程表单分别管理读取与重试。静态启动占位与 React 启动框架覆盖脚本和本地存储初始化期间的等待。
- `ConversationMessages` 在所属 DO 的已有事务中执行，不自行打开事务、发送 RPC 或调度 Alarm。消息、事件、搜索 outbox 与流日志的原子关系保留。
- 订阅模块只负责同一 DO 的 WebSocket 背压、会话到期和确认；DO 决定删除、握手、重放及何时广播。流读取模块保留读取间的取消与持久化屏障；DO 持有 active generation、提交、结束和 Alarm。
- `ProviderSettingsStore` 和 `ArchiveRestorer` 使用 Library 原有的存储与功能实例。恢复步骤、清理与维护通过同一 DO 协调，未新增数据库、序列化层或跨 DO 请求。

DO 中仍保留提交、修订、完成、取消、工具轮次及恢复的事务编排；将这些事务按行数拆散会削弱一致性。应只在出现新的独立职责时继续抽取。

## 检查入口

`pnpm typecheck` 分别检查客户端、Worker、Node 工具、标准 Web Worker shared，以及客户端单测、Node 单测、Cloudflare 夹具、浏览器测试。平台验证 Worker 从 Node 工具检查中排除，进入 Cloudflare 运行时检查。

测试结构、发现规则和合并记录见 [测试说明](../../tests/README.md)。本次迁移的范围与验证记录见 [模块整理计划](../plans/project-organization-plan.md)。

Access 验证由 HTTP 装配层集中执行，业务路由读取已验证身份；供应商存储只提供设置。`src/platform/auth` 持有当前联网授权及中断信号，离线缓存不授予联网权限。生产 `worker/index.ts` 与本地 `scripts/dev/worker.ts` 分离；平台测量入口另行显式允许指定的 Access 服务身份。
