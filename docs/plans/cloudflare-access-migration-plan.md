# Cloudflare Access 访问控制迁移方案

日期：2026-10-16。状态：代码迁移、正式部署和上线基本验证完成；扩展的真实撤销及故障测量另行记录。基于当前源码及当日 Cloudflare 官方文档。

## 1. 目标与迁移方式

将「EverChat 校验共享密码、签发 Cookie」替换为「Cloudflare Access 登录与策略控制、Worker 校验 Access JWT」。保持个人空间、SPA 对话 URL、离线阅读、待发送队列和后台生成的现有行为。

原型阶段直接切换：删除密码登录和旧 Cookie 协议，不增加双认证模式、密码兜底或旧会话转换。云端对话、供应商配置、附件及已接受的生成任务不需要重建。Access 身份用于访问控制，本次不把 `personal` 空间改成多租户系统；所有获准身份都能访问同一个空间。

完成后的职责如下：

| 层级              | 职责                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| Cloudflare Access | 登录页面、身份提供商、允许访问的身份、会话与撤销策略；保护整个应用域名 |
| Worker HTTP 入口  | 校验 JWT 签名和声明、限制身份及请求来源；输出统一的鉴权错误            |
| Conversation DO   | 接收已经验证的订阅有效期；在连接需要重新鉴权时停止推送                 |
| 客户端            | 获取初始化数据、区分离线与登录失效、引导重新登录、清除本地记录         |

## 2. 接入形式与平台限制

采用按域名配置的 self-hosted Access 应用，覆盖页面、静态资源、`/api/*` 和 WebSocket 握手，不只保护 API 路径。允许策略限定到自己的邮箱或明确的 IdP 身份，不设置公开 Bypass。

当前 Worker 级 Access 策略不支持 WebSocket；另外，Workers Static Assets 的内部路由不会向应用 Worker 传递 `ctx.access`。因此，本项目选择域名级保护，并在 Worker 中验证 `Cf-Access-Jwt-Assertion`，不采用 Worker 级策略或依赖 `ctx.access` 的模板。[平台限制](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)

所有实际存在的入口必须列入部署清单：正式域名、`workers.dev`、版本／预览 URL 和开发隧道。生产优先保留一个正式域名，其余入口关闭；必须保留的入口分别配置 Access，验证实际策略覆盖。`workers_dev: false` 与 `preview_urls: false` 分别显式设置，不能只关闭前者。当前包含 DO 的 Worker 按平台限制不生成 Version URL，仍需核对其他部署及预览入口的实际状态。[workers.dev 配置](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)、[Version URL 配置与限制](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/)

## 3. 删除清单

| 位置                                                                                                                       | 删除内容                                                                             | 替代归属                                         |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------ |
| [worker/http/auth.ts](../../worker/http/auth.ts)                                                                           | `passwordMatches`、HMAC 签名／校验、`everchat_session`、30 天 TTL、Cookie 创建与清理 | Access JWT 验证器，见第 5 节                     |
| [worker/http/session-routes.ts](../../worker/http/session-routes.ts)                                                       | `POST /api/login`、`POST /api/logout`、密码 schema、密码配置检查                     | Access 登录／退出；保留并重写 `GET /api/session` |
| [worker/library/durable-object.ts](../../worker/library/durable-object.ts)                                                 | `login_attempts` 建表、`allowLogin`、`clearLogin`                                    | Access 的登录保护；Library 不再管理认证状态      |
| [worker/http/env.ts](../../worker/http/env.ts)、[.dev.vars.example](../../.dev.vars.example)及部署 Secrets                 | `APP_PASSWORD`、`SESSION_SECRET`                                                     | Access 配置，见第 5 节                           |
| [src/app/Login.tsx](../../src/app/Login.tsx)                                                                               | 密码表单、提交逻辑、密码错误及未设置密码的提示                                       | 简单的重新登录／拒绝访问／网络异常界面           |
| [shared/providers/types.ts](../../shared/providers/types.ts)、[worker/providers/store.ts](../../worker/providers/store.ts) | `configured` 密码配置标记、供应商模块生成认证状态的职责                              | 独立的会话契约及 HTTP 初始化接口                 |
| [worker/conversation/routes.ts](../../worker/conversation/routes.ts)                                                       | 从旧 Cookie 用正则提取 WebSocket 有效期                                              | 从已经验证的 JWT 获取 `exp`                      |
| [worker/conversation/durable-object.ts](../../worker/conversation/durable-object.ts)                                       | 无调用方的 `closeSessions()`，核对引用后删除                                         | 标准连接过期／重新鉴权机制                       |
| 测试、测量脚本、当前部署说明                                                                                               | 输入本地密码、调用 `/api/login`、构造旧 Cookie 的路径                                | 本地签名夹具及隔离环境 Access 凭据               |

移除登录限流表不意味着清空 Library。已有数据库中的废弃表可以单独清理，不能通过删除整个 DO 数据库代替。供应商密钥、模型调用凭据、资源配额、业务限流及工具预算都保留。

## 4. 替换与保留清单

| 位置                                                                                                                                                             | 修改方式                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [worker/http/app.ts](../../worker/http/app.ts)、[worker/http/access.ts](../../worker/http/access.ts)、[worker/http/response.ts](../../worker/http/response.ts)   | 集中装配鉴权中间件，保存已验证的请求身份；业务路由读取该身份，避免重复验签；错误响应保留错误码 |
| [worker/index.ts](../../worker/index.ts)、[wrangler.jsonc](../../wrangler.jsonc)                                                                                 | 增加联网重新认证入口 `/auth/resume`，与 API 一起先进入 Worker；生产入口只接受真实 Access 配置  |
| [worker/providers/store.ts](../../worker/providers/store.ts)、Library 的 `sessionResponse()`                                                                     | 返回供应商与应用初始化设置，不再判断登录；HTTP 层组合公开身份与设置                            |
| [src/app/useSession.ts](../../src/app/useSession.ts)、[src/app/App.tsx](../../src/app/App.tsx)                                                                   | 统一会话状态、重新认证、离线恢复与退出顺序，替换密码页入口                                     |
| [src/platform/api.ts](../../src/platform/api.ts)及直接上传／下载通道                                                                                             | 统一 Access 失效识别；所有同源程序化 API 请求携带 AJAX 标记                                    |
| [src/features/chat/useConversation.ts](../../src/features/chat/useConversation.ts)、DO、[worker/streaming/subscribers.ts](../../worker/streaming/subscribers.ts) | 连接使用 Access 有效期及短期订阅租期；区分重新校验、会话失效与普通断线                         |
| [src/features/chat/useOutbox.ts](../../src/features/chat/useOutbox.ts)、[src/features/chat/cache.ts](../../src/features/chat/cache.ts)                           | 只有当前联网身份确认后才投递；鉴权中断保留请求 ID 和草稿                                       |
| [src/platform/storage.ts](../../src/platform/storage.ts)                                                                                                         | 本地清理可等待完成；保留 epoch 防止迟到写入恢复已清除记录                                      |
| [vite.config.ts](../../vite.config.ts)                                                                                                                           | Service Worker 不接管认证路径；区分日常本地开发、测试和真实 Access 联调入口                    |

继续保留：同源写入与 WebSocket `Origin` 校验、参数校验、附件大小限制、私有 R2、API `no-store`、密钥脱敏与禁止离线缓存、请求幂等、流式回放与背压、DO Alarm 和有限工具 Workflow。Access 身份认证不替代这些机制。

## 5. Worker 验证与会话契约

### 5.1 验证器

在 `worker/http/auth.ts` 中整体替换现有实现，使用直接依赖 `jose` 的 `jwtVerify` 和 `createRemoteJWKSet`，不自行实现 JWT 密码学。官方示例也采用这一组合。[JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

- 固定可信团队域名、应用 AUD、正式应用 Origin 和允许访问的邮箱。生产建议变量为 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`APP_ORIGIN`、`ACCESS_ALLOWED_EMAILS`。
- 对进入应用 Worker 的请求核对固定的应用 Origin，拒绝未列入配置的入口；写入与 WebSocket 再检查浏览器 `Origin`，不把请求自己的域名自动当成可信配置。
- 根据配置生成 HTTPS issuer 和 JWKS 地址；不根据请求参数、JWT 的 `jku` 或未验证的 `iss` 动态选择信任源。
- 验证签名、允许的签名算法、issuer、audience、必需的 `exp` 和时间声明；用户令牌还要求有效的 `sub` 和获准邮箱。
- 不将邮箱请求头、Cookie 是否存在、JWT 解码结果或前端缓存视为认证证明。不签发第二套 EverChat 长期登录 Cookie。
- 同一个请求只验证一次，结果存入 Hono 类型化上下文。按可信配置复用 JWKS 缓存，处理密钥轮换及并发回源。
- 缺少生产配置时返回服务配置错误；JWKS 故障时拒绝无法验证的请求，不降级放行。未过期的已缓存公钥仍可按验证器规则使用。
- 不在日志、响应、URL、DO 或业务存储中保存 JWT、Access Cookie 或服务凭据。

### 5.2 API 与错误

`GET /api/session` 仍是客户端初始化入口，但只在认证成功时返回应用设置及最少身份字段，例如 `{ sub, email }`。共享契约放入 `shared/auth/types.ts`；供应商模块继续拥有自己的设置类型。保留一个 HTTP 层负责组合的响应，不额外增加每次启动的身份网络请求。

| 情况                            | HTTP／客户端语义                                     |
| ------------------------------- | ---------------------------------------------------- |
| 缺少、无效或过期 JWT            | `401`，Worker 响应带 `AUTH_REQUIRED`                 |
| JWT 有效但身份不获准            | `403`，带 `ACCESS_DENIED`                            |
| 配置或验证依赖不可用            | `503`，可重试，不能解释为已登录                      |
| Origin、文件、业务权限等拒绝    | 保留业务状态与错误码，不统一当成登录失效             |
| Access 在边缘返回的非 JSON 错误 | 保留真实 HTTP 状态；先判断状态，再按内容类型解析响应 |

向所有同源 API fetch／XHR 添加 `X-Requested-With: XMLHttpRequest`，使 Access 在子请求会话过期时返回 `401`，减少跳转至登录页造成的跨域或 JSON 解析错误。[AJAX 会话处理](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)

覆盖 `api()`、附件上传、备份导入 XHR 和 [archive-worker.ts](../../src/features/backup/archive-worker.ts) 的下载 fetch。浏览器原生导航、图片与下载链接不能统一加这个头，需要单独验证会话失效行为。对 models.dev 和 PDF 字体等第三方请求不添加 Access 标记或凭据。

## 6. SPA、PWA 与重新登录

首次在线访问由 Access 展示登录页，登录后进入原始 `/` 或 `/c/:id`。客户端不提供账号、密码、验证码输入框。

会话失效后的恢复流程：

1. 暂停 WebSocket 重连、outbox、自动保存和上传等联网操作，保存现有草稿。各请求共享一次会话复核，避免并发触发登录。
2. 必要时显示「重新登录」操作。通过顶层导航进入同源 `/auth/resume?returnTo=...`，由 Access 执行真实联网认证。
3. Worker 验证后跳回原始应用路径，重新获取 `/api/session`，确认身份后恢复联网操作。拒绝访问时停在明确的错误状态，避免跳转循环。

`returnTo` 只允许应用内的同源相对路径，拒绝协议相对 URL、外部 Origin 和返回认证入口的循环；不携带令牌、密钥或草稿正文。

必须增加 `run_worker_first` 的 `/auth/*`，并将 `/auth/`、`/cdn-cgi/access/` 加入 Service Worker 导航回退排除规则，保留现有 `/api/` 排除。普通刷新可能被已安装的 Service Worker 用缓存页面满足，不能依靠刷新一定触发 Access 登录。认证入口和登录响应不得缓存。

客户端会话至少区分 `loading`、`authenticated`、`offline`、`reauth-required`、`denied`、`unavailable`。修正当前 `useSession.boot()` 的 catch-all 缓存恢复：

- 明确 `401`／身份拒绝时不能从缓存恢复「联网已认证」。
- 网络不可用且有缓存时可以继续阅读、编辑草稿和排队，但不能据此授权云端请求。
- 恢复网络后先确认当前身份，再开启投递、同步和自动保存。网络错误不能自动等同于退出或无休止登录跳转。
- 以 issuer 与 subject 标识本地记录所属身份，防止换账号后自动投递另一个身份的队列。旧 `authenticated` 缓存不做认证兼容转换，也不自动认领无身份归属的队列。

Access 无法远程收回已经下载到设备的离线正文。共享设备继续依靠「退出并清除本地记录」，本次不引入本地加密或取消 PWA 离线功能。

## 7. WebSocket 与后台生成

浏览器 WebSocket 握手继续使用同源 Cookie，URL 不带 JWT。Worker 先验证 Access，再检查 Origin 和对话存在性，最后向 DO 转交可信的连接元数据。

删除旧 Cookie 正则。覆盖请求中可能伪造的 `X-Session-*`，只使用已验证的 `exp`；DO 在 `acceptWebSocket` 和首次回放之前检查有效期，拒绝缺失、非有限数值及过期数据。

已经建立的 WebSocket 不会为每个数据帧重新经过 Access，单纯离线验签也不查询撤销状态。为限制陈旧授权持续推送，首版采用以下设计参数：

- 保存 JWT 到期时间和 `min(JWT 到期时间, 当前时间 + 5 分钟)` 的订阅租期。
- 每次发送业务内容和处理入站消息前检查；保留现有 20 秒客户端心跳。租期结束时停止业务推送，关闭并重新握手。
- 使用独立关闭码区分「需要重新校验租期」（建议 `4004`）与「令牌过期」（现有 `4001`）。租期重连正常完成时不打断输入或显示登录页。
- 浏览器无法读取握手拒绝的完整响应；连接异常后以退避、合并的 HTTP 会话复核区分登录失效、服务故障和普通断网。不能无限尝试失效握手。
- 保留流式游标、增量回放、ACK、背压以及既有 `4002`／`4003` 语义，重连不重新发起模型生成。

5 分钟是待平台验证的应用租期，不是 Access 的平台保证。没有流量且没有心跳的空闲连接可以在下一次事件时关闭；有效期后不能继续输出业务内容。不为认证新增高频 DO Alarm、Workflow 或逐 token 的身份 API 查询。

退出、会话过期和撤销访问只影响读取、订阅及后续操作；已经被服务端接受的生成仍由 DO／Workflow 执行。停止回答继续使用现有显式取消操作。

## 8. 退出与本地清理

删除 `/api/logout` 后，退出采用 Access 的 `/cdn-cgi/access/logout`。官方说明该入口会撤销用户跨 Access 应用的会话，并非只退出 EverChat；Cookie 会立即清除，已签发令牌约在 20–30 秒后停止被 Access 接受。不能承诺只影响本设备或已有 WebSocket 立即失效。[退出语义](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)

界面保留「退出并清除本地记录」，在操作处简短说明会退出其他 Access 应用。执行顺序：

1. 进入本地退出状态，阻止新请求，停止本标签页订阅与后台客户端任务，通过同源标签页通知协调退出。
2. 清除内存、查询缓存、草稿、队列、IndexedDB／localStorage 中的私人记录；保留存储 epoch 防止迟到的自动保存和密钥请求恢复状态。
3. 等待持久化清理完成，再顶层导航至 Access 退出入口；不能先等待联网退出才清本地数据。

离线时仍可完成本地清理，但不能宣称已撤销云端 Access 会话；联网后提供完成远端退出的操作。若持久化清理失败，需要明确提示并允许重试。不要仅因一次 `401` 自动调用跨应用退出。

## 9. 本地开发、自动化与测量

### 9.1 日常本地开发

保留 `pnpm dev` 的顺畅体验，使用独立的开发入口与临时签名身份。Node 开发辅助工具持有临时私钥，提供本地登录夹具；开发适配器把仅本地使用的签名 Cookie 转为断言，HTTP 与浏览器 WebSocket 共用同一套 JWT 验证逻辑。页面不显示密码或私钥。

开发／测试入口使用测试 issuer、公钥与 AUD，生产入口只接受固定的 Access 信任源。适配器、签发路由和测试密钥不进入生产部署；构建检查验证这一点。服务仅监听 loopback，测试使用独立临时数据。不得采用 `hostname === localhost`、任意邮箱头、查询参数或生产 `SKIP_AUTH` 绕过认证。

Wrangler 的 `access.dev` 模拟的是 `ctx.access`，不能直接替代本项目所需的断言验签测试。它可以用于独立平台实验，不作为这次本地认证方案的依据。

### 9.2 真实 Access 联调

使用独立开发子域名及命名 Tunnel，将受 Access 保护的域名转到本地 Vite／Workers 运行时。先配置保护再开放入口，采用真实 JWT 验证入口及独立的本地数据。检查 Host、Origin、Cookie、WebSocket 和 PWA；不能为了隧道联调放宽生产 Origin 校验。[本地开发隧道](https://developers.cloudflare.com/workers/local-development/local-dev-tunnels/)

### 9.3 测试与平台测量

- 在 `tests/support` 中集中管理签名夹具、浏览器登录和请求身份；批量替换调用 `/api/login` 或填写密码的测试，避免每个文件重新实现认证。
- 更新 [tests/support/runtime/control-routes.ts](../../tests/support/runtime/control-routes.ts) 及测量专用 Worker 中对旧 `authenticated()` 的直接调用。控制接口仍只存在于隔离测试入口。
- 本地流式／工具测量复用测试身份；远端测量使用独立 Access 验证应用及 Service Auth 策略，HTTP 和 Node WebSocket 都携带服务凭据，不再配置应用密码或伪造旧 Cookie。
- 服务令牌身份与用户身份不同：仅隔离验证入口显式允许指定服务主体，仍需验签；生产个人应用默认只接受指定人类身份。不要为方便脚本接受任意有效 AUD 的服务令牌。[服务令牌](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- Access Client ID／Secret 只用于访问验证应用，与部署／采集指标的 Cloudflare 管理 API Token 分开管理；凭据不进入报告、前端或 Git。
- 更新 `scripts/measurements` 的认证、验证配置和复现说明；保留隔离资源检查、模拟上游与清理约束。历史测量 JSON 保留原始结果，不把迁移前样本改写为 Access 已验收。
- 更新 PWA 合成 API 的新会话契约，保留它作为离线缓存测试；它不能替代真实 Access 的平台联调。

## 10. 实施顺序与交付边界

阶段 1–5 已完成；阶段 6 已完成正式域名切换与基本上线验证，隔离环境的扩展撤销／费用测量尚未执行。阶段是代码组织顺序，不是在生产环境并行运行新旧认证。

| 阶段           | 工作                                                                                | 通过条件                                                          |
| -------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1. 信任边界    | 明确域名、团队域名、AUD、允许身份；设计会话 DTO、错误码和本地夹具                   | 能在隔离环境验证正确／错误身份；生产构建不包含签发能力            |
| 2. 服务端替换  | 引入 `jose`；统一鉴权；重写 session；删除密码、Cookie、登录限流；转交 WS 身份元数据 | 所有业务 API 与订阅都受保护；直接构造旧 Cookie 无效；业务数据保持 |
| 3. 客户端替换  | 删除密码页；实现状态、AJAX 标记、联网重新认证、退出清理                             | 失效不回退为已联网登录；草稿保留；退出后迟到请求不恢复记录        |
| 4. 同步与离线  | 实现 WS 租期、HTTP 复核、身份确认后的 outbox 投递与 PWA 认证路径排除                | 租期重连无重复生成；离线可阅读；恢复与换身份不会错误投递          |
| 5. 验证及说明  | 替换测试／测量认证；更新 README、模块与部署说明；检查残留引用                       | 完整验证通过；现行入口不再依赖密码；历史记录明确保留              |
| 6. Access 切换 | 在隔离应用完成平台验证；配置正式域名保护、封闭其他入口；部署同一批前后端            | 匿名、错误身份、旧 Cookie 及备用入口均不能读取数据；正式 WS 可用  |

阶段 2–4 作为同一次功能切换交付，不单独上线不完整状态。实现前先核对工作区未提交修改，保留已有修改；按完整、可验证的边界提交代码。

已创建并在控制台核对 EverChat self-hosted Access 应用（`b0bd02c9-4d18-4df8-9e70-65ee370b5bbc`）：团队域名 `wybxc.cloudflareaccess.com`，覆盖整个 `chat.wybxc.cc`，唯一 Allow 策略限定 `wybxc@qq.com`，使用 One-time PIN，应用会话 24 小时，HttpOnly、SameSite Lax。实际 AUD 已写入 `wrangler.jsonc`。不设置 Bypass，关闭 WARP 登录。Access 控制台策略与 Wrangler 变量分别配置。经用户授权，已移除指向已下线 `clab` Tunnel 的旧 `chat` CNAME，并将该域名切换为 EverChat Worker 的 Custom Domain；其他 DNS 和 Tunnel 保留。

上线顺序为：备份业务数据 → 配置域名 Access 与入口封闭 → 验证边缘保护 → 部署完整切换版本 → 验证后删除旧 Secrets。整个窗口保持域名受保护，不先拆除密码再等待 Access 生效。若必须回滚代码，继续保留域名 Access 保护。

## 11. 验收清单

| 范围       | 必测内容                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| JWT        | 缺失、伪造签名、错误 issuer／AUD／算法、过期／缺失 `exp`、未生效令牌、密钥轮换、JWKS 暂时不可用、邮箱和服务主体拒绝 |
| HTTP       | 所有业务路由覆盖；未登录返回合适状态；HTML 错误不丢失状态；跨域写入和升级仍被拒绝；配置缺失不放行                   |
| 入口       | 正式页面／深链接、附件、静态资源、WebSocket 及所有备用域名；旧 Cookie、伪造身份头和内部过期时间头无效               |
| WebSocket  | 首次回放前有效期检查；生成中租期轮换、会话过期、撤销后复核、后台标签页、网络重连、游标回放及无重复模型调用          |
| 客户端     | Session `401` 不使用缓存冒充联网登录；服务故障不误退出；多个并发失败只触发一次复核；登录后返回原 URL 与草稿         |
| 离线／退出 | PWA 离线阅读、排队；联网先认证再投递；不同身份队列隔离；离线退出；清理失败；多标签页及迟到自动保存／密钥响应        |
| 文件通道   | 附件 XHR、备份上传／下载、图片和原生下载链接在 Access 过期时正确失败与恢复，避免把登录 HTML 当文件                  |
| 部署与工具 | 生产产物不包含开发签发入口和测试私钥；测量脚本真实通过隔离 Access；日志与报告无凭据                                 |

代码迁移完成后执行 `pnpm format:check`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:e2e`、`pnpm test:pwa`；先构建再跑 PWA。再执行本地流式／工具测量和有针对性的 Access 平台联调。无法在本地模拟的边缘跳转、撤销和 WebSocket 行为，必须单独记录真实验证结果。

Worker 侧的新增负担集中在每次 HTTP 请求／握手的验签、低频 JWKS 更新和租期重连。迁移不引入新的认证 DO、认证 Workflow、逐 token 验证或登录限流 SQL 写入。上线前比较请求数、Worker CPU 与重连次数，确认仍适合当前 Workers Free 的个人负载；原有测量结果不能直接证明新增鉴权的资源开销。

## 12. 实施记录与验证证据

- 删除共享密码、应用签发的生产 Cookie、登录接口及登录限流；`jose` 验证固定信任源的真实 JWT。生产默认拒绝服务令牌。
- 本地 `pnpm dev` 使用独立 Node 临时签名夹具；`pnpm dev:access` 使用真实验证入口。生产构建不包含临时私钥、签发器或本地身份 Cookie 适配器。
- 客户端统一 AJAX 标记和认证中断；WebSocket 采用 5 分钟租期。离线恢复先确认身份再恢复网络任务；退出锁定存储写入，跨标签页清除，迟到请求不能恢复私有缓存。
- 321 项单元测试通过，包含签名、声明、密钥轮换、JWKS 故障、Origin、服务身份和 WS 租期。完整浏览器回归首轮 275/285 通过，10 项失败经定位修复，失败项复跑通过；新增的离线退出跨标签页回归也已通过。最终相关回归 29 项全部通过。
- 生产构建和类型检查通过；3 项生产 PWA 测试通过，认证导航确实到达服务器，未被离线 SPA 回退吞掉。
- 本地流式测量 3 场景、工具测量 7 场景，以及 Wrangler 原生工具功能验证 9 场景通过。远程测量改用隔离自定义域名和绑定 origin 的 Access 服务凭据；本轮未创建远程验证应用或服务令牌，不能把本地结果当成真实 Access 撤销／平台费用证据。
- 正式 Worker `everchat` 已部署，初始版本为 `91f7fe4e-85b0-43fb-a383-eb97af3843f0`。`chat.wybxc.cc` 已切换到新服务，`workers.dev` 和预览入口在配置中关闭。私有 R2、两个 DO namespace 及工具 Workflow 已绑定；旧生产密码 Secrets 不再需要，本地旧认证变量已移除。
- 未登录访问正式首页、对话深链接、静态图标和 `/auth/resume` 均进入 Access；带 AJAX 标记的 `/api/session` 返回 401，伪造旧 Cookie 和邮箱头不能恢复访问。用户完成 One-time PIN 后，真实 JWT 初始化成功。
- 经用户授权上传纯测试文本，生成独立对话 URL，收到 WebSocket `ready` 后显示已同步；私有文本预览成功，原生下载的 70 字节与原文件 SHA-256 一致。验证对话按用户要求保留，不调用真实模型。
- 代码已推送至私有 GitHub 仓库 `Wybxc/EverChat`，Worker 已关联 `main`，使用专用构建令牌。部署与平台原生告警配置见[运维记录](../operations/cloudflare-deployment.md)。
- 真实令牌自然过期、管理员撤销、原生文件导航在失效后的恢复，以及新增 Access 验签的 CPU／重连平台测量尚未执行；这些边界已有本地回归，但不将其声称为真实平台验收结果。
