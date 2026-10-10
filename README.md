# EverChat

个人自用的云端 AI 聊天原型。客户端断网或关闭页面后，已经提交的回答仍由后台 Workflow 生成；重新打开或换设备后读取持久化结果。

## 本地运行

需要 Node.js 22.12+（或 24+）、pnpm 12。所有命令在项目根目录执行。

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm dev
```

打开 http://127.0.0.1:5173，使用本地密码 `everchat-local` 登录。本地 `.dev.vars` 已为本次原型配置好。默认演示模型缓慢输出示例文字，不调用外部 AI API，适合验证断网和后台执行。

依赖锁文件为 `pnpm-lock.yaml`。本地聊天和 Workflow 状态保存在 `.wrangler/`，重启开发服务器后仍保留。`.npmrc` 将 pnpm 的存储放在项目内，便于受限工作区运行。

## 接入真实模型

登录后打开「空间设置 → AI 供应商」，选择协议，填写 API 基础地址、模型 ID 和 API 密钥，保存即可用于后续生成。也可设置系统提示词和输出 Token 上限。

| 接口协议 | 默认 API 基础地址 | 流式接口 |
|---|---|---|
| OpenAI Chat Completions（含兼容供应商） | `https://api.openai.com/v1` | `/chat/completions` |
| Anthropic Messages | `https://api.anthropic.com/v1` | `/messages` |
| OpenAI Responses | `https://api.openai.com/v1` | `/responses` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta` | `/models/{model}:streamGenerateContent` |

基础地址必须使用 HTTPS，包含版本路径，不含具体接口路径、查询参数或账号信息。模型 ID 按供应商提供的名称填写。四种协议使用 AI SDK 的对应适配器，保持流式保存和零自动重试；OpenAI 请求设置 `store: false`。保存设置本身不会调用或验证模型服务。

设置保存在个人 `Library` Durable Object 中，跨设备共享。密钥仅存在服务端：读取设置只返回 `hasApiKey`，不会回显或放入浏览器存储。修改同一协议、同一地址的模型时密钥留空可保留；更换协议或地址必须重新填写密钥。选择演示模型会清除网页保存的密钥。已经启动的生成继续使用启动时读取的配置。

首次使用时仍可在 `wrangler.jsonc` 的 `vars` 中设置默认值：

```json
{
  "AI_PROVIDER": "openai-chat",
  "AI_BASE_URL": "https://your-provider.example/v1",
  "AI_MODEL": "your-model-name",
  "MAX_OUTPUT_TOKENS": "4096"
}
```

`AI_PROVIDER` 可为 `demo`、`openai-chat`、`anthropic`、`openai-responses` 或 `gemini`；旧值 `openai-compatible` 继续映射到 Chat Completions。本地默认密钥写入 `.dev.vars` 的 `AI_API_KEY`，生产默认密钥可使用同名 Cloudflare Secret。网页保存的完整配置优先于这些默认值，后续更改默认值不会覆盖已保存的网页配置。

## 部署到 Cloudflare

先选择自己的 Cloudflare 账户，并设置登录所需的两个 Secrets。不要使用示例中的本地密码或 session secret 部署。

```sh
pnpm exec wrangler login
pnpm exec wrangler secret put APP_PASSWORD
pnpm exec wrangler secret put SESSION_SECRET
# 可选：通过环境变量配置默认模型密钥时使用；网页配置无需此步骤。
pnpm exec wrangler secret put AI_API_KEY
pnpm deploy
```

`SESSION_SECRET` 使用至少 32 字符的随机值，例如 `openssl rand -hex 32` 生成的结果。Secrets 存在服务端，不写入前端或 Git。默认 demo 模式也可部署，无需模型密钥。部署将创建 Worker、两个 SQLite Durable Object namespace 和一个 Workflow；首次启用服务时按 Cloudflare 提示完成账户配置。费用以账户当前套餐和实际用量为准。

生产构建有 PWA manifest、应用图标及 Service Worker，支持安装和离线重新打开已访问的应用。开发模式不注册 Service Worker。客户端缓存、快照和离线草稿优先保存在 IndexedDB（由 `idb-keyval` 管理），并保留 localStorage 作为迁移和故障回退；共享设备上用“退出并清除本地记录”。主题偏好仍使用 localStorage，以便页面启动前立即恢复主题。

## 验收与测试

```sh
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

端到端测试使用本地 Cloudflare 运行时，不模拟生成后台。`pnpm test:e2e` 在 5174 端口启动独立服务器，使用临时存储目录，避免修改日常聊天及供应商设置；需要默认 demo 模式和 `.dev.vars.example` 中的本地密码。测试包含鉴权、跨域写入拒绝、请求幂等、会话并发限制、断网恢复、第二设备同步、页面关闭后继续生成、离线待发送、取消、重新生成、响应式截图，以及四种协议的网页配置、密钥隐藏与保留、跨设备读取和字段校验。单元测试使用协议响应样本验证请求及流式处理，不发起真实付费模型调用。

手动验证：

1. 发送消息，生成途中断开网络。另一浏览器登录同一空间，打开同一对话，观察生成完成。
2. 原设备恢复联网，确认完整回答自动补齐。
3. 再发一条消息，关闭所有页面，稍后重新打开，应看到完整结果。
4. 断网后发送消息，应显示“等待云端确认”；恢复联网后只产生一条用户消息和一个回答。

## 实现与边界

```text
PWA → Worker（密码鉴权、API）→ Conversation Durable Object（SQLite、事件序号）
                              ↓ 持久化 outbox + alarm
                            Workflow → 模型供应商
                              ↓ 保存回答，再广播
                            Conversation → 休眠 WebSocket → 多设备
```

- `Library` Durable Object 保存个人会话索引、供应商配置与登录频率限制，`Conversation` 每个对话一个实例。暂不使用 D1、R2 或第三方登录。
- 接收消息前先设置持久化 alarm；保存消息和任务 outbox 在同一个 SQLite 事务。alarm 用任务 ID 创建 Workflow，创建确认丢失时复用同一 ID。浏览器保存提交 request ID，未知网络结果继续用它重试。
- 每个会话只允许一个活跃生成，不同会话可同时生成。回答约每 500ms 保存一次，事件带有递增序号。重连读取快照并补齐事件；事件日志只保留最近 500 次更新，较旧设备通过完整快照恢复。
- 供应商调用步骤的自动重试次数为零；任务领取也是幂等的。供应商失败保留已保存/已缓冲的内容，标记失败，不自动二次调用付费模型。用户主动重新生成、编辑消息都保存为新版本。
- 原型保留线性历史；重新生成或编辑旧消息时，该次模型上下文截止到原消息之前，并使用新内容。它不提供完整分支树或分支导航。
- 停止会立即更新云端状态；正在等待供应商数据的调用会在下一次保存时发现停止，并取消读取。无输出时依靠 14 分钟请求超时，因此停止不保证供应商立即停止计费。
- Worker/供应商重启或网络故障不能恢复同一 token 生成。已领取的任务不会自动重新调用供应商；异常由 Workflow 或 20 分钟 watchdog 标为失败。
- 本地断网前最后一条尚未确认提交的消息可能已在云端接受；此时保留同一 request ID 重试。离线缓存仅属于此浏览器，首次访问和登录需要联网。
- 私人空间使用一个密码、签名 HttpOnly/SameSite cookie、30 天会话、同源写入校验及登录尝试限制。修改 `SESSION_SECRET` 可使所有旧会话失效。当前退出清理本设备 cookie 和缓存，不撤销其他设备的会话。
- 原型最多 500 个会话，每个 1,000 条消息；输入最多 16,000 字，回答最多 100,000 字；提供给模型最近最多 40 条/80,000 字的已完成历史。暂无附件、工具调用、删除、全局内容搜索或多用户隔离。

## 文件

- `worker/`：鉴权、Hono API、持久化会话、后台生成及 AI SDK 供应商适配。
- `src/`：React 界面、离线缓存与 outbox、WebSocket 自动重连。
- `shared/`：API 数据结构及按序应用同步事件。
- `tests/`：AI SDK 流式适配单元测试、基于浏览器和真实本地运行时的集成测试。

架构依据：[Cloudflare Workflows API](https://developers.cloudflare.com/workflows/build/workers-api/)、[Durable Objects WebSocket 休眠](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)、[Durable Objects alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)。
