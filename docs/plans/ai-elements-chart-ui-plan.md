# AI Elements 与 Chart 界面优化方案

日期：2026-10-20。状态：P0–P4 完成；P5 自动化完成，本轮真机验收待确认。代码基线：`fc2a1b6`。进度与验证见 [实施记录](../measurements/ai-elements-chart-2026-10-20.md)。

目标：采用 shadcn/ui 官方 AI Elements 组合模式和 Chart 组件，统一消息、思考／联网过程、输入区与用量图表的表现，减少自制展示结构与重复样式。延续 EverChat 的紧凑布局、初音未来主题色、必要文案和移动端交互。

本方案是[原 shadcn/ui 迁移](shadcn-ui-migration-plan.md)的后续优化，现行[前端设计规范](../architecture/frontend-design-standard.md)继续有效。

## 1. 选型结论与调研边界

采用 **shadcn/ui 官方注册表的 Radix 版本**，继续使用 `radix-nova`、React SPA、Tailwind CSS、Lucide、Recharts 和 Streamdown。

当前官方 [AI Elements](https://ui.shadcn.com/docs/ai-elements) 是可复制到项目的组件组合模式：Chat 由 Message Scroller 与 Message 组成；Reasoning、Tool、Sources 等使用 Trace。实施应安装实际需要的基础组件，再在业务模块中组合，不照搬示例应用的生成、持久化和消息状态管理。该入口也列出了旧 `elements.ai-sdk.dev` 组件与当前组合模式的对应关系。

[Chart](https://ui.shadcn.com/docs/components/radix/chart) 与 Recharts 组合使用，提供图表配置、主题、提示框和图例。EverChat 已使用 Recharts 3.10，因此主要收益是统一这些公共展示能力，不需要另换图表引擎。

规划时已读取本地 shadcn skill、`components.json`、组件与业务源码，并核对官方文档。尝试用 `pnpm dlx shadcn@latest` 查询 `info`、`docs`，CLI 解析版本为 4.22.1，但访问官方 `r/index.json` 连接超时，代理重试也未成功。规划阶段以官方文档为 API 依据。实施时已恢复 CLI 注册表访问并完成 Radix 文件、依赖和差异检查，见实施记录。

本轮范围不包含 Base UI 迁移、生成协议或数据库重构。AI Elements 展示已有思考与工具数据，不新增 Agent、MCP、知识库等功能；也不引入在线数据迁移或旧组件兼容层。

## 2. 现状与替换映射

| 区域           | 当前实现                                                                        | 采用的官方组件／模式                                                                                                                          | 保留的 EverChat 行为                                                             |
| -------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 消息布局       | `MessageView.tsx`、`UserMessageBubble.tsx` 手动组织 article、标题、气泡和操作区 | [Message](https://ui.shadcn.com/docs/components/radix/message) + Bubble，组合消息头、正文和操作                                               | 用户右对齐气泡、开放式回答、模型／供应商名、顶层编辑、生成概览和字数、长提问折叠 |
| 思考与工具     | `ReasoningContent.tsx`、`ToolActivity.tsx` 使用 Disclosure、Badge 与自制行      | [Trace](https://ui.shadcn.com/docs/components/radix/trace)，按 Reasoning／Tool／Sources 模式组合                                              | `reasoningBlocks()` 的执行顺序、流式 Markdown、来源正文、失败定位与状态恢复      |
| 输入框         | `App.tsx` 内的 form、Textarea、附件预览和一行工具栏                             | [Prompt Input](https://ui.shadcn.com/docs/ai-elements/radix/prompt-input)：InputGroup、InputGroupTextarea、InputGroupAddon、按钮与 Attachment | 草稿、离线排队、发送／停止、IME、手机换行、上下键历史、粘贴／拖放与 PDF 选择     |
| 模型与思考强度 | `ModelPicker.tsx` 的 Popover + Command；`ComposerParameters.tsx`                | 采用 Model Selector 的工具栏组合方式，保留可搜索的 Command 选择器                                                                             | 供应商分组、同名模型区分、模型记忆、能力判断、选择后焦点                         |
| 上下文用量     | `ContextEstimate.tsx` 显示约数与 Popover 明细                                   | [Context](https://ui.shadcn.com/docs/ai-elements/radix/context) 的紧凑占用提示 + Progress + 明细                                              | 当前预算算法、估算标记、窗口来源、输出预留、附件／摘要拆分和超额提示             |
| 附件           | `DocumentPreviews.tsx`、`ImagePreviews.tsx` 和上传进度                          | Attachment／AttachmentGroup 组织文件条目和状态                                                                                                | 图片预览、移除、上传取消、PDF 页码／片段、上下文预算和错误                       |
| 历史压缩       | `SummaryView.tsx` 与对话中的压缩分界                                            | Marker 表示分界，Message 承载摘要正文                                                                                                         | 摘要作为正式消息、覆盖范围、生成信息、重新生成和后续始终使用摘要的语义           |
| 公开分享       | `ShareContent.tsx` 单独组合气泡、标题和 details                                 | 与私有页共享纯展示的 Message／Bubble／思考组合                                                                                                | 全文加载、思考默认折叠、仅模型名、匿名只读、原有内容安全策略                     |
| 趋势图         | `UsageChart.tsx` 直接使用 ResponsiveContainer、Tooltip、LineChart、Brush        | ChartContainer、ChartConfig、ChartTooltipContent，按需使用 ChartLegendContent                                                                 | 折线、点击／键盘查看、小时／日、指标切换、范围选择、币种和精确金额               |

规划时 `src/components/ui/input-group.tsx` 只导出 Group 与 Addon。实施已通过 CLI 差异检查补全 InputGroupTextarea 与 InputGroupButton，并保留密钥输入框等现有调用与本地控件尺寸；没有覆盖整个文件。

## 3. 聊天界面的目标表现

### 消息、操作与分享

继续保持用户气泡与开放式回答，不套多层 Card。模型和供应商标题、生成状态使用紧凑消息头；字数、Token 和耗时等简略生成信息放在回答底部，与消息操作并排；编辑、复制、重新生成和分支切换按现有优先级排列，低频操作留在菜单。编辑文本框仍在消息原位置，字号与正文一致。

Message／Bubble 只负责视觉和组合。分支仍由当前消息树、`useConversationBranches` 和 BranchSwitcher 管理，URL 的 `branch` 参数及“切到旧版本显示旧后续消息”的语义不变，不以示例中的本地版本数组代替。

私有页和分享页只共享纯展示组件。公开入口不导入 App、session、私有 API、编辑／重试动作或统计模块，继续保持双 HTML 入口的依赖边界。分享页只显示模型名，思考默认折叠；私有页沿用当前默认展开与用户手动选择。组件库示例的自动折叠不作为本轮交互变更。

### 思考、联网与错误

以一组连续的 Trace 行展示已有过程，仍按 `reasoningBlocks()` 返回的顺序交错显示思考、搜索和网页读取。思考正文继续用 MarkdownContent 流式渲染；不把搜索统一挪到全部思考之后，也不凭空生成“思考摘要”或步骤。

- 进行中的行只显示必要状态、查询／网址；有可查看内容后再提供展开操作。
- 成功行展示简短结果和来源数；来源列表按需展开，不默认增加网站 Logo、远程 favicon 或大卡片。
- 每轮工具保留自己的 ID、输入、来源和结果，不能为视觉去重而丢失执行记录。单个来源列表内可合并重复 URL，不改动底层数据。
- 状态显式映射到 Trace 的 running／pending／error／完成态，不把业务状态字符串直接传入组件。
- 工具错误折叠后仍可见，并能展开和定位对应调用；供应商错误保留阶段、HTTP 状态、响应正文和重试信息。两者是不同故障时分别展示，同一故障只保留一份用户可见摘要。
- 当前 `ToolFailures` 通过 `HTMLDetailsElement` 展开并定位调用。改为 TraceCollapsible 时必须同时改成受控展开状态和稳定 ID，覆盖祖先展开、焦点和暂停跟随；不能只替换 JSX。

已有 `web-tool-ui.spec.ts` 的“一条可见错误”用例在基线中失败，见[现状记录](../architecture/frontend-design-standard.md#自动保存提示2026-10-20)。本阶段应先核对工具错误和供应商错误的关联关系，再修复同一故障的重复展示并恢复该断言，不能为迁移放宽测试。

工具原始输入／输出需要代码式查看时再使用 CodeBlock；Markdown 围栏代码继续由现有 Streamdown 插件处理，避免两套高亮器、两层外框和重复复制按钮。

### 输入、模型、附件与上下文

输入区使用一个 InputGroup 表面，附件区与工具栏作为同组内容，避免 Group 和旧 `.chat-composer` 同时画边框。主输入框保持单实例；从 App 提取展示组合时传入当前状态和回调，不复制一套草稿或提交逻辑。

工具区仍压缩为一行：附件、模型、联网、思考／参数、上下文、发送／停止。窄屏沿用当前响应式收纳；模型名省略时保留完整可访问名称和供应商身份。模型多时保留 Command 搜索，不照搬官方示例中仅列几个选项的菜单。

手机 Enter 换行、桌面 Enter 发送／Shift+Enter 换行、IME 确认键、未修改输入的上下键历史、Mod+J／Mod+K 和选模型后焦点行为都保留。触屏输入仍至少 16 CSS px；组件内置键盘示例不能覆盖项目的设备与输入法处理。

Attachment 接收已有上传／处理／失败状态，不新增一条上传链路。文件选择、拖放、粘贴、PDF 全文提取和页码选择继续走当前附件模块。

上下文入口只显示紧凑环形指示，Token 数和百分比放入点击后打开的详情；低于 0.01% 的正占用在详情中显示 `<0.01%`。轨道与占用色均需在深色和浅色表面保持至少 3:1 的对比度。分母、明细和警告沿用现有输入预算／模型窗口口径，并注明估算，不能把上次供应商实际 usage 当成下一次请求的估算。模型窗口未知时不显示伪精确比例。桌面可借鉴 HoverCard 的快速查看，但触屏和键盘必须仍能通过点击／Popover 查看完整明细。

### Markdown 不随外壳迁移

继续使用 MarkdownContent：保留软换行、公式规范化、KaTeX、Mermaid、代码高亮、表格直接渲染、按需加载、加载失败纯文本降级、搜索标记及分享页外链／图片策略。新组件不绕开该入口，不增加第二套 Markdown 解析器。

## 4. Chart 的具体优化

### 首批：统一现有趋势图

用 ChartContainer 代替当前 ResponsiveContainer 所在的外壳，避免嵌套两套响应式容器。保持明确的高度或最小高度，验证设置弹窗首次打开、隐藏 Tab 重新显示和移动横屏时的测量。

ChartConfig 统一系列名称与颜色；名称来自当前 i18n，金额与日期继续使用项目的 formatAmount、formatNumber、formatDateTime。ChartTooltipContent 替代当前手写 `contentStyle`，精确费用读取原始金额字符串，不以绘图使用的 Number 值作为金额展示依据。

趋势保持折线与线性连接；缺测不伪装为零值。请求数、Token、费用分别切换，不把不同量纲塞进同一个纵轴。Token 指标可显示输入／输出两条线并提供图例；请求数与单币种费用使用单系列。保留现有 Brush 的范围选择、触屏点选和键盘查看。

在 `src/style.css` 中按浅／深色配置图表语义 Token，首条曲线采用与现有青绿色协调且满足对比度的颜色。多系列配合图例、线型或点形区分，不只依赖颜色。坐标、网格与提示框使用 border、muted-foreground、popover 等语义色；不复制示例里的默认品牌配色。

### 第二批：供应商／模型比较

在供应商与模型 Tab 内，用现有 `UsageReport.providers`／`models` 聚合数据增加紧凑的横向条形图，表格继续提供精确数据。默认按请求数比较，可切换 Token 或某一币种费用；长名称保留完整提示，模型身份包含供应商。

默认显示前 8 项和“其他”，完整列表仍在表格中；切换指标重新排序。不混加不同币种、不做隐式汇率换算，不以 0 代替未定价；“其他”使用原始聚合值计算，避免浮点金额累加。行数不足时不增加装饰性的空图。

本轮复用当前 report 响应，不新增分组时间序列 API，也不声称已支持同屏比较各供应商的历史曲线。统计保持只读，不恢复已移除的历史补算、金额修正或缺失数据维护入口。

## 5. 滚动单独替换与验收

[Message Scroller](https://ui.shadcn.com/docs/components/base/message-scroller) 提供跟随输出、消息锚定、历史加载和按消息 ID 跳转；底层能力来自 [`@shadcn/react`](https://ui.shadcn.com/docs/react/message-scroller)。它适合替换当前 `useFollowScroll` 的通用滚动职责，但是否覆盖 EverChat 的全部行为必须通过本地对照确认。

实施规则：

1. 每个消息、摘要、标记、加载历史行都有稳定的 MessageScrollerItem ID；只挂载当前分支可见路径，不把全部分支放入组件内部切换。
2. 显式配置自动跟随与初次打开位置，先保持当前打开到底部的行为。只有用户在底部跟随或主动选择到底部时继续跟随；阅读、选择文字、搜索定位、切分支和编辑时不强拉到底部。
3. 顶部／底部通过 scroller 的滚动命令完成；上一条／下一条回答仍由业务层筛选有效 assistant 消息，再按 ID 跳转。保留四按钮按需出现、键盘可达、平滑动画、手动打断与 reduced-motion。
4. 搜索、通知、URL 定位、加载旧消息以及分支高度改变都接到同一滚动控制入口；不用两个 observer 或两套 scrollTop 写入争夺主视口。库命令未覆盖的定位与焦点策略保留在小范围业务适配中。
5. 思考内部的独立滚动区域单独验证。如使用第二个 MessageScroller，必须有独立 Provider，不能让思考跟随操作驱动主对话。先用 fixture 验证纯思考与交错工具行的尺寸和定位，不直接假定主视口配置适用。
6. [WebKit 流式结束问题](../measurements/webkit-stream-completion-scroll-2026-10-18.md)来自 Streamdown 模式切换时替换 DOM，不能假定换容器就会消失。保留 MarkdownBoundary 的滚动恢复，只有无恢复逻辑的隔离对照在正文／思考、完成／失败／取消场景都通过，才可删除相应修复；还需验证它与新 scroller 不冲突。

通过后删除被覆盖的 `useFollowScroll`、分支锚点和导航几何计算；仅删除已被库实际覆盖的部分。过渡实验在本地完成，不上线双滚动引擎、长期 feature flag 或旧组件兼容代码。若某个关键场景无法通过，将滚动替换明确保留为未完成，其他展示优化可独立交付。

## 6. 模块、加载与平台预算

基础组件放 `src/components/ui/`；EverChat 组合留在 `features/chat`、`features/web-tools`、`features/attachments`、`features/usage`。公开／私有共用的消息表面仅接收展示数据，不通过复用整个 MessageView 把私有业务带入分享包。避免为每个官方 pattern 再造一个转发全部 props 的空包装层。

安装按需进行：先检查 ui 目录和 CLI 差异，再增加 Chart、Message、Bubble、Trace、Attachment、Marker、Message Scroller 等缺少的组件。已有 InputGroup、Button、Popover、Command、Progress 等优先复用；本地变体与控件尺寸通过差异合并保留，不使用 `--overwrite`。新增依赖以锁文件和构建实测为准，不为示例的 `useChat` 安装或接管业务传输。

图表只随用量模块加载。Markdown 插件继续按需加载，新的聊天／图表模块不扩入必需预缓存；实施时核对构建依赖图、主入口／分享入口产物、SW 预缓存清单和已访问后的离线缓存行为。注册表 CLI 可下载工具到本机，不表示组件应在运行时从注册表加载。

本轮没有新增 Cloudflare 查询、轮询、事件持久化、生成 checkpoint 或附件副本；图表和折叠状态只使用客户端展示状态。实际验收应对照迁移前后的请求与订阅次数，确认新增纯 UI 交互没有触发模型调用或网络统计刷新。Workers Free 的预算与现有生成架构保持不变。

## 7. 实施顺序与交付门槛

2026-10-21：P1–P3 已分阶段发布；P4 已由 Message Scroller 接管通用滚动职责，删除旧跟随 hook、导航动画和分支补白。P5 的清理、类型检查、生产构建和 54 项 PWA 自动化通过。浏览器调试与复验、产物差异详见实施记录。目标仍保留本轮发布后的 iOS／macOS PWA 真机验收，不能以自动化代替。

| 阶段           | 工作                                                                                                         | 完成条件                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| P0：来源与基线 | 恢复 CLI 注册表访问；核对 Radix 文件、依赖与差异；记录截图、产物大小、请求数；搭建 Message Scroller 隔离对照 | 确认实际可安装 API 与本地变体；滚动差异有复现记录，未通过场景明确列出              |
| P1：用量 Chart | 接入 chart；统一现有折线、主题、Tooltip／Legend，再增加供应商／模型条形比较                                  | 金额、币种、过滤、时间、范围选择、键盘与触屏回归通过；表格与图一致                 |
| P2：消息与过程 | Message／Bubble、Trace、Marker；分享纯展示复用；完善错误去重和受控展开定位                                   | 分支、原位编辑、长消息、生成信息、思考／工具顺序、失败定位、分享匿名边界均通过     |
| P3：输入与预算 | 提取输入组合，补全 InputGroup，统一 Attachment 和 Context 展示                                               | 草稿、焦点、IME、手机换行、历史上下键、拖放／粘贴／PDF、发送／停止和单行工具栏通过 |
| P4：滚动接管   | 用 Message Scroller 替换已验证的滚动职责，整合四按钮和定位                                                   | 第 5 节全部关键场景在 Chromium／WebKit 通过；删除已覆盖逻辑，不增加长期兼容层      |
| P5：收尾       | 清理未引用代码和样式；完善 i18n、PWA、视觉与真实设备验收                                                     | 所有修改形成可运行提交；每阶段及时提交推送；生产与真机结果单独记录                 |

P1–P3 不依赖更换生成链路，也不以 P4 尚未完成为由重写后端。每阶段合并时保持页面可用，不先合入无法交互的空外壳。

## 8. 验收清单

扩展现有有行为价值的测试，不为组件 props 转发或颜色类名编写镜像测试。

| 范围       | 复用入口与关键断言                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 图表       | `tests/e2e/usage/usage.spec.ts`：保留折线、Tooltip、键盘、触屏和 Brush 断言；增加多系列、币种、空数据、Top 8／其他一致性；统计 Tab 保持横排且深色无额外底色                    |
| 消息／版本 | `chat/conversation-branches.spec.ts`、`chat/regeneration-model.spec.ts`、`chat/presets-and-long-messages.spec.ts`：版本与后续路径、当前模型重新生成、长提问、编辑和焦点        |
| 思考／工具 | `web-tools/web-tool-ui.spec.ts`、`tests/unit/web-tools/reasoning-flow.test.ts`：流式交错顺序、空思考、只有工具、多轮、取消／失败、持久化恢复和同一错误不重复                   |
| 输入       | `chat/composer-layout.spec.ts`、`chat/composer-navigation.spec.ts`、`settings/model-picker.spec.ts`、附件测试：IME、上下键、联网／思考强度、同名模型、焦点、软键盘、拖放和 PDF |
| 导航／滚动 | `chat/reading-navigation.spec.ts`、现有流式与 WebKit 回归：跟随／暂停、四按钮出现策略、动画中断、搜索与通知定位、版本锚点、正文／思考生成结束位置                              |
| 渲染／分享 | `accessibility/math-rendering.spec.ts`、`sharing/sharing.spec.ts`：软换行、公式、宽表、代码／Mermaid 按需加载；分享思考折叠、模型名与单一页面滚动；匿名访问不请求私有 API      |
| PWA／加载  | 现有 `pnpm test:pwa`：新版本更新、按需资源缓存、离线启动、访问后可用模块、分享 HTML 与私有入口隔离                                                                             |

浏览器回归重点是 320／390／768／1280px 与窄屏横屏、浅／深／系统主题、200% 字号、键盘和触屏。控件保留现行 32／44 CSS px 规则；普通文字 4.5:1，必要图形与边界 3:1，曲线不能只靠低对比度品牌色区分。沿用正文行距、紧凑动作间距及不透明浮层，避免默认示例的大卡片和多层边框。

每阶段执行相应测试、`pnpm typecheck`、生产构建、修改文件格式与差异检查；结束时执行关联的完整回归并记录结果。用合成 fixture 和模拟供应商，不为 UI 验收发送计费模型请求。新界面的 iOS／macOS PWA 软键盘、滚动、后台恢复与真实更新需要重新验收，不把历史真机结果或 WebKit 自动化结果当成本轮通过证据。

## 9. 官方参考

- [AI Elements 总览与旧组件对照](https://ui.shadcn.com/docs/ai-elements)
- [Chat](https://ui.shadcn.com/docs/ai-elements/radix/chat)、[Message](https://ui.shadcn.com/docs/ai-elements/radix/message)、[Message Scroller](https://ui.shadcn.com/docs/components/base/message-scroller)
- [Reasoning](https://ui.shadcn.com/docs/ai-elements/radix/reasoning)、[Tool](https://ui.shadcn.com/docs/ai-elements/radix/tool)、[Sources](https://ui.shadcn.com/docs/ai-elements/radix/sources)
- [Prompt Input](https://ui.shadcn.com/docs/ai-elements/radix/prompt-input)、[Model Selector](https://ui.shadcn.com/docs/ai-elements/radix/model-selector)、[Context](https://ui.shadcn.com/docs/ai-elements/radix/context)
- [Chart（Radix）](https://ui.shadcn.com/docs/components/radix/chart)、[图表示例](https://ui.shadcn.com/charts)

Message Scroller 的通用行为与底层 API 文档可用于调研；真正添加组件时仍按当前 `components.json` 选择 Radix 版本，不顺着文档默认的 Base UI 入口切换项目基底。
