# Cloudflare 生产部署与用量告警

更新日期：2026-10-19。以下为已保存并验证的实际配置；费用以账户账单和 Cloudflare 当前规则为准。

2026-10-20 配置整理：仓库 `wrangler.jsonc` 不再包含本部署的域名、AUD、团队域名或允许邮箱。已有参数保留在生产 Worker 的变量中，`keep_vars: true` 防止后续发布清除；自定义域名由控制台管理。Worker、DO、Workflow、R2 的名称和绑定保持不变，自动构建命令无需调整。下文的个人站点信息为本次部署记录，不是其他部署者的默认配置。

## 生产资源

| 项目             | 当前配置                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 网站             | <https://chat.wybxc.cc>                                                                                                                      |
| 私有 GitHub 仓库 | <https://github.com/Wybxc/EverChat>                                                                                                          |
| Worker           | `everchat`                                                                                                                                   |
| Workers 套餐     | Workers Free                                                                                                                                 |
| Access 套餐      | Teams Free                                                                                                                                   |
| Access 应用      | EverChat，保护 `/api`、`/api/*`、`/auth`、`/auth/*`，仅允许配置的所有者邮箱；前端与 SW 公开                                                  |
| Durable Objects  | `CONVERSATIONS` → `everchat_Conversation`；`LIBRARY` → `everchat_Library`；`USAGE` → `everchat_UsageStore`；`SHARES` → `everchat_ShareStore` |
| Workflow         | `WEB_TOOLS` → `everchat-web-tools`                                                                                                           |
| 私有 R2          | `ATTACHMENTS` → `everchat-attachments`，Standard 存储                                                                                        |
| 备用公开入口     | `workers_dev: false`、`preview_urls: false`                                                                                                  |

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

## 初次上线验证（2026-10-16）

涉及数据库格式变更时，先按[离线运维迁移](offline-storage-migration.md)完成维护窗口内的备份、本地转换、导入和校验，再发布业务代码。对象启动不承担迁移；不能直接推送新格式要求的代码后等待用户访问触发转换。

- 未登录请求首页、对话深链接、静态资源和认证恢复入口进入 Access；AJAX 会话请求返回 401。
- 伪造旧应用 Cookie／邮箱头未获得访问；用户完成真实 Access 登录后会话初始化成功。
- 用户授权的纯测试文件已上传到验证对话，WebSocket 同步确认、私有文本预览、原生下载均成功；下载与原文 SHA-256 相同。
- 验证对话保留在 <https://chat.wybxc.cc/c/b669e6b2-912b-4158-980a-9a97f9459875>，未发起付费模型请求。
- 本地 321 项单元测试、最终 29 项相关端到端回归、3 项生产 PWA 回归，以及类型检查、构建、格式检查通过。详细边界和未执行的真实撤销／性能测量见[Access 迁移记录](../plans/cloudflare-access-migration-plan.md)。

## 费用统计与同域分享发布（2026-10-19）

存量 65 个对象已通过维护窗口内的离线 schema 2 升级与逐行验证，保留 282 条消息；恢复后全量读取和私有 API 验收通过。生产增加 UsageStore／ShareStore 绑定及 `SHARE_LINK_KEY` Secret，密钥未进入静态包或 Git。提交 `41e078a` 的 Workers Builds 已成功，自动部署版本为 `b7832078-491d-4bbd-8bfa-3d77043ba853`。

Access 已由所有者保存为同一个应用的四个 Public hostname 路径：`/api`、`/api/*`、`/auth`、`/auth/*`，沿用原 Allow 身份、AUD 和会话设置。前端／SW／分享页面公开，公开数据读取仍逐次验证随机令牌、状态与有效期。此配置不用 Bypass，私有后端未改为 Everyone 放行。

生产匿名验证：静态入口与有效分享成功，私有 API／认证恢复仍进入登录；错误令牌与跨站请求被拒绝，轮换旧令牌和撤销后的 GET／HEAD／分页均为 404。实际旧 SW 浏览器更新后分享正常，撤销并刷新显示“链接不可用”。旧版已安装 PWA 需先检查并更新应用一次。

验收与资源测量边界见[执行记录](../measurements/usage-sharing-implementation-2026-10-19.md)，回滚时可先恢复整站 Access 保护；数据库格式回滚仍须执行本地反向补丁，不能只回滚代码。

## 回答完成通知

2026-10-18：生产 Worker 已配置 `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY` 和 `VAPID_SUBJECT` 三个 Secrets，subject 为所有者联系邮箱。私钥由本机生成，仅通过 Wrangler Secret API 上传，不在 Git、前端包、备份或日志中出现。`GET /api/notifications/config` 经过 Access 身份校验，只返回公钥；未配置完整密钥时明确退回页面在线通知。

新部署环境需要先生成 P-256 密钥对，将未压缩 65 字节公钥和 32 字节私钥分别编码为 base64url，连同 `mailto:` 联系地址写入仓库外、权限 `0600` 的临时 JSON 文件，再执行 `pnpm exec wrangler secret bulk <临时文件> --name everchat`。不要打印私钥或将临时文件加入版本控制。轮换 VAPID 后，客户端重新检查通知时会更新订阅；之前的订阅不能使用新密钥发送。

用户在「设置 → 通用 → 回答通知」主动启用后才申请权限、登记当前安装实例。看到「页面通知可用」只表示在线路径；「后台推送已就绪」表示订阅登记完成，仍需真机验证系统实际显示。iOS 需从主屏幕 PWA 启用。测试按钮只检查当前根 SW 的系统通知显示，不能替代锁屏／关闭后的远程投递验证。

新增投递状态只保留完成 ID、回答 ID、完成时间、期限和重试信息，不保存回答内容；投递及去重到期为 1 小时。复用 Conversation／Library 的 Alarm，未新建通知 Workflow、Cron、R2 对象或应用每日配额。队列索引、批量上限及有限退避用于控制单次运行压力，实际平台 CPU 与用量仍需实测，不能以本地测试或订阅成功推断免费层消耗。

退出时先登记停用，清除本地偏好并尽力取消 Push 订阅；网络和注销等候均有期限，离线时不阻塞退出。已交给系统的通知仍可能到达。网关 404／410 清除失效订阅，认证类失败停止盲目重试；429／服务端故障在期限内退避，不能通过反复重新生成回答来重试通知。通知投递问题不改变已保存回答的成功状态。

平台验证发现 Workers 不接受请求的 `redirect: 'error'`；通知发送使用 `manual`，不得改成自动跟随重定向。隔离加密测量与真实设备验收的范围、复测和清理方式见[通知平台记录](../measurements/notifications-cloudflare-2026-10-18.md)。

排查时先区分订阅保存与远程投递：`INVALID_NOTIFICATION_DEVICE` 返回失败字段路径，不包含订阅实际值；请勿要求用户复制完整订阅。投递日志 `EverChat notification delivery` 只记录完成／匿名安装 ID、尝试次数、状态、结果和耗时，异常只保留类型。`accepted` 表示推送网关接受，不能用来断言设备显示或用户已读。
