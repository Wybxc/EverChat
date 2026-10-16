# EverChat 项目目录与模块整理计划

日期：2026-10-16。调研基线：`0c7b8c9`。状态：实施中；进度与验证见第 11 节。

## 1. 结论与目标

保留单仓库、单应用及客户端／Worker 的运行环境边界，在各环境内部按业务划分模块。同一功能的组件、状态、规则和测试应有明确归属；跨环境真正共用的契约和纯逻辑留在 shared。

当前最需要处理的是大入口混合职责、业务文件平铺、公共类型入口承载执行逻辑，以及测试按历史改版分组。没有证据表明项目存在大量可直接删除的业务模块或整套无用测试；应区分删除、取消导出、归位和合并。

完成后应达到：

- 修改聊天、供应商、附件等功能时，可以在所属模块内找到主要实现与测试。
- App 负责页面装配；HTTP 入口负责路由与中间件装配；DO 负责自己的生命周期、事务和任务协调。
- 数据契约不隐式携带分支算法、供应商解析器等执行逻辑。
- 删除确认无用的代码；重复测试只在等价断言已被保留时合并。
- 移动测试后不会漏跑；测试代码及测试运行入口进入对应的类型检查。

原型阶段直接修改导入路径和内部接口，不保留旧路径转发文件、兼容导出或旧模块别名。整理不附带业务功能、视觉、数据库格式或流式协议的改造。

## 2. 调研范围与现状

本轮检查了版本控制中的源码、静态及字面量动态导入、Worker URL 入口、配置、脚本、测试目录及主要大文件。统计为 TS／TSX 源文件，行数约值，含空行。

| 范围 | 文件数 | 行数 | 主要问题 |
|---|---:|---:|---|
| src | 72 | 5,409 | 业务组件、浏览器基础设施及应用装配平铺 |
| worker | 32 | 4,409 | 两个 DO 和 HTTP 入口聚合大量业务职责 |
| shared | 33 | 5,904 | 类型、算法、协议、生成数据、测量支持混放 |
| scripts | 11 | 1,101 | 模型目录维护与多类测量脚本混放 |
| tests | 94 | 12,565 | 单测、端到端、PWA、夹具与平台测量入口混合 |

shared 中约 3,838 行来自自动生成的模型目录快照，不能把目录体积直接当作复杂度或无用代码。

### 2.1 需要拆分的入口

| 当前文件 | 规模 | 混合的职责 |
|---|---|---|
| [src/App.tsx](../src/App.tsx) | 约 1,011 行，57 个本地依赖 | 登录、会话与草稿、outbox 投递、附件准备、分支、搜索、备份、弹窗、Markdown、消息和输入区 |
| [worker/conversation.ts](../worker/conversation.ts) | 约 1,103 行，32 个本地依赖 | 消息读写、提交／修订／删除、摘要依赖、模型执行、联网任务协调、WebSocket、搜索同步、Alarm |
| [worker/library.ts](../worker/library.ts) | 约 591 行 | 对话索引、供应商与通用设置、登录限流、搜索、附件、复制、导入与清理调度 |
| [worker/index.ts](../worker/index.ts) | 约 447 行 | API 装配、请求 schema、权限检查和各业务路由 |
| [src/ProviderSettings.tsx](../src/ProviderSettings.tsx) | 约 362 行 | 设置 Tab 容器、供应商管理、模型编辑、能力测试、自动保存与密钥显示 |
| [tests/fixtures/worker.ts](../tests/fixtures/worker.ts) | 约 802 行 | 测试 DO、数据构造、控制接口、故障注入、供应商与工具模拟 |

### 2.2 依赖边界

- 本地导入扫描未发现 src、worker、shared 之间违反运行环境方向的引用，也未发现排除类型引用后的静态运行时循环依赖。这些已有边界应保留。
- [shared/types.ts](../shared/types.ts) 被 118 个模块引用，同时包含 Message、供应商与模型、会话、同步契约，以及 branchPath、applyChange、appendMessage。导入一个名称的入口同时承担了多个领域职责。
- 包含类型引用的依赖图出现较大的相互引用集合。不能把这些统称为运行时循环；应先拆开契约和执行逻辑，再缩小不必要的跨域引用。
- [shared/markdown-math.ts](../shared/markdown-math.ts) 属于消息呈现逻辑，应与 Markdown 渲染归位。
- shared/tool-measurements.ts、shared/tool-validation.ts 不在生产入口的可达图中，但被测量脚本及测试使用，应迁入工具支持模块，不能删除。

### 2.3 测试与检查基线

- 本轮 `pnpm test`：316 项通过，来自 42 个单测文件。
- 本轮 `pnpm typecheck`：通过。
- 端到端清单：286 项／37 个文件；PWA 清单：3 项／3 个文件。本轮仅枚举，未运行完整浏览器测试。
- 额外启用 noUnusedLocals／noUnusedParameters：客户端通过；Worker 发现 index.ts 中一个未使用的 messageAttachments 导入。
- 当前三个 tsc 配置没有直接纳入 tests、Playwright 配置和测试 Worker 入口；执行测试时的 TS 转译不能替代类型检查。
- `pnpm test` 使用 `tests/*.test.ts` 平铺匹配，移动到子目录后必须同步调整发现规则，防止测试悄然消失。

## 3. 模块边界规则

1. **优先按业务聚合。** 聊天、供应商、附件、备份、搜索等各自拥有实现和契约；不再新增包揽各领域的 utils、services、hooks 大目录。
2. **运行环境明确。** shared 不能依赖 React、DOM、Node 专属接口或 Cloudflare 专属接口；src 不导入 worker，worker 不导入 src。测试和工具支持另设边界。
3. **契约与执行分开。** types／protocol 文件只承载契约和必要常量；解析、校验、分支投影、事件应用放在明确命名的实现文件中。跨域类型使用 import type。
4. **入口负责装配。** 业务路由放进所属模块；公共鉴权、Origin 检查、错误映射集中装配。避免移动后仍由一个巨型 routes.ts 承担所有功能。
5. **状态只有一个所有者。** 浏览器草稿／outbox、供应商自动保存、DO 事务和 Alarm 各自保持单一来源，不用多个 hook 或类复制状态。
6. **直接导入明确文件。** 不建立把全部模块重新导出的 barrel，也不把 shared/types.ts 换成另一份全局聚合入口。保留必要的小模块，不为目录对称强行增加文件。
7. **提取有完整职责的单元。** 不按行数均分文件，也不为拆分引入依赖注入框架、通用 Repository、事件总线或新的全局状态库。

## 4. 建议目录

以下是目标归属，不要求每个模块一开始就具有全部子目录；小功能可以只有一两个文件。

```text
src/
  main.tsx
  style.css                         # 全局主题、排版与基础样式，当前无需进一步碎拆
  app/                              # App 装配、会话启动、应用导航、设置窗口装配
  features/
    chat/                           # 消息、输入区、分支、滚动、草稿、outbox、会话参数
      rendering/                    # Markdown、公式规范化、插件加载与降级
    library/                        # 对话侧栏、索引列表、跨对话搜索、管理入口
    providers/                      # 供应商、模型选择／编辑、能力、目录缓存和自动保存
    attachments/                    # 文件／图片／PDF 输入、上传、预览、文件管理
    backup/                         # 导入导出、进度、独立浏览器 Worker
    presets/                        # 提示词预设
    web-tools/                      # 联网服务设置、工具活动呈现
  platform/                         # HTTP、通用存储底座、自动保存、主题、浏览器能力
  components/                       # 业务无关的 Modal、Disclosure、IconButton、ActionMenu
    ui/                             # shadcn 源码组件及来源／许可证，保留已有 CLI 约定
  lib/utils.ts                      # shadcn 的 cn，避免无收益地更改生成器约定

worker/
  index.ts                          # 部署导出与 fetch 装配
  http/                             # Hono 装配、鉴权、响应、公共中间件、Env
  conversation/                     # Conversation DO、schema、提交策略、消息及摘要协调
  generation/                       # 模型流执行、缓冲、时序、错误、运行测量
  streaming/                        # 流日志和订阅／确认实现，可供聊天与工具共用
  library/                          # Library DO、对话索引、维护调度
  providers/                        # 配置、SDK、模型发现、探测、工具协议转换
  attachments/                      # R2 文件、文档存储与解析
  backup/                           # 导入、导出与复制任务
  search/                           # 搜索索引
  presets/                          # 预设持久化
  web-tools/                        # 工具任务日志、Workflow、服务适配与设置
  platform/                         # 存储资源预算等 Cloudflare 基础支持
  # 各业务的 routes.ts 与该业务放在一起，由 http/app.ts 装配

shared/
  conversation/                     # 消息／会话契约、分支、设置、摘要、上下文预算
  providers/                        # 供应商契约、设置校验、端点规则
  models/                           # 模型契约、能力解析、探测契约、目录及 generated 快照
  streaming/                        # SSE 解析、批次与同步协议、同步状态机、生成结果
  attachments/                      # 文件、图片、文档、PDF 契约与纯校验
  backup/                           # 备份／存档契约、编解码
  search/                           # 查询契约与规则
  presets/                          # 预设契约
  web-tools/                        # 工具及服务契约

tests/
  unit/<domain>/                    # 纯规则、解析、状态机、小范围适配
  integration/<domain>/             # 请求、DO、Alarm、事务、故障恢复；保留真实本地运行时
  e2e/<domain>/                     # 浏览器交互与跨层用户路径
  pwa/                              # 生产构建、Service Worker、离线及真实资源
  support/
    builders/                       # 消息／模型／对话的明确数据构造
    browser/                        # 页面交互与可复用浏览器夹具
    providers/                      # 四协议及特殊供应商的模拟流
    runtime/                        # 测试 DO、控制接口、故障注入和最小 Worker 入口
    assets/                         # PDF 等固定测试数据及来源说明

scripts/
  models/                           # 模型目录生成
  measurements/                     # 本地／Cloudflare 测量入口
    support/                        # 测量契约、执行器、计数器、平台验证专用 Worker

docs/
  architecture/                     # 当前架构与边界
  features/                         # 当前功能规则与限制
  plans/                            # 实施计划，注明待实施／已完成
  measurements/                     # 测量证据，保留可追溯数据
  references/                       # 界面参考与验收图
```

tsconfig、Vite、Playwright、Wrangler、components.json 等工具约定入口仍放根目录。层级先控制在上述范围；只有确有独立职责和多个文件时才继续细分。

## 5. 主要实现的迁移与拆分

| 当前实现 | 目标归属与拆分方式 | 必须维持的行为 |
|---|---|---|
| App 内 Markdown 加载、边界、降级；shared/markdown-math.ts | features/chat/rendering | 动态加载；原文降级；公式、代码、Mermaid；加载失败恢复 |
| App 内 MessageView／SummaryView | features/chat 的消息与摘要呈现组件 | 隐藏分支不挂载正文、思考折叠、搜索定位及操作焦点 |
| App 内输入区、发送、投递、附件准备 | chat 的输入区和草稿／outbox 控制；附件准备委托 attachments | requestId 固定；parentId 固定；离线只投递一次；切换后迟到响应不抢导航 |
| App 内登录、导航、设置开关、备份编排 | app 装配；备份流程归 backup，侧栏数据归 library | 新对话聚焦、URL 前后退、退出后的异步回调隔离 |
| ProviderSettings | app 的设置窗口 + providers 的列表、供应商编辑、模型编辑与能力测试 | 自动保存仍由一个控制器协调；改 API 类型／端点不清其他字段；空名称不保存 |
| storage.ts | platform 保留 IndexedDB／localStorage 底座；chat 管理草稿、outbox、快照、删除语义 | 删除墓碑、storage epoch、可靠入队与退出清理保持一致，不能产生独立缓存 |
| shared/types.ts | 按 conversation／providers／models／streaming 拆契约；branchPath 归 conversation；applyChange／appendMessage 归 streaming | 事件顺序、重复幂等、流身份及偏移校验不变 |
| worker/index.ts | http 装配与公共策略；业务 schema／handler 随各领域 routes.ts 归位 | 各路由权限、Origin 与 404／410／507 语义不变 |
| Conversation DO | 先提取消息投影、提交与摘要准备、订阅协议等职责明确的单元；流读取执行归 generation | DO 保持事务、Alarm、活动任务和最终写入的所有权；不拆成多个 DO 或跨网络服务 |
| Library DO | 将供应商存储、索引操作、复制／导入协调和维护任务逐项归位；复用已有 Store／Journal | 附件发布、复制／导入完成、删除与清理之间的原子性和重试行为 |
| provider-*、tool-* 平铺文件 | providers／web-tools／streaming，按协议适配、业务任务和通用日志区分 | 四类 API、DeepSeek 正文／思考、工具私有数据与公共呈现边界 |

DO 拆分时先识别事务单元，再决定函数边界。不能为减少类长度把同一个原子操作拆成多次异步写入；也不创建需要透传全部 private 字段的“辅助类”。必要时保留有明确职责的协调方法。

部署继续从入口导出 Conversation、Library、WebToolWorkflow；调整的是实现路径。保留大快照／大请求的 Response／ReadableStream 转发，不在 HTTP 层新增 JSON 解析和重复序列化。

## 6. 无用代码与导出的处理清单

| 对象 | 证据与判断 | 实施动作 |
|---|---|---|
| src/components/ui/label.tsx | 无本地导入者，生产及测试／脚本入口均不可达 | 删除文件；不增加替代包装 |
| worker/index.ts 的 messageAttachments 导入 | noUnusedLocals 报错，正文无引用 | 删除该导入 |
| shared/backup.ts 的 backupConversation | 全仓仅定义，无调用；backupMessage 等备份主流程仍在使用 | 删除此函数，清理随之失效的类型导入 |
| buttonVariants、badgeVariants、CATALOG_VENDORS、validateArchiveData 等 | 有文件内部用途，无外部消费者 | 优先取消 export，保留实现 |
| shadcn 的部分额外包装与导出 | 如 InputGroupButton／Text／Input／Textarea；扫描显示无外部引用 | 逐项核查内部调用、删掉无用包装及关联变体／导入，不批量删除整文件 |
| Dialog／AlertDialog 的 Overlay、Portal 等 | 无外部消费者，但 Content 内部仍使用 | 仅收窄导出，不删除内部组成 |
| 其余无外部引用的类型、常量、schema | 外部未引用不等于实现无用 | 逐项核对后取消导出；只删除没有内部用途的定义 |
| shared 中两份工具测量／验证支持 | 被脚本、运行夹具、资源测试引用 | 移到 scripts/measurements/support，并更新相关入口 |
| 模型快照、PDF Worker、归档 Worker、生产 PWA 资源 | 生成文件或动态入口，具有有效用途 | 保留并维护生成／加载路径 |

依赖包未发现可以仅凭当前扫描直接删除的整包。shadcn 和 tw-animate-css 有 CSS 引用；不能因为没有 TS 导入就删除。未用导出不必然增加最终 bundle，收窄 API 的主要收益是维护清晰度；以实际构建结果评价体积变化。

UI 源码删减后保留 [来源说明和本地适配记录](../src/components/ui/README.md)及 MIT 许可证。不把断流处理、资源边界、浏览器降级或历史测量证据当成“多余代码”。本计划也不因原型无需兼容，就顺带删改当前仍支持的备份格式等用户功能。

## 7. 测试归位、合并与删除规则

### 7.1 先明确验证责任

| 功能不变量 | 主要验证层 | 需要保留的跨层保障 |
|---|---|---|
| 分支拓扑、上下文、摘要覆盖、预算 | unit/conversation | 修改、重生成、切换后的发送、搜索、复制与导出 |
| 四协议 SSE、Unicode、思考、结束与用量 | unit/streaming、providers 的适配契约 | DeepSeek 思考与正文流式可见，重连后的持久化结果一致 |
| 幂等、取消、DO 重启、尾部写入失败 | integration/conversation、generation | 关闭页面后仍生成；中断保留已保存前缀且不自动重复调用 |
| 自动保存、能力合并、端点与密钥规则 | unit/providers | 模型选择、多 Tab 草稿、空名称、密钥查看与退出后隔离 |
| 文件校验、ZIP 校验、任务状态机 | unit/attachments、backup | R2 私有下载、复制／导入重试、失败清理和实际 PDF 提取 |
| 工具任务、轮次与限额 | unit/web-tools、integration/web-tools | 真实本地 Workflow／DO 边界、断开客户端及结果公开范围 |
| 焦点、滚动、响应式、对比度 | e2e/chat、settings、accessibility | 输入节点不重建、跟随暂停／恢复、分支锚点、键盘及文字放大 |
| 离线导航、公式字体、PDF Worker 资源 | pwa | 使用生产构建和真实静态资源，不能由模拟 E2E 替代 |

已有工具任务日志单测与真实 DO 集成测试分别覆盖状态机和平台事务，均有价值；message-context 与 conversation-branches 分别覆盖发送上下文和显示拓扑，也不能按名称相似直接合并删除。

### 7.2 具体调整候选

| 当前文件／做法 | 计划 |
|---|---|
| tests/core.test.ts | 将事件重放归 streaming、branchPath 归 conversation、供应商流消费归 providers；移除空壳 core 文件。UTF-8、未结束流不重试、敏感错误不外泄等独有断言必须保留 |
| provider.test.ts 混合设置和流适配 | 按供应商配置与协议适配拆分，避免文件继续聚合所有 provider 行为 |
| ui-migration、frontend-refinement、compact-layout、frontend-acceptance、settings-layout | 按 chat／settings／accessibility 等现有功能归位；取消以改版批次命名的套件 |
| chat 与 UI 改版测试重复的新对话焦点、视口适配 | 对照输入条件、操作和断言合并；保留输入 DOM 身份、草稿、导航返回、文字放大、横屏和长名称等不同条件 |
| alarm、resource-limits、tool-task-journal 等只使用 request 的场景 | 迁到 integration，继续使用 Playwright request + 本地 workerd，不为它们启动浏览器，也不新增另一套测试框架 |
| 各 spec 重复登录、保存／恢复供应商、建会话、轮询快照 | 提取小型明确夹具，统一清理；鉴权 UI 本身仍由专门 E2E 实际操作 |
| tests/ui.ts | 归到 support/browser；与构造数据、HTTP API 夹具分开 |
| fixtures/worker.ts | 拆成测试 DO、控制路由、数据构造、故障注入和模拟上游；入口只装配，不改变故障注入触发条件 |
| fixtures/generate.ts | 当前仍由测试调用；它是消费生产流的测试适配器，不是遗留业务实现。评估是否可收敛到契约测试支持，不能只删适配器而丢掉独有断言 |

本轮没有确认任何整套测试完全无用。实施时为每个删除／合并项记录“原用例 → 保留位置 → 保留断言”；只有触发条件与不变量均等价，才删除重复用例。不以测试数量减少或执行时间下降代替覆盖判断，不删除有价值的跨层回归。

拆分后继续让集成／浏览器测试串行运行：当前多个用例修改同一个 Library 中的供应商和工具设置，仅有不同会话 ID 不足以支持并行。端到端与生产 PWA 也按现有 check 顺序运行；数据隔离是独立改进，不夹带在目录重构中。

## 8. 构建、入口与路径同步

每次移动同时核对这些非普通 import 引用，避免静态依赖扫描漏判：

- package.json 的 test 发现规则、模型更新命令及全部测量脚本路径。
- Vite 的测试 Worker main、动态 import、`new URL(..., import.meta.url)`、PDF 资源 glob、PWA 预缓存和资源分包。
- Wrangler 生产及两份平台验证配置的 main；DO／Workflow 导出名称及类型引用。
- Playwright 的 testDir／testMatch／项目选择、生产 PWA 服务入口与隔离数据库路径。
- tsconfig 根引用、各运行环境 include、测试配置与测试入口的检查范围。
- components.json 的别名和样式路径；不为了目录美观改掉 shadcn 的稳定约定。
- 模型快照生成脚本的输出路径与生成文件内部导入。
- README、功能文档和测量复现文档中的源码链接、命令与路径。

测试类型检查按 Node 单测、浏览器测试和 Cloudflare 测试入口的环境分别组织，不能通过给所有文件塞入全部全局类型或批量 any 来消除报错。shared 的中立性也应由独立检查约束。

## 9. 实施顺序与提交边界

| 阶段 | 工作 | 完成条件／验证 | 建议提交边界 |
|---|---|---|---|
| 0. 固定基线 | 完整检查、测试清单、功能到测试映射；记录构建产物和流式测量口径 | 明确现有失败；可重现；记录 316 单测、286 主套件、3 PWA 的去向 | 测试／检查基础设施单独提交 |
| 1. 明确死代码清理 | 删除 label、未用导入和 backupConversation；核实并收窄无用导出／包装 | 类型检查、单测、构建；UI 相关定向回归；noUnused 检查无新增问题 | 只含可证明的清理 |
| 2. 契约与底层归位 | 拆 shared/types；移动 shared 业务文件和测量支持；保留算法语义 | 全部导入更新；无兼容转发；单测与构建；流式和分支定向回归 | 按契约／协议小批次提交 |
| 3. 前端归位与拆分 | 先按功能移动，再分别提取渲染、输入与投递、设置子模块、App 装配 | 焦点、滚动、离线草稿、分支与搜索；模型／自动保存；公式及 PWA | 纯移动与职责提取分开提交 |
| 4. Worker 归位与拆分 | 先路由／provider／附件等边缘模块，再 Conversation 与 Library 的协调逻辑 | 鉴权、Alarm、重启／取消／尾部失败、事务、复制／导入、工具；响应转发及测量口径不退化 | HTTP、Conversation、Library 分开提交 |
| 5. 测试按职责收敛 | 根据已稳定模块边界归位；提取夹具；合并被证实重复的断言 | 新发现规则覆盖 unit、integration、e2e、pwa；每个原场景有去向；完整检查通过 | 移动与删除重复测试分开提交 |
| 6. 文档与收尾 | 文档分类、README 导航、源码链接与复现命令；再次扫描依赖和残留路径 | 无旧路径引用、无无效入口；运行时依赖仍无环；清理清单及测试映射完整 | 文档与最终检查单独提交 |

阶段 0 就修复测试发现与类型检查基础设施；阶段 5 才系统整理测试内容，避免在产品重构期间同时改变被测行为和验证规则。测试文件随被测模块更新导入，不必提前全量搬迁。

各阶段先跑受影响检查，阶段完成再跑 `pnpm check`。纯文件移动不新增照抄实现的测试；只有发现覆盖缺口、抽取改变了可观察边界或出现回归时才补测试。不会把全量搬目录、DO 拆分和测试删除堆在一个提交中。

目录移动本身无需再次部署 Cloudflare；涉及流处理、序列化、SQL 或 Alarm 实际行为时，先做本地同口径测量，结果不足以排除回归时再做隔离平台验证。沿用已有计数与报告，不在高频路径加额外日志。

## 10. 最终验收

- 根目录只保留项目与工具入口；业务模块的主要实现和测试可以按功能定位。
- App、HTTP 入口、Conversation 和 Library 各自只有明确的装配／协调职责；没有把原巨型文件原样搬入新目录作为完成。
- 不存在 shared 全局聚合出口、旧路径兼容壳、已确认无人使用的定义和无用 UI 包装；必要内部实现、许可证及生成来源保留。
- 依赖继续符合运行环境边界，无新增运行时循环；对共享契约不再通过混杂入口引用执行逻辑。
- 单测、集成、浏览器和 PWA 的发现规则与类型检查均覆盖新位置；所有删除项能追溯到保留的等价断言或明确失效的需求。
- `pnpm check` 与 `git diff --check` 通过；重构期间观察到的失败要定位处理，不能用删除测试、放宽断言或延长等待掩盖。
- 用户行为、URL、分支关系、API 权限、自动保存、离线队列、流式思考与正文、持久化以及资源边界保持既有约定。
- 构建入口、动态资源和生产 PWA 正常；相关流式测量未出现额外的上游调用、高频写入或明显序列化开销。

建议按第 9 节从检查基础设施和确认死代码开始推进，再处理契约与前后端大入口，最后收敛测试组织和文档。删除量由证据决定，不设行数或用例数配额。

## 11. 实施记录

### 检查基础设施

- 增加客户端单测、Node／服务端单测、Cloudflare 测试运行入口、浏览器测试四份类型检查配置，以及只提供标准 Web Worker API 的 shared 独立检查，纳入 typecheck 和根项目引用。
- 修复检查新发现的两处夹具类型缺口：模型配置显式设置 showReasoning；UTF-8 严格解码显式采用默认的 ignoreBOM=false。没有放宽断言或增加 any。
- 单测改用递归发现并排序文件的入口，支持 --list，零匹配会失败，为后续测试迁移做准备。
- 基线主套件／PWA 正在通过隔离本地服务器验证；沙箱默认禁止监听本机端口，已用获准的本地测试权限运行。
