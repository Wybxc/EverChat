# 开发指南

[项目首页](../README.md) · [文档索引](README.md)

## 环境与启动

需要 Node.js 22.12+（或 24+）和 pnpm 12，版本由 `package.json` 的 `packageManager` 指定。所有命令在仓库根目录执行。

```sh
pnpm install
pnpm dev
```

访问 `http://127.0.0.1:5173`，点击「重新登录」。日常开发通过网页配置供应商，无需 `.dev.vars`。依赖使用 `pnpm-lock.yaml`；`.npmrc` 将 pnpm 存储放在项目内。本地 Cloudflare 数据保存在被 Git 忽略的 `.wrangler/`，重启后保留；浏览器缓存、草稿和模型选择属于当前浏览器。

Vite 的 Node 辅助工具为每次启动生成临时 RS256 身份，只允许固定 Origin 和 loopback 访问。私钥不进入 Worker 或浏览器，Worker 仅接收公钥并复用生产 JWT 校验。重启后旧签名失效，需要重新登录。生产构建不包含本地签发入口。

开发模式不注册 Service Worker；PWA 生命周期请使用生产构建测试。`pnpm preview` 用于构建后的本地预览，不等同于完整的真实 Access 环境。

## 真实 Access 联调

需要时在本机创建被 Git 忽略的 `.dev.vars`，填写自己的配置：

```dotenv
ACCESS_TEAM_DOMAIN=your-team.cloudflareaccess.com
ACCESS_AUD=your-access-application-audience
ACCESS_ALLOWED_EMAILS=you@example.com
APP_ORIGIN=https://dev.example.com
```

```sh
pnpm dev:access
```

通过配置了固定域名和 Access 保护的命名 Tunnel 访问。Tunnel 的 Origin、Access 应用 AUD 与本机配置必须对应；此模式使用生产验证入口，不能使用日常开发 Cookie 登录。仅填写变量不会在 Cloudflare 边缘创建访问规则。部署路径配置见[自行部署](operations/self-hosting.md)。

供应商初始环境值属于可选引导配置，见[部署指南](operations/self-hosting.md#可选的初始模型配置)。网页设置与本地密钥文件均不得提交到 Git。

## 目录与配置

- `src/`：React 应用、功能模块、浏览器平台能力和 Service Worker。
- `worker/`：鉴权、HTTP API、持久化、后台生成、工具、通知、用量与分享。
- `shared/`：跨浏览器与 Worker 复用的业务契约和纯规则。
- `scripts/`：本地开发入口、测试执行器、离线运维和测量工具。
- `tests/`：单元、原生集成、浏览器和生产 PWA 测试。

项目使用 React、shadcn/ui（Base UI + Nova）、语义主题及 Tailwind CSS；Markdown 基于 Streamdown，模型协议使用 AI SDK 对应适配器。目录依赖与事务边界见[模块说明](architecture/modules.md)，数据流见[运行架构](architecture/runtime.md)。

根 `tsconfig.json` 集中公共选项和编辑器引用；`config/tsconfig.{app,worker,sw,tooling}.json` 分别检查浏览器、Worker、Service Worker 和工具／测试环境。Cloudflare 通用运行配置在 `wrangler.jsonc`，生产域名和 Access 参数在部署者自己的 Cloudflare 控制台管理；本地 Access 联调使用被忽略的 `.dev.vars`。隔离平台测量配置在 `config/wrangler.validation.jsonc`。配置整理的取舍见[配置与脚本整理记录](plans/repository-configuration-and-scripts-plan.md)。

## 格式化与检查

Prettier 配置集中在 `package.json`：单引号、分号、两空格缩进、LF、行宽 100。VS Code 安装工作区推荐的 Prettier 扩展后可保存时格式化；忽略范围由 `.prettierignore` 维护，包括缓存、产物、密钥、锁文件、生成目录和测量 JSON。

```sh
pnpm format
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` 已包含类型检查。完整检查为 `pnpm check`，依次执行单测、原生运维测试、类型检查／构建、集成与浏览器测试、PWA 测试。按改动选择必要范围，文档改动通常只需格式与链接检查。

## 测试与发布时机

测试与生产构建分别运行：

1. 开发过程中，修改后运行对应单测或浏览器场景，提交前检查格式。
2. PR 创建或更新时，GitHub Actions 的 [Tests](../.github/workflows/tests.yml) 执行格式、类型、全部单测、本地运维集成测试、完整 Chromium 集成／浏览器测试、WebKit 阅读与搜索回归，以及 Chromium／WebKit PWA 测试。各作业独立运行，同一套件内部仍串行。
3. `main` 要求通过 `Required tests` 后才允许合并 PR；分支必须包含最新的 `main`，避免只验证过时的分支。合并后 Cloudflare 使用 `pnpm build` 构建、`pnpm exec wrangler deploy` 发布。
4. 发布后检查页面加载、登录与关键交互；涉及推送、移动端或 Access 时补充真机验收。上线后的检查用于发现部署环境问题，不能替代合并前测试。

工作流也在 `main` 更新和手动触发时运行，便于复核合并结果与排查 CI。直接推送 `main` 后才启动的测试无法阻止同时开始的 Cloudflare 部署，因此发布应通过受保护的 PR 流程。新 PR 提交会取消该 PR 旧提交仍在运行的检查。

测试只使用本地 workerd、合成身份和模拟供应商，不需要生产密钥或 Cloudflare 部署令牌。浏览器失败的报告和 trace 保留 7 天。PWA 测试为安装／更新夹具生成两个构建版本，这是测试数据准备，与 Cloudflare 生产构建分开。

## 集成、浏览器与 PWA 测试

首次运行浏览器测试先安装所需浏览器：

```sh
pnpm exec playwright install chromium webkit
pnpm test:e2e
pnpm test:pwa
pnpm test:operations
```

`pnpm test:e2e` 使用独立的本地 Cloudflare 运行时、临时存储和签名夹具，覆盖真实 DO、Alarm、SQLite、WebSocket 与 Workflow。模拟供应商和联网服务不发起付费外部请求。测试服务器默认使用 5174 端口，与日常开发数据隔离；同一 Library 的设置场景串行执行。

`pnpm test:pwa` 构建两个应用版本，使用 Chromium 和 WebKit 检查安装、更新、离线和路由。静态测试服务器使用 5175，Cloudflare 静态路由对照使用 5178／5179。`pnpm test:operations` 单独验证本地维护入口、事务和补丁，不由 Playwright 重复发现。套件筛选和夹具规则见[测试说明](../tests/README.md)。

浏览器套件主要覆盖以下契约：

- 提交去重、取消、断网恢复、关闭页面后继续生成和第二设备同步。
- 四种模型协议、密钥遮蔽、模型发现、能力设置及供应商错误。
- 分支、原位编辑、删除、搜索高亮、复制与备份恢复。
- Markdown／公式／代码／图表、渲染失败后的原文回退与草稿保留。
- 工具任务恢复、固定配置、每日额度、私有续接隔离和终态清理。
- 响应式布局、焦点、对比度及生产 PWA 生命周期。

本地测试不能代替真实 Access 边缘、系统通知权限、推送网关和 Cloudflare 资源计费验证。

## 手动验收与性能测量

后台生成或同步变更可复核：生成途中断网，第二设备观察结果；原设备重连后补齐；关闭全部页面再打开；离线发送后联网，确认只创建一条提问和一个回答。PWA、通知和移动端交互还应使用实际浏览器或已安装应用验收。

资源测量统一使用 `pnpm measure`，不纳入日常完整检查。例如：

```sh
pnpm measure stream --interval 100 --output /tmp/everchat-stream-comparison.json
pnpm measure tools --scenario multi-round
```

本地测量使用临时数据库和模拟上游；Cloudflare 模式只连接显式部署的隔离验证资源。报告不记录正文或密钥，本地行数和墙钟时间不等同于平台 CPU 或账单。参数、指标定义、平台证据及清理方法见[测量入口](measurements/README.md)。

数据库格式变更通过[离线运维流程](operations/offline-storage-migration.md)执行，不在普通请求、对象构造或页面加载中自动迁移旧数据。
