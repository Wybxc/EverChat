# project

2026-10-21 · official shadcn Nova golden pairs + customized wrapper merge · migrated on `codex/base-ui-migration` from `921ec05`.

## Changed

EverChat 的交互基础层由 Radix UI 切换为 Base UI 1.9.0，shadcn 配置使用 `base-nova`。此次迁移的收益是统一当前 shadcn 的组件组合方式、状态与焦点 API，并保留既有语义主题、紧凑布局和触摸命中区域。迁移涉及较多交互细节，不能把它视为简单替换 import；包体积也没有减少。

已逐个迁移并独立提交 17 个直接依赖 Radix 的封装：button、badge、bubble、marker、attachment、checkbox、switch、progress、tabs、collapsible、tooltip、popover、dropdown-menu、dialog、alert-dialog、sheet、toast。每个组件的说明见本目录同名文档。官方 Radix Nova／Base Nova 对照源通过 shadcn CLI 获取，局部定制手动合入，未整批覆盖。

- 用原生 `render`、`useRender`、`mergeProps` 取代 Slot／asChild；链接保持正确元素类型，不生成嵌套按钮。
- 定位参数交给 Positioner；状态样式使用原生 data-open／data-closed／data-active／data-orientation。保留 Nova 外观和 EverChat 的主题、尺寸及对比度规则。
- Modal、Sheet、AlertDialog 使用原生焦点与可取消事件 API；保留输入框回焦、取消按钮初始焦点、忙碌期间阻止关闭及 IME Escape 行为。
- 修复菜单动作被延迟取消、搜索无法展开折叠思考、新供应商输入框焦点被整树重挂载打断等消费端问题。
- 自动保存改用 Base Toast manager，保留每个 store 单条提示、成功 2.5 秒消失、失败持续、初次加载不提示。更新上下文动作不会重启计时；查看错误与重试使用稳定焦点目标，避免 WebKit 丢失焦点。
- 移除直接 `radix-ui` 依赖并清理锁文件；更新当前开发文档与组件来源说明。

## Left alone

cmdk、Recharts、Streamdown／Markdown、`@shadcn/react` Message Scroller 不在迁移范围内。cmdk 的间接 `@radix-ui/react-dialog` 依赖仍保留；不能据此宣称依赖树完全没有 Radix。数据模型、Worker、同步与供应商协议均未修改。历史迁移方案保留为历史记录。

迁移工作位于独立工作树。用户随后要求调查原版 WebKit Markdown 失败，因此基于未迁移的 `921ec05` 单独提交修复 `dc28c07`、`5ade458`（[PR #1](https://github.com/Wybxc/EverChat/pull/1)），再合入迁移分支。迁移 PR 以该修复分支为前置，便于分别审查。没有合并到 main、部署或变更线上配置。

## Behavior changes

- Tabs 使用 Base 默认的手动激活：方向键移动焦点，Enter／Space 才切换面板。
- Toast 的键盘入口由 Radix 的 F8 改为 Base 的 F6；播报和计时暂停交由原生组件处理。
- Tooltip 按 focus-visible 的键盘模态打开，采用 Base UI 1.9 的视觉提示语义，不再具有旧的 tooltip role／description 关系；触发器保留相同的 aria-label。[Base 官方说明](https://base-ui.com/react/components/tooltip#usage-guidelines)要求提示只作补充视觉标签。
- 包体积有所增加，不能以减小下载量为迁移动机。为保持可复现，比较的是 dist/client 下全部 JS/CSS（含 sw.js）的逐文件 gzip 总和，不是单页面首屏传输量。

| 指标               | 原版 921ec05 |      迁移后 |                      增量 |
| ------------------ | -----------: | ----------: | ------------------------: |
| JS/CSS 文件数      |          432 |         433 |                         1 |
| JS/CSS 原始字节    |   16,342,886 |  16,456,262 |                   113,376 |
| 逐文件 gzip 字节   |    3,675,396 |   3,716,997 | 41,601（40.6 KiB，1.13%） |
| 必需预缓存项       |           12 |          13 |                         1 |
| 必需预缓存原始大小 |  1211.81 KiB | 1323.25 KiB |                111.44 KiB |

## Verify by hand

自动化验证记录：

- 最终单元测试：470／470 通过；类型检查、格式检查与 git diff --check 通过。
- Chromium 完整 E2E 首次运行 409 项；修复后针对失败与受影响用例复测，累计 408 项通过，剩余 1 项为下述已复现的基线失败。没有声称完整套件全绿。
- 迁移后的最终额外 Chromium 自动保存／预设／会话参数回归 16 项通过；视口矩阵、200% 文字与对比度 3 项通过。已检查浅色 390px 和深色 1280px 截图。
- WebKit：迁移分支最终所选 32 项首次 31 项通过，剩余窄屏阅读测量竞态经原版修复后连续复测 2／2 通过，累计 32 项全部通过。原版四项加同原因的离线恢复重复两轮 10／10 通过；边框并发挂载补充 WebKit 3／3、Chromium 1／1 通过；原版 Chromium 相关整组 9／9 通过。依赖 Chromium CDP 的三项移动手势测试不适用于 WebKit。
- 生产 PWA：54／54 通过（Chromium + WebKit），覆盖必需预缓存、按需模块缓存、离线公式／图表／代码、安装更新、双页面草稿保护、失败重试与匿名分享。

已存在的 Chromium 失败：`tests/e2e/platform/relaxed-limits.spec.ts` 的长输入／大流量测试，在消息正文与思考各 110,000 中文字符已完成后，断言 durableOffset 大于 4 MiB；实际值为 660,142。原版 main `921ec05` 独立复现同一数值，本次没有改动该测试或存储后端。

原版四项 WebKit Markdown 失败的共同原因是测试等待尚未进入视口的惰性 Mermaid 内层节点，形成等待死结；修复先滚动稳定外层容器，再等待真实 SVG，边框测量也等待异步代码块，并通过条件轮询在两类内容同时挂载时断言。仅调整测试顺序，未增加前端兼容代码或弱化断言。扩展重复运行时，未修改的流式搜索时序用例曾额外一次超时，完整单轮已通过；记录为测试不稳定性，未纳入组件迁移修改。生产构建的缓存／渲染验证已由上述 PWA 套件覆盖。

审查时重点检查：鼠标与键盘打开菜单／模型选择、设置 Tab 手动激活、搜索恢复焦点、确认框取消焦点、输入法 Escape、后台保存与错误重试、移动端侧栏／设置关闭、思考展开及搜索定位。浏览器自动化不能替代已安装 iOS／macOS PWA 的真机验收，本分支未操作生产 PWA。

直接使用 Radix 的 UI 封装剩余数：0（src/components/ui 共 28 个 TSX 封装，其中 17 个直接使用 Base UI）。
