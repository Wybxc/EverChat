# 测试组织

全部命令在仓库根目录使用 pnpm 执行。

数据库离线运维另有 `pnpm test:operations`：直接运行本地 workerd 的私有服务入口、事务回滚、补丁重试与业务隔离验证。入口位于 `integration/operations/*.native.ts`，不由 Playwright 或纯单测发现器重复执行。

| 目录                   | 责任                                        | 命令                              |
| ---------------------- | ------------------------------------------- | --------------------------------- |
| `unit/<domain>`        | 纯规则、解析、状态机、适配契约与存储边界    | `pnpm test`                       |
| `integration/<domain>` | request、真实本地 DO／Alarm／Workflow／事务 | `pnpm test:e2e tests/integration` |
| `e2e/<domain>`         | 浏览器交互、用户路径与跨设备结果            | `pnpm test:e2e tests/e2e`         |
| `pwa`                  | 生产构建、离线导航、公式字体、真实 PDF 资源 | `pnpm test:pwa`（先构建）         |
| `support/browser`      | 页面交互夹具及生产 PWA 测试服务器           | 被对应套件使用                    |
| `support/providers`    | 四协议模拟流、消费适配器、模拟上游          | 被单测与本地 Worker 使用          |
| `support/runtime`      | 测试 DO、控制路由、故障注入、资源计数       | 通过 Vite 的测试入口装配          |
| `support/assets`       | 合成 PDF、固定资源及来源说明                | 被附件与 PWA 场景使用             |

`pnpm check` 依次执行单测、本地运维原生集成测试、类型检查／构建、integration + e2e、PWA。单测递归发现并排序 `tests/**/*.test.ts`，零匹配失败；用 `pnpm test --list` 检查文件清单。主 Playwright 明确匹配 `e2e/**/*.spec.ts` 和 `integration/**/*.spec.ts`，不包含生产 PWA。

集成与浏览器测试继续串行：多个场景会修改同一 Library 的供应商与工具设置。integration 中 request 场景没有 page/browser 夹具，不启动浏览器。混合浏览器场景的资源限制文件保留在 e2e，避免错分。

## CI

[Tests 工作流](../.github/workflows/tests.yml) 在面向 `main` 的 PR 创建／更新、`main` 推送及手动触发时运行。格式、类型、单测和原生运维测试组成必需作业 `Required tests`，任一步失败都阻止合并。工作流不使用路径过滤，以免必需检查一直等待；连续更新同一 PR 时取消旧提交的检查。

[Browser regression 工作流](../.github/workflows/browser-tests.yml) 手动触发，选择要验证的分支及 `chromium`、`webkit`、`pwa` 或 `all`。完整 Chromium 主套件在 Ubuntu 运行，WebKit 阅读／导航／搜索回归在 macOS 运行，生产 PWA 在 Ubuntu 按现有配置覆盖 Chromium 全部场景及适用的 WebKit 场景；不将依赖 CDP 的主套件强行运行在 WebKit 上。失败报告与 trace 在 Actions 的 artifacts 中保留 7 天。浏览器回归独立报告，当前不作为自动合并门槛；涉及相关功能的修改仍应在合并前运行对应场景。

本地开发继续按改动选择测试；不需要等到生产构建才发现测试失败。环境与发布顺序见[开发指南](../docs/development.md#测试与发布时机)。

## WebKit 与惰性图表渲染

Markdown／搜索回归可直接选择 WebKit，无需另建配置文件：

```sh
pnpm test:e2e --browser=webkit tests/e2e/chat/reading-layout.spec.ts tests/e2e/chat/search.spec.ts
```

Streamdown 通过可视区域观察延迟渲染 Mermaid。测试应先将稳定的 `[data-streamdown="mermaid-block"]` 外层容器滚入视口，再等待内部 SVG；直接等待或滚动尚未创建的 `[data-streamdown="mermaid"]` 会形成等待死结。模块失败后的重新加载、离线恢复同样遵循此顺序，保留真实 SVG、代码高亮、搜索、草稿与焦点断言，不使用固定等待或强制渲染来绕过惰性加载。

浏览器筛选只适用于支持对应浏览器的场景；依赖 Chromium CDP 的触摸模拟不能直接用于 WebKit。

## 供应商响应与同步流大小

`e2e/platform/relaxed-limits.spec.ts` 的大响应场景使用与模拟供应商共用的 `support/providers/large-stream.ts`，校验真实夹具超过 4 MiB，并在全部心跳之后返回长正文与思考。重新引入响应总量上限会使末尾内容无法完成，编辑及备份恢复断言也仍保留。

`durableOffset` 统计编码后的 EverChat 应用事件字节，不是供应商原始 SSE 响应大小。AI SDK 会过滤心跳和协议封装，因此该测试分别检查原始响应大小、内容完整性及同步偏移，不用原始响应大小作为同步偏移的下限。

## 本次合并与保留映射

原始清单为 316 项单测、286 项主套件场景、3 项 PWA。整理后的清单为 314／285／3。

| 原场景                                                                            | 保留位置与断言                                                                                                                |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| core：AI SDK provider preserves UTF-8 deltas from fragmented streams              | [protocol-adapter](unit/providers/protocol-adapter.test.ts)：四协议逐字节输入，验证 UTF-8、上游凭证、历史和上限，且只调用一次 |
| core：provider preserves deltas but rejects an incomplete stream without retrying | [protocol-adapter](unit/providers/protocol-adapter.test.ts)：四协议 EOF 拒绝、部分文本保留和不重试                            |
| core：valid stream + private diagnostics                                          | 正常结束由 protocol-adapter 保留；401 隐私断言单独保留于 [error-redaction](unit/providers/error-redaction.test.ts)            |
| core：事件重放、branchPath                                                        | 分别移至 [event-replay](unit/streaming/event-replay.test.ts) 和 [branch-path](unit/conversation/branch-path.test.ts)，不删除  |
| chat：new conversation moves keyboard focus to the composer                       | [composer-navigation](e2e/chat/composer-navigation.spec.ts)：焦点、同一输入 DOM、发送、切换及草稿恢复                         |
| provider 平铺单测                                                                 | 拆为 settings、discovery、protocol-adapter、reasoning，全部原场景保留                                                         |
| UI migration／refinement／compact／acceptance 批次                                | 按 chat、settings、library、accessibility 分组；保留视口矩阵、200% 文字、长模型名称、键盘焦点、对比度和折叠错误可见性         |
| Alarm／工具日志／生产联网服务请求场景                                             | 移至 integration；保留真实 workerd、事务、恢复和额度断言                                                                      |

API、模型、消息、工具和附件的故障恢复测试均保留。`support/providers/consume-stream.ts` 是消费生产协议流的测试适配器，不作为业务实现发布。

## Access 身份夹具

`pnpm test:e2e` 的 Node/Vite 辅助工具每次生成临时 RS256 私钥，`POST /__dev/access/login` 将签名身份放入 HttpOnly Cookie；浏览器和 request 夹具共用该入口。测试 Worker 只接收公钥，并复用生产 JWT 校验。端口、Origin 与 loopback 均受限制，生产构建没有此入口。

`unit/platform/access.test.ts` 验证签名、声明、固定信任源、错误身份、服务身份、依赖故障、重定向及订阅租期；`e2e/platform/access.spec.ts` 验证缓存不能恢复失效的联网认证、URL／草稿恢复和离线跨标签页退出。PWA 测试使用合成 Session DTO，不能替代真实 Access 边缘验证。

验证入口／SW 结构升级时，可在修改前以 `EVERCHAT_BUILD_ID=pwa-test-a pnpm exec vite build` 构建并将 `dist/client` 复制到临时目录，再用 `EVERCHAT_PWA_LEGACY_BUILD=<临时目录> pnpm test:pwa tests/pwa/sharing.spec.ts tests/pwa/lifecycle.spec.ts` 验证该真实旧构建升级到当前版本。旧 HTML 的识别仅存在于测试服务器，不加入线上兼容逻辑；普通 PWA 回归仍构建当前源码的 A／B 两个版本。

远端测量使用隔离 Access 应用的 Service Auth 凭据，详情见[迁移方案](../docs/plans/cloudflare-access-migration-plan.md)。不再配置应用密码。
