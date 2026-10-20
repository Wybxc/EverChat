# 自行部署

[项目首页](../../README.md) · [文档索引](../README.md)

本指南说明新部署的配置入口。现有站点的账户资源、自动构建和验收证据另见[生产部署记录](cloudflare-deployment.md)。使用前先按[本地开发说明](../development.md)安装依赖。

## 1. 准备资源与域名

需要 Cloudflare 账户、可绑定 Worker 的域名、Cloudflare Access，以及启用了 R2 的账户。模型供应商密钥可在部署后通过网页配置。

编辑根目录的 `wrangler.jsonc`，将现有部署的域名、Access 参数、资源名称替换为自己的值：

| 配置                    | 用途                                                   |
| ----------------------- | ------------------------------------------------------ |
| `name`、`routes`        | Worker 名称及自己的自定义域名                          |
| `APP_ORIGIN`            | 完整站点 Origin，例如 `https://chat.example.com`       |
| `ACCESS_TEAM_DOMAIN`    | Access 团队域名，例如 `your-team.cloudflareaccess.com` |
| `ACCESS_AUD`            | 下节创建的 Access 应用 AUD；它是应用标识，不是密钥     |
| `ACCESS_ALLOWED_EMAILS` | 允许的邮箱；多项使用逗号分隔                           |
| `r2_buckets`            | 私有附件桶名称，绑定名保持 `ATTACHMENTS`               |
| `workflows`             | 自己的工具 Workflow 名称，绑定名保持 `WEB_TOOLS`       |

保留 `CONVERSATIONS`、`LIBRARY`、`USAGE`、`SHARES` 四个 DO 绑定及已有类迁移声明。首次部署由 Wrangler 创建对应 namespace 和 Workflow 定义；不要把已有生产资源名称当作新账户的配置。

## 2. 配置 Cloudflare Access

在 Zero Trust 中创建 self-hosted 应用，使用自己的域名，按允许的邮箱或身份配置 Allow 规则。将同一站点下的以下四个路径加入应用，并取得其 AUD：

```text
chat.example.com/api
chat.example.com/api/*
chat.example.com/auth
chat.example.com/auth/*
```

前端、静态资源、`sw.js` 和 `/s/:id` 分享页面公开；`/public/shares/:id` 也须可匿名到达 Worker，由分享令牌和有效期校验控制读取。不要将私有 API 配为 Everyone 或 Bypass。使用同域分享时，覆盖整个域名的其他 Access 应用也不能继续拦截这些公开路径。

Worker 会再次校验 JWT 的签名、issuer、audience、有效期和允许身份；修改请求与 WebSocket 仍有同源检查。仅填写 Wrangler 变量不会启用边缘 Access 规则。应用当前是共享的个人空间，不按多个允许身份隔离数据。

保留 `workers_dev: false`、`preview_urls: false`，避免出现未纳入域名访问规则的备用入口。静态资源保留 SPA 回退和 `html_handling: none`，并保留 `/api`、`/auth`、`/public` 的 `run_worker_first` 配置，以支持直接打开对话 URL、PWA 缓存和公开分享接口。

## 3. 创建附件桶并部署

```sh
pnpm exec wrangler login
pnpm exec wrangler r2 bucket create your-everchat-attachments --storage-class Standard
pnpm deploy
```

先将桶名写入 Wrangler 配置，保持私有，不启用公开下载。`pnpm deploy` 执行类型检查、构建和部署。部署后使用允许的身份登录，在网页添加供应商和模型。

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

分享需要 `SHARES` 绑定和 `SHARE_LINK_KEY` Secret。该 Secret 使用密码学随机的 32 字节、base64url 编码，用于加密保存可再次复制的分享令牌。通过 Wrangler Secret 输入，安全备份，不放入 `vars`、前端或 Git；替换密钥会影响已存链接令牌的解密。

后台 Web Push 需要以下 Secrets：

| Secret              | 格式                                          |
| ------------------- | --------------------------------------------- |
| `VAPID_PUBLIC_KEY`  | P-256 未压缩 65 字节公钥，base64url 编码      |
| `VAPID_PRIVATE_KEY` | P-256 32 字节私钥，base64url 编码             |
| `VAPID_SUBJECT`     | 部署者联系地址，例如 `mailto:you@example.com` |

使用可信的本机工具生成密钥，经 `wrangler secret put` 或仓库外权限为 `0600` 的临时文件配合 `wrangler secret bulk` 上传。轮换 VAPID 后客户端需要更新订阅；未配置完整密钥时只能使用页面在线通知。每个浏览器／PWA 仍需用户亲自授予通知权限。详细验收见[通知记录](cloudflare-deployment.md#回答完成通知)。

联网服务在网页「设置 → 联网」配置，无需把搜索密钥加入前端或 Wrangler 公开变量。

## 发布与维护

可使用 `pnpm deploy`，或配置 GitHub 自动部署。当前项目的自动构建入口为 `pnpm test && pnpm build`，部署入口为 `pnpm exec wrangler deploy`；凭据和分支必须属于自己的部署。浏览器、PWA 和平台测量按[开发指南](../development.md)另行执行。

首次上线应验证：未登录可读取静态页面，私有 API 要求 Access；获准身份可聊天和上传；匿名完整分享链接可读，删除后不可读；PWA 可安装、检查更新并离线重开。

存量数据结构升级只在维护窗口通过[本地离线运维工具](offline-storage-migration.md)执行。先备份和校验，失败可回滚，不通过线上普通访问自动转换历史数据。
