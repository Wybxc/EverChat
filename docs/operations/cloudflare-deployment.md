# Cloudflare 生产部署与用量告警

记录日期：2026-10-16。以下为已保存的实际控制台配置；费用以账户账单和 Cloudflare 当前规则为准。

## 生产资源

| 项目             | 当前配置                                                                  |
| ---------------- | ------------------------------------------------------------------------- |
| 网站             | <https://chat.wybxc.cc>                                                   |
| 私有 GitHub 仓库 | <https://github.com/Wybxc/EverChat>                                       |
| Worker           | `everchat`                                                                |
| Workers 套餐     | Workers Free                                                              |
| Access 套餐      | Teams Free                                                                |
| Access 应用      | EverChat，覆盖整个正式域名，仅允许配置的所有者邮箱                        |
| Durable Objects  | `CONVERSATIONS` → `everchat_Conversation`；`LIBRARY` → `everchat_Library` |
| Workflow         | `WEB_TOOLS` → `everchat-web-tools`                                        |
| 私有 R2          | `ATTACHMENTS` → `everchat-attachments`，Standard 存储                     |
| 备用公开入口     | `workers_dev: false`、`preview_urls: false`                               |

原 `chat` CNAME 指向已下线的 Tunnel；经用户授权已切换到 Worker Custom Domain。Access 在域名切换前已启用。R2 不开放公共桶或 `r2.dev`，附件由受保护的 Worker 路由读取。

生产空间首次启动为空；模型供应商由用户在网页配置。开发密钥、`.dev.vars`、本地数据、临时签名夹具和测试接口没有上传到 GitHub 或生产 Worker。

## GitHub 自动部署

Cloudflare Workers Builds 已连接上述私有仓库，生产分支为 `main`。推送提交后由 Cloudflare 拉取、安装依赖、测试、构建并部署。

| 配置       | 值                                              |
| ---------- | ----------------------------------------------- |
| 项目根目录 | `/`                                             |
| Node.js    | `NODE_VERSION=24.18.0`                          |
| pnpm       | `PNPM_VERSION=12.6.0`，与 `packageManager` 一致 |
| 构建命令   | `pnpm test && pnpm build`                       |
| 部署命令   | `pnpm exec wrangler deploy`                     |
| 部署凭据   | Cloudflare 保存的专用 `EverChat build token`    |
| 构建缓存   | 关闭                                            |

`pnpm build` 包含类型检查；单元测试或构建失败时不会执行部署。浏览器端到端、PWA 和资源测量仍在本地运行，不在每次云端构建中重复执行。生产数据保存在 DO／R2，常规代码部署不清空它们。

构建令牌权限已单独获得用户确认，采用控制台默认部署权限，包含账户级 Workers／R2 等资源编辑与区域 Workers 路由编辑；它不是只读令牌，也不限于一个 Worker。令牌仅交给 Cloudflare Builds，不写入 Git、构建变量明文或浏览器应用。修改／撤销令牌可在 Cloudflare API 令牌管理中完成，撤销会使后续自动部署失败。

查看结果：Workers 和 Pages → `everchat` → 部署。失败先检查依赖安装、测试／类型检查和 Wrangler 日志；保留域名 Access 保护，不能通过放宽认证解决构建问题。[Git 集成](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/)、[构建镜像与版本变量](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)。

## 平台原生告警

按用户要求，不新增应用内月度费用限额。账户已保持 Workers Free 与 Teams Free；R2 账户订阅为按量计费，包含免费额度，保留现有附件功能。

已在 Cloudflare Notifications 启用以下邮件告警，R2 告警收件人为 `wybxc@qq.com`。现有账户账单预算告警也保持启用。

| 告警                         | 阈值                       | 范围                 |
| ---------------------------- | -------------------------- | -------------------- |
| `R2 storage — 80% free tier` | 8,000,000,000 字节（8 GB） | 账户 R2 存储量       |
| `R2 Class A — 80% free tier` | 800,000 次                 | 账户 R2 Class A 操作 |
| `R2 Class B — 80% free tier` | 8,000,000 次               | 账户 R2 Class B 操作 |
| 账单预算警报（原有）         | US$0.01                    | 账户全部按量计费支出 |

R2 Standard 每月免费包含 10 GB-month 存储、100 万次 Class A 和 1,000 万次 Class B。操作阈值取免费量的 80%；存储告警使用控制台提供的字节指标，8 GB 是提前提醒，不能直接等同于账单的 GB-month。告警覆盖账户其他桶的用量，共享免费额度，不只统计 EverChat。[R2 定价](https://developers.cloudflare.com/r2/pricing/)。

这些是 Cloudflare 原生通知，不是应用逻辑，也不是硬停开关。账单告警在支出越过阈值后发邮件，不会暂停服务；通知与用量汇总也不能视为实时扣费拦截。R2 没有已配置的免费量超额自动停止机制，不能承诺账户零费用。[预算告警语义](https://developers.cloudflare.com/billing/manage/budget-alerts/)。

收到用量预警后，在 Billing → Billable Usage 和 R2 指标中确认来源；如果持续接近免费量，再人工暂停产生用量的操作或调整部署。不要直接删除桶、对话或撤销 Access 来代替费用处理。没有创建额外的外部定时监控、应用计费开关或付费计划。

Workers Free、Durable Objects Free 和 Workflows Free 的免费用量边界按平台规则拒绝后续操作，而不是自动升级 Workers Paid；账户其他付费订阅仍须分别核对。[Workers](https://developers.cloudflare.com/workers/platform/pricing/)、[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[Workflows](https://developers.cloudflare.com/workflows/reference/pricing/)。

## 上线验证

- 未登录请求首页、对话深链接、静态资源和认证恢复入口进入 Access；AJAX 会话请求返回 401。
- 伪造旧应用 Cookie／邮箱头未获得访问；用户完成真实 Access 登录后会话初始化成功。
- 用户授权的纯测试文件已上传到验证对话，WebSocket 同步确认、私有文本预览、原生下载均成功；下载与原文 SHA-256 相同。
- 验证对话保留在 <https://chat.wybxc.cc/c/b669e6b2-912b-4158-980a-9a97f9459875>，未发起付费模型请求。
- 本地 321 项单元测试、最终 29 项相关端到端回归、3 项生产 PWA 回归，以及类型检查、构建、格式检查通过。详细边界和未执行的真实撤销／性能测量见[Access 迁移记录](../plans/cloudflare-access-migration-plan.md)。
