# 自行部署

[项目首页](../../README.md) · [文档索引](../README.md)

本指南说明新部署的配置入口。现有站点的账户资源、自动构建和验收证据另见[生产部署记录](cloudflare-deployment.md)。使用前先按[本地开发说明](../development.md)安装依赖。

## 1. 准备资源与域名

需要 Cloudflare 账户、可绑定 Worker 的域名、Cloudflare Access，以及启用了 R2 的账户。模型供应商密钥可在部署后通过网页配置。

仓库的 `wrangler.jsonc` 只声明通用运行配置，不包含作者的域名、AUD 或邮箱。域名和身份参数在每个部署者自己的 Cloudflare 账户中配置，无需修改源码或将个人参数提交到 Git。

下列参数在 Worker 的「设置 → 变量和机密」中配置：

| 配置                    | 用途                                                   |
| ----------------------- | ------------------------------------------------------ |
| `APP_ORIGIN`            | 完整站点 Origin，例如 `https://chat.example.com`       |
| `ACCESS_TEAM_DOMAIN`    | Access 团队域名，例如 `your-team.cloudflareaccess.com` |
| `ACCESS_AUD`            | 下节创建的 Access 应用 AUD；它是应用标识，不是密钥     |
| `ACCESS_ALLOWED_EMAILS` | 允许的邮箱；多项使用逗号分隔                           |

这些是部署参数，允许使用文本变量；希望在控制台隐藏邮箱等值时也可使用 Secret。配置中的 `keep_vars: true` 保留账户中已有的变量，普通部署不会清除它们；与仓库 `vars` 同名的值仍以仓库配置为准。模型 API 密钥等凭据应使用 Secret 或网页供应商设置。

默认 Worker、附件桶和 Workflow 分别命名为 `everchat`、`everchat-attachments`、`everchat-web-tools`，都属于当前部署账户，不指向作者账户。如果同一账户已有同名资源，可统一调整 `name`、`r2_buckets` 和 `workflows` 中的名称。保留 `CONVERSATIONS`、`LIBRARY`、`USAGE`、`SHARES` 及其他绑定名和已有类迁移声明；首次部署由 Wrangler 创建 namespace 和 Workflow 定义。

## 2. 配置 Cloudflare Access

在 Zero Trust 中创建 self-hosted 应用，使用自己的域名，按允许的邮箱或身份配置 Allow 规则。将同一站点下的以下四个路径加入应用，并取得其 AUD：

```text
chat.example.com/api
chat.example.com/api/*
chat.example.com/auth
chat.example.com/auth/*
```

前端、静态资源、`sw.js` 和 `/s/:id` 分享页面公开；`/public/shares/:id` 也须可匿名到达 Worker，由分享令牌和有效期校验控制读取。`/mcp` 同样需要可到达 Worker，由 EverChat 自己的可撤销 API Key 鉴权，接入步骤见 [MCP 指南](../features/mcp.md)。不要将私有 API 配为 Everyone 或 Bypass。覆盖整个域名的其他 Access 应用也不能继续拦截这些入口。

Worker 会再次校验 JWT 的签名、issuer、audience、有效期和允许身份；修改请求与 WebSocket 仍有同源检查。仅设置变量不会启用边缘 Access 规则。应用当前是共享的个人空间，不按多个允许身份隔离数据。

保留 `workers_dev: false`、`preview_urls: false`，避免出现未纳入域名访问规则的备用入口。域名在控制台管理，仓库不声明 `routes`；普通部署不重新分配已绑定的自定义域名。静态资源保留 SPA 回退、`html_handling: none` 及 `/api`、`/auth`、`/public`、`/mcp` 的 `run_worker_first` 配置。

构建输出包含聊天用的 `index.html` 和分享用的 `share.html`。保留 `public/_redirects` 中将 `/s`、`/s/*` 以 200 代理到 `/share.html` 的规则，以及 `_headers` 对分享路径和直接 HTML 地址的安全头；它们随构建复制到静态目录。此分流不改变分享 URL，不需要将 `/s/*` 加入 `run_worker_first` 或 Access 保护。已安装 PWA 按正常检查更新流程获取新的 SW 后，分别处理聊天与分享导航。

### 可选：使用 GitHub 登录

按照 [Cloudflare GitHub 集成文档](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/github/)创建专用 GitHub OAuth 应用，回调地址使用 `https://<你的团队域名>/cdn-cgi/access/callback`。将客户端 ID 和密钥填入 Cloudflare 身份提供商，密钥不写入仓库或前端。

先通过身份提供商的测试入口核对返回邮箱，与 Access Allow 规则和 `ACCESS_ALLOWED_EMAILS` 一致，再在 EverChat 应用中选择 GitHub。只使用 GitHub 时，关闭「接受所有可用的标识提供程序」并开启「应用即时身份验证」。应用认证代码无需修改，已有会话不等于一次新的登录验证。

## 3. 创建附件桶并部署

```sh
pnpm exec wrangler login
pnpm exec wrangler r2 bucket create everchat-attachments --storage-class Standard
pnpm deploy
```

网页原文件采用 R2 预签名 PUT 直传。R2 binding 无法签发 S3 URL，还需在 R2 → 管理 API 令牌创建**仅指定附件桶的对象读写凭据**，并配置以下 Worker 参数：

| 配置                   | 存储方式      | 用途                                |
| ---------------------- | ------------- | ----------------------------------- |
| `R2_ACCOUNT_ID`        | 变量或 Secret | 当前 Cloudflare 账户 ID             |
| `R2_BUCKET_NAME`       | 变量或 Secret | 与 `ATTACHMENTS` binding 相同的桶名 |
| `R2_ACCESS_KEY_ID`     | Secret        | 专用 S3 Access Key ID               |
| `R2_SECRET_ACCESS_KEY` | Secret        | 专用 S3 Secret Access Key           |

通过控制台或 `wrangler secret put` 输入，不写进仓库或前端。缺失时签发接口返回 503，不回退大文件中转。密钥只授权附件桶，保持私有；Access 保护范围不变。

为该桶设置 CORS，将 Origin 换成实际 `APP_ORIGIN`，不得直接使用通配来源：

```json
{
  "rules": [
    {
      "allowed": {
        "origins": ["https://chat.example.com"],
        "methods": ["PUT"],
        "headers": ["Content-Type", "If-None-Match"]
      },
      "exposeHeaders": ["ETag"],
      "maxAgeSeconds": 3600
    }
  ]
}
```

将配置保存在仓库外，通过 `pnpm exec wrangler r2 bucket cors set <bucket> --file <path>` 设置。CORS 只控制浏览器读取，鉴权仍由短期 SigV4 完成；上传不会带网站 Cookie 或 Access JWT。上传后的 HEAD 仅核对大小和类型，客户端 SHA-256 是内容指纹；详情见 [R2 直传计划](../plans/r2-direct-upload-plan.md)。本地开发使用独立的本地 S3 适配器，不需要生产 S3 密钥。

附件桶保持私有，不启用公开下载；自定义桶名时同步修改 Wrangler 配置。`pnpm deploy` 执行类型检查、构建和部署，默认不会创建 `workers.dev` 公开入口。

首次部署完成后，在 Workers 和 Pages → 对应 Worker 中完成：

1. 在「设置 → 变量和机密」填写前述四个 Access／Origin 参数并保存部署。
2. 在「设置 → 域和路由」添加自己的自定义域名，确认该域名的 Access 应用已按上节配置。
3. 使用允许的身份登录，在网页添加供应商和模型。

缺少 Access 配置时私有 API 拒绝访问，不会退回作者的身份或开放匿名聊天。已有部署已保存参数和自定义域名时无需重复设置。

应用针对 Workers Free 控制读写频率与存储，但不提供账户级账单硬停保证。R2、模型和联网服务分别计算用量；预算与告警参考[免费层资源政策](../architecture/free-tier-resource-policy.md)和[生产原生告警记录](cloudflare-deployment.md#平台原生告警)。

## 可选的初始模型配置

通常使用网页设置即可。也可在首次保存供应商设置前，通过 `vars` 提供初始供应商：

```json
{
  "AI_PROVIDER": "openai-chat",
  "AI_BASE_URL": "https://your-provider.example/v1",
  "AI_MODEL": "your-model-name"
}
```

`AI_PROVIDER` 可选 `openai-chat`、`openai-responses`、`anthropic`、`gemini`。生产初始密钥使用 Secret：

```sh
pnpm exec wrangler secret put AI_API_KEY
```

本地初始密钥可放在被忽略的 `.dev.vars` 中。`SYSTEM_PROMPT` 提供初始默认提示词；可选 `MAX_OUTPUT_TOKENS` 提供初始输出预算，默认不设置。已保存网页设置后由保存的配置决定，不应把环境变量当作持续覆盖入口。

## 可选的分享与后台通知

分享需要 `SHARES` 绑定。已发布的 `/s/<随机ID>` 无需登录或额外密钥，首次 HTML 响应包含全文；管理操作仍由 Access 保护。分享不进入 CDN／Service Worker 正文缓存。已有部署升级到预渲染分享时，先按[离线运维指南](offline-storage-migration.md#公开分享预渲染版本-2)转换分享库。

后台 Web Push 需要以下 Secrets：

| Secret              | 格式                                          |
| ------------------- | --------------------------------------------- |
| `VAPID_PUBLIC_KEY`  | P-256 未压缩 65 字节公钥，base64url 编码      |
| `VAPID_PRIVATE_KEY` | P-256 32 字节私钥，base64url 编码             |
| `VAPID_SUBJECT`     | 部署者联系地址，例如 `mailto:you@example.com` |

使用可信的本机工具生成密钥，经 `wrangler secret put` 或仓库外权限为 `0600` 的临时文件配合 `wrangler secret bulk` 上传。轮换 VAPID 后客户端需要更新订阅；未配置完整密钥时只能使用页面在线通知。每个浏览器／PWA 仍需用户亲自授予通知权限。详细验收见[通知记录](cloudflare-deployment.md#回答完成通知)。

联网服务在网页「设置 → 联网」配置，无需把搜索密钥加入前端或 Wrangler 公开变量。

## 发布与维护

可使用 `pnpm deploy`，或配置 GitHub 自动部署。生产构建入口为 `pnpm build`，部署入口为 `pnpm exec wrangler deploy`；凭据和分支必须属于自己的部署。仓库的 [Tests 工作流](../../.github/workflows/tests.yml) 独立运行格式、类型、单测和运维集成；[Browser regression 工作流](../../.github/workflows/browser-tests.yml) 手动运行浏览器／PWA 回归，均不需要生产凭据。将生产分支设为受保护分支，要求 PR 的 `Required tests` 通过并同步最新主分支后才允许合并；不要用生产分支推送后才启动的测试作为发布门槛。平台资源测量与真实设备验收按[开发指南](../development.md)另行执行。

首次上线应验证：未登录可读取静态页面，私有 API 要求 Access；获准身份可聊天和上传；匿名完整分享链接可读，删除后不可读；PWA 可安装、检查更新并离线重开。

存量数据结构升级只在维护窗口通过[本地离线运维工具](offline-storage-migration.md)执行。先备份和校验，失败可回滚，不通过线上普通访问自动转换历史数据。
