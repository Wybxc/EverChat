# 测试组织

全部命令在仓库根目录使用 pnpm 执行。

| 目录 | 责任 | 命令 |
|---|---|---|
| `unit/<domain>` | 纯规则、解析、状态机、适配契约与存储边界 | `pnpm test` |
| `integration/<domain>` | request、真实本地 DO／Alarm／Workflow／事务 | `pnpm test:e2e tests/integration` |
| `e2e/<domain>` | 浏览器交互、用户路径与跨设备结果 | `pnpm test:e2e tests/e2e` |
| `pwa` | 生产构建、离线导航、公式字体、真实 PDF 资源 | `pnpm test:pwa`（先构建） |
| `support/browser` | 页面交互夹具及生产 PWA 测试服务器 | 被对应套件使用 |
| `support/providers` | 四协议模拟流、消费适配器、模拟上游 | 被单测与本地 Worker 使用 |
| `support/runtime` | 测试 DO、控制路由、故障注入、资源计数 | 通过 Vite 的测试入口装配 |
| `support/assets` | 合成 PDF、固定资源及来源说明 | 被附件与 PWA 场景使用 |

`pnpm check` 依次执行单测、类型检查／构建、integration + e2e、PWA。单测递归发现并排序 `tests/**/*.test.ts`，零匹配失败；用 `pnpm test --list` 检查文件清单。主 Playwright 明确匹配 `e2e/**/*.spec.ts` 和 `integration/**/*.spec.ts`，不包含生产 PWA。

集成与浏览器测试继续串行：多个场景会修改同一 Library 的供应商与工具设置。integration 中 request 场景没有 page/browser 夹具，不启动浏览器。混合浏览器场景的资源限制文件保留在 e2e，避免错分。

## 本次合并与保留映射

原始清单为 316 项单测、286 项主套件场景、3 项 PWA。整理后的清单为 314／285／3。

| 原场景 | 保留位置与断言 |
|---|---|
| core：AI SDK provider preserves UTF-8 deltas from fragmented streams | [protocol-adapter](unit/providers/protocol-adapter.test.ts)：四协议逐字节输入，验证 UTF-8、上游凭证、历史和上限，且只调用一次 |
| core：provider preserves deltas but rejects an incomplete stream without retrying | [protocol-adapter](unit/providers/protocol-adapter.test.ts)：四协议 EOF 拒绝、部分文本保留和不重试 |
| core：valid stream + private diagnostics | 正常结束由 protocol-adapter 保留；401 隐私断言单独保留于 [error-redaction](unit/providers/error-redaction.test.ts) |
| core：事件重放、branchPath | 分别移至 [event-replay](unit/streaming/event-replay.test.ts) 和 [branch-path](unit/conversation/branch-path.test.ts)，不删除 |
| chat：new conversation moves keyboard focus to the composer | [composer-navigation](e2e/chat/composer-navigation.spec.ts)：焦点、同一输入 DOM、发送、切换及草稿恢复 |
| provider 平铺单测 | 拆为 settings、discovery、protocol-adapter、reasoning，全部原场景保留 |
| UI migration／refinement／compact／acceptance 批次 | 按 chat、settings、library、accessibility 分组；保留视口矩阵、200% 文字、长模型名称、键盘焦点、对比度和折叠错误可见性 |
| Alarm／工具日志／生产联网服务请求场景 | 移至 integration；保留真实 workerd、事务、恢复和额度断言 |

API、模型、消息、工具和附件的故障恢复测试均保留。`support/providers/consume-stream.ts` 是消费生产协议流的测试适配器，不作为业务实现发布。
