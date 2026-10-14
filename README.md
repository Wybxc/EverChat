# EverChat

个人自用的云端 AI 聊天原型。客户端断网或关闭页面后，已经提交的回答仍由 Conversation Durable Object 的 Alarm 在后台生成；重新打开或换设备后读取持久化结果。

## 本地运行

需要 Node.js 22.12+（或 24+）、pnpm 12。所有命令在项目根目录执行。

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm dev
```

打开 http://127.0.0.1:5173，使用本地密码 `everchat-local` 登录。在空间设置中添加供应商并选择默认模型后即可发送消息。

新对话位于 `/`，每个已创建或离线待发送的对话使用 `/c/:conversationId`。点击侧栏以 SPA 方式切换，支持浏览器前进／后退、直接打开链接和刷新；链接也可在新标签页打开。URL 决定当前对话，访问 `/` 始终进入新对话。各对话草稿独立保存。

对话右上角的管理菜单支持改名、置顶、归档和删除。侧栏分为「对话」「归档」，置顶条目优先，其余按最近消息活动排列；改名和整理不改变活动时间。归档保留正文和 URL，也不会停止生成。删除需要确认，会停止生成、清除正文和本设备草稿；其他设备联网同步后清理对应缓存与待发送消息。已删除的 URL 显示错误，可开启新对话。

点击右上角搜索按钮或按 Ctrl／⌘ F 可查找当前对话的正文与思考内容。搜索忽略大小写，按普通文字匹配，支持跨 Markdown 格式的短语；关键词最多 200 字。上下按钮或 Enter／Shift+Enter 在匹配间循环，Escape 关闭并返回搜索按钮。定位会展开折叠的思考区；查找旧内容时暂停跟随滚动，点击「滚动到最新消息」可恢复。流式内容更新计数时保留当前匹配，不反复跳转。搜索在客户端执行，已缓存对话可离线查找，跨对话正文搜索尚未实现。

依赖锁文件为 `pnpm-lock.yaml`。本地聊天和供应商配置保存在 `.wrangler/`，重启开发服务器后仍保留。`.npmrc` 将 pnpm 的存储放在项目内，便于受限工作区运行。

## 接入真实模型

设置分为「通用」「供应商」「对话」三个 Tab，修改后自动保存。停止输入约 600ms、离开输入框或关闭窗口时保存；失败会保留当前编辑并提供重试。关闭按钮和 Tab 固定显示，内容区域独立滚动。

在「供应商」中添加供应商，配置名称、接口协议、API 基础地址和密钥。模型使用复选框启用或禁用，并可编辑 ID 和显示名。获取的新增模型默认禁用，手动添加的模型默认启用；重新获取保留已有模型的显示名和启用状态。

「对话」中的默认模型只包含已启用且配置密钥的模型。聊天输入框可以为每次请求选择模型，选择随离线请求保存，重新生成沿用原模型。模型设置中可以继承统一系统提示词或配置专属提示词；模型支持时还可以设定思维强度。思维强度默认按模型 ID 识别，也可在模型设置中指定能力。系统提示词、输出 Token 上限和是否显示供应商返回的思考内容在「对话」Tab 中设置。输出上限默认留空，使用供应商或 SDK 的默认值；填写正整数可设置上限，清空后取消。

颜色模式支持浅色、深色和系统偏好。默认跟随设备外观变化。

| 接口协议 | 默认 API 基础地址 | 流式接口 |
|---|---|---|
| OpenAI Chat Completions（含兼容供应商） | `https://api.openai.com/v1` | `/chat/completions` |
| Anthropic Messages | `https://api.anthropic.com/v1` | `/messages` |
| OpenAI Responses | `https://api.openai.com/v1` | `/responses` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta` | `/models/{model}:streamGenerateContent` |

基础地址必须使用 HTTPS，保留供应商要求的版本路径，不含具体接口路径、查询参数或账号信息。获取模型列表由服务端使用该供应商的 API 密钥访问模型目录；响应只包含模型 ID。四种生成协议使用 AI SDK 的对应适配器，保持流式保存和零自动重试；OpenAI 请求设置 `store: false`。DeepSeek 可选择 OpenAI Chat Completions，基础地址填写 `https://api.deepseek.com`，再获取模型列表。DeepSeek 的兼容接口单独映射 `thinking.type` 和 `reasoning_effort`，显示的是供应商实际返回的 `reasoning_content`；OpenAI Responses、Anthropic 与 Gemini 也仅展示供应商主动提供的思考摘要或思考内容。

供应商和模型列表保存在个人 `Library` Durable Object 中，跨设备共享。登录后的设置接口会返回已配置的密钥，客户端默认遮蔽，可点击眼睛按钮查看；密钥不会写入 localStorage、IndexedDB 或离线缓存。修改同一协议、同一地址的供应商时密钥留空可保留；更换协议或地址必须重新填写密钥。删除供应商会同时删除对应密钥和模型列表。已接受的生成会保存当时的模型、系统提示词和强度配置，后续设置改动不影响排队任务。

首次使用时仍可在 `wrangler.jsonc` 的 `vars` 中设置默认值：

```json
{
  "AI_PROVIDER": "openai-chat",
  "AI_BASE_URL": "https://your-provider.example/v1",
  "AI_MODEL": "your-model-name"
}
```

`AI_PROVIDER` 可为 `openai-chat`、`anthropic`、`openai-responses` 或 `gemini`。本地默认密钥写入 `.dev.vars` 的 `AI_API_KEY`，生产默认密钥可使用同名 Cloudflare Secret。首次保存网页设置前，这些值会作为初始供应商和模型。`MAX_OUTPUT_TOKENS` 可选，填写正整数时指定初始输出上限。未配置供应商或默认模型时禁止生成。

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

`SESSION_SECRET` 使用至少 32 字符的随机值，例如 `openssl rand -hex 32` 生成的结果。登录 Secrets 仅存在服务端，不写入前端或 Git。部署后可通过网页配置模型。部署将创建 Worker、两个 SQLite Durable Object namespace ；首次启用服务时按 Cloudflare 提示完成账户配置。费用以账户当前套餐和实际用量为准。

生产构建有 PWA manifest、应用图标及 Service Worker，支持安装和离线重新打开已访问的应用。开发模式不注册 Service Worker。客户端缓存、快照和离线草稿优先保存在 IndexedDB（由 `idb-keyval` 管理），并保留 localStorage 作为故障回退；共享设备上用“退出并清除本地记录”。主题偏好仍使用 localStorage，以便页面启动前立即恢复主题。

## 验收与测试

```sh
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:pwa
```

端到端测试使用本地 Cloudflare 运行时及真实 Durable Object Alarm、SQLite 和 WebSocket。测试入口提供模拟供应商及实例重置、写入失败等故障注入，不发起付费模型调用。`pnpm test:e2e` 在 5174 端口启动独立服务器，使用临时存储目录，避免修改日常聊天及供应商设置；需要 `.dev.vars.example` 中的本地密码。测试包含鉴权、跨域写入拒绝、请求幂等、会话并发限制、断网恢复、第二设备同步、页面关闭后继续生成、离线待发送、取消、重新生成、响应式截图，以及多供应商增删改、模型获取与编辑、密钥查看与遮蔽、跨设备读取和未配置模型时禁止生成。执行器回归还覆盖 Alarm 重入、原生实例重置、取消静默上游及尾部保存失败。单元测试检查四种协议的请求及模型目录解析。

导航回归检查直接链接登录、无整页刷新切换、前进／后退、草稿恢复、新标签页和离线待发送。不存在或无效的 URL 显示错误，可开启新对话，不自动创建同 ID 的替代对话。`pnpm test:pwa` 需要先构建，在 5175 端口服务生产静态文件与合成只读 API，验证 Service Worker 激活后的离线刷新和新标签页能恢复缓存正文／思考，API 响应不进入离线缓存；后台生成仍由主端到端套件验证。

管理回归覆盖修改失败后保留输入、第二设备的改名／置顶／归档同步、删除确认与取消、生成中删除、清空大段存储、离线迟到请求和分页删除同步。故障注入分别在清理前返回失败、清空存储后重置原生 DO，验证 Library Alarm 能完成清理且不重复调用模型；测试只清理专门创建的测试对话。

搜索回归覆盖 Markdown 跨格式匹配、特殊字符与 Unicode、排除模型标签和操作按钮、中文输入法、折叠思考区和嵌套滚动、移动端离线查找、导航／删除清理，以及生成中的匹配计数和阅读位置。生产 PWA 测试另行验证离线重开后的搜索与深浅主题高亮的实际对比度不低于 4.5:1。高亮使用 [CSS Custom Highlight API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API)，不改写 Markdown DOM；旧浏览器没有该 API 时仍可定位和查看消息边框，关键词着色需要支持该 API 的浏览器。

流式资源基线：

```sh
pnpm measure:stream
# 以更慢的输出节奏测量，写到独立文件，保留首次基线：
pnpm measure:stream --interval 100 --output /tmp/everchat-stream-comparison.json
```

此命令在 5184 端口启动独立本地运行时，使用临时数据库和模拟供应商，覆盖正文、思考及客户端在回答开始后断开订阅的场景。在线场景还比较增量回放和最终数据库快照。只保存计数，不记录正文或密钥；报告默认写入系统临时目录中的 `everchat-stream-measurements.json`，可用 `--output` 指定文件，保留首次基线。指标定义、Workers Free 隔离部署验证结果及复现步骤见 [流式测量说明](docs/stream-measurements.md)。平台已通过 9 项功能场景、3 项一分钟以上生成和 30 次终态重连；8MB 历史快照已通过 DO Response 转发降低 Worker CPU。历史与存储预算另有本地故障回归；这些结果限定于已测个人负载，不能保证共享账户的所有应用始终处于免费额度内。

手动验证：

1. 发送消息，生成途中断开网络。另一浏览器登录同一空间，打开同一对话，观察生成完成。
2. 原设备恢复联网，确认完整回答自动补齐。
3. 再发一条消息，关闭所有页面，稍后重新打开，应看到完整结果。
4. 断网后发送消息，应显示“等待云端确认”；恢复联网后只产生一条用户消息和一个回答。

## 实现与边界

```text
PWA → Worker（密码鉴权、API）→ Conversation Durable Object（SQLite、事件序号）
                              ↓ 原子保存输入、配置、outbox + alarm
                            Conversation Alarm → 模型供应商
                              ↓ 增量日志 → 终态快照
                            Conversation → 休眠 WebSocket → 多设备
```

- `Library` Durable Object 保存个人会话索引、供应商配置与登录频率限制，`Conversation` 每个对话一个实例。暂不使用 D1、R2 或第三方登录。
- 删除先在 Library 保存永久标记，再中止 Conversation 的上游请求、清空 SQLite／任务 Alarm、保存最小删除标记，最后移除索引。Library Alarm 每批最多清理 16 项，失败后 30 秒重试；实例在清空与写入标记之间重置时，Library 标记仍阻止迟到任务和创建请求。重复删除是幂等的，同 ID 的创建、提交和读取返回 410，不重新调用模型。
- `GET /api/conversations?after=<cursor>` 返回对话索引和每页最多 256 条删除记录，客户端读完分页后保存游标。这样没有打开被删除对话的设备也能清理缓存与离线 outbox。服务端及本地删除标记长期保留，防止旧设备重新恢复数据；它们仍占少量存储，删除不表示账户存储归零。DO 清空存储的行为依据 [SQLite 存储 API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)。
- 在同一个存储事务中保存输入、配置快照、请求 ID、任务 outbox 和 Alarm；提交成功后才确认接受。新任务固定执行器 `do-v1`，由 Conversation Alarm 认领并执行。浏览器保存提交 request ID，未知网络结果继续用它重试。
- 每个会话只允许一个活跃生成，不同会话可同时生成。供应商原始字节约每 100ms 或达到 8 KiB 封装预览，约每 1.5 秒或达到 32 KiB 批量保存；一个提交最多 64 KiB、32 个微批次。保存时保留预览的序号和字节边界，结束、失败或取消时立即保存尾部并原子整理终态快照。
- 预览与保存确认分别发送。客户端维护实时视图和持久化快照，只有已保存内容可缓存、导出或用于重连。缓存最多每 2 秒写入一次，完成、切换对话或页面隐藏时立即刷新；尚未确认的预览显示“保存中”。
- 事件序号与增量偏移用于去重和检查缺口；最近 500 个持久化事件支持回放，游标过期时恢复完整快照。重连先恢复已保存内容，再补当前内存尾部。未确认接收的预览窗口限于 128 KiB，过慢订阅主动断开后重新同步，不阻塞云端保存或其他客户端。
- 原型只维护当前数据结构、DO 执行器与 `raw-sse-v1` 协议，不提供旧客户端、旧任务或旧格式自动迁移。偏移对应供应商原始字节；字节以 base64 保存在同步帧中，允许切在 UTF-8、SSE 或 JSON 中间。客户端和云端快照／终态整理共用 `eventsource-parser` 与四种协议适配，解析检查点保存未完成事件和字符，确保重连不会丢失半个片段。
- DO 在接收流时只封装、转发和批量保存原始字节，不逐 Token 解析正文。读取生成中快照或整理终态时解析已保存日志；完成原因与用量由云端验证并保存，不依赖客户端提交。最终正文、思考、状态、用量和日志清理在同一个事务内保存。下一次读取上游前等待存储提交，限制保存落后时的缓冲。
- 完整快照由 DO 构造 JSON Response，经 RPC 传输响应体；Worker 完成鉴权和索引检查后直接转发，避免在 10ms 免费 CPU 路径中反序列化并重新编码大段历史。
- 供应商调用的自动重试次数为零；任务领取也是幂等的。启动上游前确认认领已持久化。供应商失败时保存缓冲尾部并标记失败；存储错误保留最近检查点，不发布虚假的完成状态。用户主动重新生成、编辑消息都保存为新版本。
- 原型保留线性历史；重新生成或编辑旧消息时，该次模型上下文截止到原消息之前，并使用新内容。它不提供完整分支树或分支导航。
- 停止先保存取消意图，DO 立即终止上游并提交已接收尾部，再写入终态；尾部写入失败时标记失败并保留最近检查点。供应商是否及时停止计费由其服务决定。
- Worker/供应商重启或网络故障不能恢复同一 token 生成。新实例发现已经运行但失去上游连接的 DO 任务，会保留检查点并明确标记中断，供用户主动重新生成；不重复调用模型。DO 保留 14 分钟供应商超时和 15 分钟看门狗 Alarm。
- 本地断网前最后一条尚未确认提交的消息可能已在云端接受；此时保留同一 request ID 重试。离线缓存仅属于此浏览器，首次访问和登录需要联网。
- 私人空间使用一个密码、签名 HttpOnly/SameSite cookie、30 天会话、同源写入校验及登录尝试限制。修改 `SESSION_SECRET` 可使所有旧会话失效。当前退出清理本设备 cookie 和缓存，不撤销其他设备的会话。
- 原型最多 128 个会话，每个 1,000 条消息。启动生成前，完整历史 JSON 的 UTF-8 大小最多 4 MiB，SQLite 分配最多 16 MiB；为新内容、解析检查点与流式日志预留空间。流式提交超过 30 MiB 会回滚并停止，终态保存最多 32 MiB。已有历史继续可读，不自动截断或删除；生成结束清除不再使用的任务上下文。128 × 32 MiB 约为 4.295GB，是应用保留预算，其他应用仍共享账户存储额度。SQLite 已分配页不一定随日志清理缩小。
- 容量不足返回明确的 507 错误，不自动重新调用模型。同步失败保留草稿和缓存、显示“重新同步”，暂停自动重试；平台存储错误的内部诊断不会直接显示给用户。账户存储完全耗尽时可能无法写入终态，此时不发布完成确认。
- 输入最多 16,000 字，正文与思考各最多 100,000 字，原始响应最多 4 MiB，SSE 数据事件最多 256 Ki 字符。语义长度和完成状态在云端读取／最终整理时校验，原始接收阶段按字节和时间限制停止。提供给模型最近最多 40 条/80,000 字的已完成历史。输出 Token 上限仍默认不设置。暂无附件、工具调用、全局内容搜索或多用户隔离。

## 文件

- [功能实施路线图](docs/serverless-feature-roadmap.md)：Serverless 约束下的 Chatbox 功能取舍、实施顺序及阶段验收。
- `worker/`：鉴权、Hono API、持久化会话、后台生成及 AI SDK 供应商适配。
- `src/`：React 界面、离线缓存与 outbox、WebSocket 自动重连。
- `shared/`：API 数据结构及按序应用同步事件。
- `tests/`：AI SDK 流式适配单元测试、基于浏览器和真实本地运行时的集成测试。

架构依据：[Durable Objects WebSocket 休眠](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)、[Durable Objects alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)。
