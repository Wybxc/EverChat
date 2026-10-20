# 聊天与公开分享的 HTML 入口拆分

日期：2026-10-20。状态：已实施，完成本地与生产入口验收。

## 目标与边界

在返回 HTML 时选择聊天或分享入口，删除浏览器加载公共脚本后再按路径动态导入的分流。保留 `/`、`/c/:id` 和 `/s/:id#token` 的 URL；聊天内部继续使用 SPA 导航。分享页不初始化私有存储、登录、通知或 PWA 注册。

使用同一套 Vite 构建及公共依赖，保持 Access 的私有 API 保护、分享令牌校验和安全响应头。无需数据库迁移，也不增加历史版本兼容逻辑。静态页面分流使用 Cloudflare Assets 的站内代理，不引入额外浏览器跳转或用于选择 HTML 的 Worker 调用。

## 实施步骤

1. **入口与构建**：`index.html` 引用聊天入口，新增 `share.html` 和独立分享入口；Vite 配置两个 HTML 输入。保留加载状态、语言及主题，分享 HTML 遵守现有禁止内联脚本的 CSP。
2. **路径映射**：`public/_redirects` 将 `/s` 和 `/s/*` 以 200 代理到 `share.html`。聊天深链接继续使用 SPA 回退。本地 Vite 开发通过等价映射进入分享 HTML；直接访问分享 HTML 时也使用分享安全头。
3. **Service Worker**：聊天导航继续返回预缓存的 `index.html`；分享导航单独处理，在线请求正确的分享 HTML，访问后可缓存页面外壳，离线时只显示联网错误。分享接口及其响应内容始终不缓存。缓存的分享 HTML 版本必须和当前 SW 版本一致，避免新旧模块混用。
4. **预缓存**：只遍历聊天入口及其静态依赖，不因多入口构建将分享模块加入必需预缓存；分享资源按需缓存，避免拖慢 PWA 安装与更新。
5. **测试与交付**：验证真实 Cloudflare Assets 代理及响应头、本地开发路由、匿名分享无私有初始化、聊天深链接、离线启动与分享失败状态、跨版本 PWA 更新。运行必要检查，记录结果并提交推送。

## 验收标准

- 两个 HTML 分别引用独立的入口脚本，无浏览器按 URL 选择启动模块的逻辑。
- `/s/:id#token` 的地址、令牌及一请求全文读取保持不变；响应为 200，无 30x 跳转。
- 分享页面不请求 `/api`／`/auth`，不打开私有 IndexedDB，不注册 SW，保持 CSP、无 Referrer 与禁止索引。
- 必需预缓存不包含分享 HTML 和分享专用 JS，聊天及使用过的可选渲染模块仍能离线启动。
- 已受 SW 控制的分享页能够在更新后加载正确 HTML，不阻塞主应用更新；离线不展示历史分享正文。
- 本地与真实 Assets 运行时的路由结果一致；Chromium／WebKit 相关回归通过。

## 依据

- [Vite 多 HTML 入口](https://vite.dev/guide/build.html#multi-page-app)。
- [Cloudflare Assets 站内代理](https://developers.cloudflare.com/workers/static-assets/redirects/#proxying)：200 代理保留浏览器原 URL。

## 执行记录

### 实施结果

- 聊天入口直接由 `index.html → src/main.tsx` 启动；分享入口由 `share.html → src/share.tsx` 启动。删除 `private-bootstrap.tsx` 及浏览器按路径动态选择入口的逻辑。分享页面的文档 class、加载状态和安全元数据由独立 HTML 提供。
- Vite 的多入口只配置到 client 构建环境，避免 Cloudflare Worker 构建误读 HTML 输入。开发服务器直接转换并返回分享 HTML；仅改写请求 URL 会被 Cloudflare 插件恢复原始路径，无法正确分流。
- Cloudflare Assets 通过 `_redirects` 的 200 代理处理 `/s` 与 `/s/*`，原 URL 与片段令牌保留，无额外浏览器跳转或业务 Worker 调用。生产分享 HTML 不含可执行内联脚本，遵守现有 CSP。
- 必需预缓存从 16 项降到 12 项，只包含聊天入口及其必需依赖。分享外壳按访问缓存，并按构建版本校验和清理；分享接口与正文始终不缓存。
- SW 分别处理聊天和分享导航，直接访问 `/share.html` 也不会参加私有应用的更新保存握手。旧 SW 在线收到新 HTML 时不会将其存入旧版外壳缓存。
- 更新模块架构、自部署说明和测试复现方式。无需数据库迁移、Access 配置变更或运行时历史版本兼容逻辑。

### 验证记录

- `pnpm test`：466 项通过；`pnpm typecheck`、`pnpm build`、修改文件的 Prettier 检查及 `git diff --check` 通过。
- 本地匿名分享、完整分享链路与慢启动浏览器回归：3 项通过。
- Chromium／WebKit 的 Assets、缓存、导航、分享与 PWA 生命周期回归：41 项通过。真实本地 Assets 运行时确认分享返回正确 HTML 和安全响应头，无 30x，也未执行业务 Worker。
- 加强的分享外壳版本隔离与更新协调回归：2 项通过，覆盖两个浏览器。
- 保留改动前实际构建，安装旧版单入口 PWA，再更新到当前双入口构建：8 项通过，覆盖双标签草稿／设置保留、中断更新重试、公开分享和离线失败状态。旧版夹具仅存在于测试环境，产品代码不增加兼容分支。

### 生产入口验收

实现提交 `4b18935` 已推送，Cloudflare Workers Builds 返回成功。2026-10-20 对 `chat.wybxc.cc` 的匿名请求确认：`/s/AAAAAAAAAAAAAAAAAAAAAA` 与 `/share.html` 返回完全相同的分享 HTML，引用 `share-*.js`；首页引用独立 `app-*.js`。分享路径为 200，无浏览器跳转，保留 CSP、`no-referrer` 与禁止索引响应头；私有 `/api/session` 仍返回 302，跳转到现有 Cloudflare Access 团队登录域名。

以上生产证据只涉及静态入口与匿名访问边界，不将其等同于用户真机 PWA 验收；跨版本与离线行为的证据来自前述 Chromium／WebKit 自动化。
