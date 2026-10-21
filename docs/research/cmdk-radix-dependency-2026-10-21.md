# 移除 cmdk 的间接 Radix Dialog 依赖

日期：2026-10-21。状态：调研方案已在 PR #2 实施，记录见 [Command 替换报告](../migrations/base-ui/command.md)。以下事实与方案是实施前的调查记录。原始分支为 `main`（`86e8ccb`）；Base UI 迁移分支为 `codex/base-ui-migration`（`fe778a0`，[PR #2](https://github.com/Wybxc/EverChat/pull/2)）。本文建议在 Base UI 迁移基础上实施，不将组件替换混入原始分支的基线测试修复。

## 结论

建议移除 `cmdk`，将模型选择改为 Base UI Combobox，将全局搜索改为 Base UI Autocomplete，继续使用现有 Modal。两处业务的交互不同，不再通过同一组 Command 组件模拟。键盘导航、选项状态、可访问性与浮层行为交给 Base UI；业务继续负责查询、排序和导航。

仅替换外层 Dialog 或更新 shadcn Command 无法移除安装依赖。维护 cmdk 的补丁／fork 技术上可行，但对于只有两个消费场景的 EverChat，长期维护成本高于使用迁移分支已经引入的 Base UI。

## 已核对的事实

2026-10-21 通过 npm 注册表查询，cmdk 最新版本仍为 `1.1.1`。其[包声明](https://github.com/dip/cmdk/blob/v1.1.1/cmdk/package.json)包含四个强制依赖：`@radix-ui/react-dialog`、`react-primitive`、`react-id`、`react-compose-refs`；公开 exports 只有 `.`，没有独立 core 或无 Dialog 入口。其[源码](https://github.com/dip/cmdk/blob/v1.1.1/cmdk/src/index.tsx)在同一模块导入 Radix Dialog 并导出 Dialog 组件。

在迁移工作树执行 `pnpm why @radix-ui/react-dialog`，路径为 `EverChat → cmdk@1.1.1 → @radix-ui/react-dialog@1.3.1`。EverChat 没有使用 `Command.Dialog`，全局搜索已经通过项目 Modal 打开；当前残留属于包级强制依赖。安装依赖、最终 JS 产物和首次预缓存是不同指标，不能因为未使用 Dialog 就声称依赖或下载成本为零。

shadcn 的 [Base UI Command 文档](https://ui.shadcn.com/docs/components/base/command#about)明确仍使用 cmdk。因此重新生成 Base 版 Command 也不满足移除依赖的目标。

本地调用点：

| 文件                                        | 当前职责                                               | 替换范围                                             |
| ------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| `src/components/ui/command.tsx`             | cmdk 的 Command、Input、List、Group、Item、Empty 封装  | 所有消费方迁移后删除，或移除不再使用的导出           |
| `src/features/providers/ModelPicker.tsx`    | 搜索、供应商分组、模型选择、选择后输入框回焦           | 使用 Combobox；模型键仍为供应商 ID 与模型 ID 的组合  |
| `src/features/library/GlobalSearch.tsx`     | 搜索弹窗、标题匹配、受控查询和列表键盘交互             | 保留 Modal，使用内联 Autocomplete                    |
| `src/features/library/LibrarySearch.tsx`    | 异步正文／思考搜索、分页、索引状态和失败重试           | 保留查询逻辑，将结果纳入同一个选项集合               |
| `src/features/library/SearchResultItem.tsx` | 直接使用 cmdk Item，内部链接保留新标签页及复制链接行为 | 改用 Base UI Item 的链接组合，并验证修饰键和右键菜单 |
| `src/style.css`、浏览器测试与辅助函数       | command 的尺寸／触屏字号和个别 `[cmdk-list]` 选择器    | 改为新组件标记；保留现有触屏尺寸和焦点断言           |

## 方案比较

| 方案                                       | 能否移除间接 Dialog 依赖         | 取舍                                                                                                          |
| ------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 不使用 `Command.Dialog`，仅使用项目 Modal  | 不能                             | 当前已经如此，包声明和锁文件仍保留依赖                                                                        |
| 升级 cmdk 或重新添加 shadcn Base Command   | 当前不能                         | 截至核对日，发布版本及官方组件仍使用该依赖                                                                    |
| 维护 cmdk 补丁或 fork                      | 可以，但需同时修改代码和依赖声明 | 单独删除依赖会使原模块 import 无法解析；仅补丁删除 Dialog 代码又不会清理依赖图。其他 Radix 工具依赖也仍需处理 |
| 使用现有 Base UI 的 Combobox／Autocomplete | 可以，推荐                       | 不增加另一套基础 UI 依赖，需要重新验证过滤、异步结果、链接和焦点行为                                          |

若选择补丁，必须一起处理 Dialog 实现、导出、类型及依赖图，不使用空模块 alias 或仅删除锁文件的办法。pnpm [明确说明](https://pnpm.io/cli/patch)不能通过 `pnpm patch` 修改包内 package.json 来改变依赖，应使用 overrides 或 package hook；这进一步增加了持续维护面。fork 还需要自行构建、发布和跟踪上游修复。

## 推荐实施顺序

### 1. 先迁移模型选择

依据 Base UI [弹层内搜索输入](https://base-ui.com/react/components/combobox#input-inside-popup)示例，将现有 Popover + Command 改为一个 Combobox。使用受控模型键和独立搜索词；保留供应商分组、同名模型的 ID、选中标记、标题中的供应商名称及选择后输入框回焦。Escape 取消应返回触发按钮，不能误判为已经选择。

模型搜索继续覆盖显示名、模型 ID 和供应商名称。cmdk 的模糊排序不等价于 Base UI 的默认过滤，需要先固定代表性查询及预期排名；若需保留模糊匹配，可按 Base UI [官方示例](https://base-ui.com/react/components/autocomplete#fuzzy-matching)评估 `match-sorter`，同时测量新增体积，不自行重写评分算法。

### 2. 再迁移全局搜索

Base UI 有现成的 [Dialog + Autocomplete 命令面板示例](https://base-ui.com/react/components/autocomplete#command-palette)。沿用现有 Modal，在其中使用 `Autocomplete.Root inline open`，由一个选项集合管理标题与正文／思考结果的键盘高亮。不要再嵌套一层独立浮层或增加手写方向键导航。

现有标题规范化匹配、350ms 防抖、分页、索引轮询和网络错误处理保持。Autocomplete 使用外部过滤结果或 `mode="none"`，避免再次过滤服务端命中的片段。将查询数据传给共同的列表容器，避免继续依赖 cmdk 跨任意子组件的 DOM 注册机制；不同页追加结果保持稳定 ID 和当前高亮。加载状态、重试及加载更多操作应与选项语义分开。

结果项保留真实 `href`，评估通过 Item 的 `render` 合成为链接；普通点击和键盘确认走 SPA 导航，Cmd/Ctrl／中键和复制链接保留浏览器行为。该组合尚未实现，不能仅凭类型通过就认为链接行为已经验证。

### 3. 最后清理依赖与记录

两个场景均完成后删除所有 cmdk import 和无调用的 Command 封装，执行 `pnpm remove cmdk`，提交同步更新的锁文件。检查 `SearchResultItem` 的直接引用和测试中的 `[cmdk-list]`，不能只处理 UI 封装。

在已移除直接 `radix-ui` 的迁移分支上，重新运行 `pnpm why @radix-ui/react-dialog`，确认已无依赖路径，再检查其他 Radix 依赖来源。原始 main 仍直接依赖 `radix-ui`，因此只在原始分支移除 cmdk 不会使整个项目摆脱 Radix。

## 验收与边界

- 模型选择：供应商／模型 ID／中英文显示名搜索、同名模型、大目录、无结果、方向键确认、Escape 取消、草稿和焦点保持。
- 搜索：Mod+K、标题及正文／思考命中、关键词高亮、异步结果到达和分页时的键盘高亮、错误重试、加载更多、链接修饰键、IME Enter／Escape、关闭后回焦。
- 移动端：竖屏／横屏关闭按钮可达，触屏搜索字号仍至少 16 CSS px，结果区滚动和软键盘不破坏布局。
- Chromium 与 WebKit 重跑 `settings/model-picker.spec.ts`、`library/library-search.spec.ts`、`library/shortcuts.spec.ts`、`chat/search.spec.ts` 及相关移动回归；依赖 Chromium CDP 的手势场景单独执行，不宣称已在 WebKit 覆盖。
- 类型检查、生产构建和 PWA 搜索／缓存回归通过；检查最终构建中的 Radix Dialog 模块、全部 JS/CSS gzip 总和与必需预缓存，比较前后实测值。本文未运行替代实现，暂无可承诺的体积降幅。

后续已按用户要求在 PR #2 完成替换：模型选择使用 Combobox，全局搜索使用 Autocomplete，保留 match-sorter 模糊搜索；cmdk 及间接 Radix 依赖已删除。最终交互、链接组合、测试与体积实测以 [实施报告](../migrations/base-ui/command.md)为准。
