# 分享页面 SSR 可行性考察

日期：2026-10-26。基于 `d99b79d` 的代码、本地现有生产构建及合成内容实验。状态：完成考察；用户已明确要求分享公开访问、首次响应包含正文。已据此确定方案，业务实现与本地验证进行中，生产尚未变更。

## 结论

可以只给分享页增加服务端 HTML 输出，聊天页继续使用现有 SPA；不需要迁移整个项目到 Next.js 或其他全栈框架。React 提供适合 Workers Web Streams 的 `renderToReadableStream`，现有 Streamdown 也已通过本地静态渲染验证。

**确定使用公开随机地址 `/s/:id`，移除额外的 `#secret` 校验。** 任何访客无需登录、cookie 或 Authorization 即可访问已发布的分享。服务端检查分享存在、已发布且未删除／过期，在首次导航响应中返回完整正文 HTML；无需先启动 React 或额外请求全文 JSON。

优先采用“发布时预渲染，访问时检查状态并流式返回 HTML”。聊天页继续使用 SPA，公开静态资源继续走 Assets，不为 SSR 建立整站同构状态层，也不优先在每次匿名访问时重新解析全文。

### 原先为什么有 secret

原方案选择“持有完整链接可读”：随机 ID 用于定位分享，额外 secret 用于证明访客持有完整链接。把它放在 fragment 中，是为了减少凭据进入初次导航 URL 日志及链接预览请求；浏览器随后仍会把它通过 Authorization 发给服务端。它不是访问者身份认证，也不是 Cloudflare Access 的要求。[原分享方案](../plans/revocable-readonly-sharing-plan.md#链接公开-api-与删除)、[MDN fragment 说明](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment)。

这是此前主动选择的访问策略，并非 SSR 或公开分享必须遵守的约束。现有分享 ID 已由 `randomBytes(16)` 生成，具有 128 bit 随机性，可直接用作不易猜测的公开地址。移除第二段 secret 后，无需再引入 `/s/:id/:secret`、cookie 交换或新一层令牌。

分享管理继续使用 Access；草稿不可公开，删除／到期后返回 404。随机地址不提供公开目录或分支枚举入口。URL 本身可被转发和链接预览服务读取，这符合本次公开分享要求；继续使用无 Referrer 和禁止索引响应头。

## 当前加载链路

```text
导航 /s/:id#secret
  → Cloudflare Assets 将 /s/* 代理到 share.html
  → 下载分享入口、静态依赖和样式
  → 执行 React 与 i18n，挂载 PublicSharePage
  → effect 从 fragment 读取 secret，发起公开 API 请求
  → Worker 验证请求，ShareStore 校验令牌、状态和到期时间
  → 一次 HTTP 响应流式返回全部 JSON 块
  → response.json() 等待全文，React 显示气泡和纯文本
  → 动态加载 Streamdown，以及需要的公式／代码／Mermaid 插件
  → 得到最终 Markdown 展示
```

相关实现：

- `share.html`、`src/share.tsx`、`public/_redirects`：分享已经具有独立 HTML 和启动入口。
- `src/features/sharing/PublicShare.tsx`：请求发生在 `useEffect`，以 `Authorization: Bearer` 携带 fragment 中的令牌；收到完整 JSON 后更新界面。
- `src/features/sharing/ShareContent.tsx`：按消息合并分块，复用聊天气泡，模型名不含供应商，思考默认折叠。
- `src/features/chat/rendering/MarkdownContent.tsx`：渲染器和可选插件在 effect 中按需加载；加载之前可显示原文。
- `worker/sharing/response.ts`：服务端已有单次全文响应和背压，没有公开分页往返；但 JSON 分块不等于浏览器已渐进显示消息。

因此，优化对象是“取数启动过晚、等待全文及客户端渲染”，不是继续合并分页。CSS 下载会影响首屏绘制，但不必成为早期取数的执行依赖。

### 本地证据与边界

本地 `dist/client/share.html` 的生成时间为 2026-10-25T08:52:16Z。其入口、HTML 声明的 modulepreload 及静态导入包含 8 个 JS 文件，合计 387,114 字节，逐文件 gzip 合计 126,866 字节；共享 CSS 为 185,639 字节，gzip 为 33,591 字节。总计约 **157 KiB gzip**，尚不包含随后按需加载的 Markdown 和插件。

这说明提前取数和减少阅读页启动依赖值得验证；文件大小不是实际网络瀑布或 LCP 测量，也不意味着必须等待这些字节全部下载才可发请求。访客缓存、Brotli、网络延迟和浏览器执行时间均会影响结果，当前不声称能快几秒。

本地 Node 合成实验直接以 `Streamdown mode="static"`、`remark-breaks` 和 math 插件渲染：

- 标题、表格、代码、公式与软换行可以输出 HTML；`renderToReadableStream` 可返回可读 HTML 流。
- 约 108 字符的混合样例首次渲染 27.27 ms，随后 5 次约 1.87–2.61 ms。
- 将样例重复 20 次，约 2.2 千字符、输出约 63 KB HTML，热渲染约 14.72–17.41 ms。

上述时间是本机 Node 的墙钟时间，不是 workerd CPU，也不是完整分享页、语法高亮或 Mermaid 的成本。已有 `tests/unit/rendering/markdown-math.test.ts` 同样在服务端静态渲染 Streamdown，可继续作为 Markdown 语义基础。

## 方案比较

| 方案                               | 首次导航包含正文 | 浏览器额外正文请求 | 结论                             |
| ---------------------------------- | ---------------- | ------------------ | -------------------------------- |
| 小启动脚本立即取数，与 UI 加载并行 | 否               | 1 次               | 不满足本次要求，不实施为主路线   |
| 公开随机地址 + 每次访问动态 SSR    | 是               | 无                 | 可行，但访客每次读取都要重新渲染 |
| 公开随机地址 + 发布时预渲染        | 是               | 无                 | 推荐；将渲染成本放到低频发布阶段 |

这里的“预渲染”是服务端生成 HTML，公开读取时检查分享状态。为了保留删除和到期立即停止新读取的行为，正文响应使用 no-store，不让公开 Assets、CDN 或 SW 绕过状态检查；不需要访客提供额外凭据。[React 流式 HTML 输出](https://react.dev/reference/react-dom/server/renderToReadableStream)。

## Cloudflare 免费层下的处理位置

普通 Workers Free HTTP 请求为 10 ms CPU、128 MB 内存；网络等待不计入 CPU。SSR、Markdown、公式及高亮的实际计算都需要计入，流式响应不会重置 CPU 预算。静态 Assets 请求免费且不限次数，匹配 `run_worker_first` 的请求则进入动态请求额度。[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[Assets 计费](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)。

**DO 不能直接套用入口 Worker 的 10 ms 结论。** 官方为 DO 列出了默认 30 秒的调用 CPU 窗口，确实可以把渲染放到 DO；仍须评估免费请求、计算时长、内存和存储，而不是据此认定 SSR 无法实现。[DO 限制](https://developers.cloudflare.com/durable-objects/platform/limits/)。

本项目当前所有分享使用一个 `personal` ShareStore。在它里面对每次匿名读取同步解析全文，会让昂贵计算集中到同一个对象，干扰其他分享读取和删除。更合理的是：

1. 在所有者创建／发布分享时完成渲染，放在 DO 侧或经过测量的渲染任务中，入口 Worker 只转发。
2. 按完整消息或 Markdown 语法完整的单元渲染；现有 16,384 字符传输块不是 Markdown 边界，不能逐块分别解析。
3. 访客读取只做一次分享状态检查，按背压输出已生成的 HTML。
4. HTML 为派生数据，测量相对原始文本的存储放大；按块保存，不能假定全文能放进单个 SQL 行。不为 SSR 重复保存私有完整 Message 或原对话。

当前有效分享本来就会发起一次动态 API 读取。将它变成一次公开 HTML 导航，不必增加每个正常访客的动态读取次数；无效导航也会进入动态额度。采用渲染 HTML 再额外抓取相同 JSON 的设计才会重复读取，应避免。

## 实施范围建议

### A：公开文档入口与权限简化

- 公开阅读地址固定为 `/s/:id`，复用现有随机分享 ID；移除前端 fragment 读取及公开读取的 Bearer token 要求。
- 只对分享路径设置 Worker-first，替换对应静态代理，首次请求直接进入 ShareStore 状态检查和 HTML 输出。聊天与公共静态资源保持原路由，Access 继续保护 `/api`／`/auth`。
- 文档入口允许来自外部网站的顶层 GET 导航；不能照搬现有 JSON API 的 `Sec-Fetch-Site: cross-site` 拒绝规则。未知、草稿、已删除和过期分享返回统一 404，HEAD 使用相同状态规则且不返回正文。
- 删除、过期和返回前台的可用性检查继续保留，它们属于分享生命周期管理，不需要新增访客身份或会话。

删除／到期停止后续读取，已下载的内容不承诺收回。管理入口、原始私有对话和其他分支的权限保持不变。

### B：发布时预渲染与浏览器增强

从 `ShareContent` 拆出只接收公开 DTO、locale 和渲染选项的展示层，复用现有 Message／Bubble／Trace、语义色和排版。主题模块当前在顶层访问 `window.matchMedia`，本地 Node 导入报 `window is not defined`；Markdown 包装也依赖 effect、`navigator`、`location`，不能原样导入 Worker。服务端直接使用静态渲染器，客户端只增强必要交互。

- 正文、表格、软换行与常见公式在服务端生成可读 HTML。代码先有可读 `pre/code`，高亮和 Mermaid 可延迟增强；不能因为插件未加载而阻塞正文。
- 思考默认折叠但可访问，模型名仍不含供应商；长提问可展开。复制、图片点击加载、主题／语言切换继续工作。
- 服务端 UI 使用请求级 i18n 实例，避免并发访客互相修改全局语言；首屏主题采用可服务端输出的 CSS／稳定默认值，浏览器偏好增强避免 hydration mismatch。
- 优先减少需要 hydrate 的范围；如果整棵 React 树 hydrate，必须提供与 HTML 一致的初始数据，且不再重复 fetch。HTML 和完整 JSON 双份传输也可能抵消收益。
- 派生记录沿用快照 hash，以 ShareStore schema 2 标记渲染结构版本，删除／过期时与快照一起清除；发布完成前保证 HTML 完整。旧分享如需派生内容，通过本地维护脚本离线生成，不在访问时自动迁移或补渲染。

页面主内容通过导航的 HTML Response 输出，浏览器可边接收边解析；不使用客户端 fetch HTML 后再插入的两阶段加载。JS 关闭时应能阅读正文，开启 JS 后只加载必要交互和可选插件。

### C：清理旧机制、离线准备与 SW

- 删除每条分享的 `tokenHash`／`tokenCipher` 生成、读取和校验，以及仅服务于这套机制的加解密逻辑与 `SHARE_LINK_KEY` 配置。表结构变更和现有快照的预渲染通过本地运维脚本离线完成，逐项确认后发布，不增加匿名访问时的回填逻辑。
- 继续保留现有分享 ID，旧链接里的 `#secret` 由浏览器忽略即可进入相同公开页面；无需旧令牌校验或运行时兼容分支。离线处理只公开原本 active 且未过期的分享，草稿与失效链接不恢复。
- 公开页不再额外获取同一份完整 JSON；剩余状态查询只返回生命周期所需的最小数据。私有预览仍可使用既有结构化快照。

- CSP、响应安全头必须由动态响应直接设置，不能只依赖静态 `_headers`。不得为方便 React 流式脚本而全局开启 `unsafe-inline`；需要时使用 nonce 或无执行脚本的 HTML 输出。
- 当前根 SW 对分享导航主动取 `/share.html`，会吞掉动态导航收益。改为请求原始分享 URL并保留流，不缓存正文；离线只显示无正文外壳及联网提示。不能把含正文的文档继续写入现有 share shell cache。
- 浏览器返回缓存、恢复前台时依然核验可用状态；到期清屏。每次新导航均检查分享状态。

这是独立的分享链路改造，不引入在线旧链接兼容层。动态路由、派生 HTML、数据结构和新版 SW 需作为同一发布方案验收。

## 验收

采用同一组无私人信息的短对话、长对话、长思考、公式、表格、代码和图表，在 Chromium／WebKit 分别比较冷缓存、热缓存及高延迟网络：

- 记录 TTFB、首条实际正文可见时间、LCP、全文可见时间、首屏 JS／CSS 字节和请求瀑布；加载提示的 FCP 不能代表正文首屏。
- 对比普通读取、实时 SSR、预渲染读取的 workerd／平台 CPU、DO 时长、行读取、存储放大与并发阻塞。当前 Node 实验不能代替平台结果。
- 核对零重复正文请求、一个文档滚动条、深浅色及字号一致、思考折叠、图片不自动外连、公式／换行语义一致。
- 新访客不带 cookie、Authorization 或 fragment 即可在首次 HTML 中读到已发布正文，关闭 JS 仍可阅读；草稿、未知、过期和已删除分享不可读，私有管理 API 仍须 Access。
- 恢复前台和缓存返回不绕过状态检查；静态缓存和离线存储没有分享正文；离线迁移不改变现有 active 分享的 ID 和内容，不复活失效记录。
- 对服务端 HTML进行与现有公开 Markdown 同等级的 HTML／URL 清理。服务端拼接不绕过 sanitize，不把用户字符串插入可执行脚本或属性，复用当前公开内容限制。

产品方向已经确定：公开随机地址、首次 HTML 含正文、无独立访客鉴权，采用发布时预渲染。实现和发布证据见后续验收记录。
