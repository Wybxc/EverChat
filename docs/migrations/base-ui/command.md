# command

2026-10-21 · native Base UI Combobox / Autocomplete + official shadcn Base Nova Combobox source · migrated in PR #2.

## Changed

- 模型选择由 Popover + cmdk 改为 Base UI Combobox，保留供应商分组、组合模型键、选中标记、同名模型的 ID、供应商名称和草稿。新增 `match-sorter` 8.3.0，覆盖显示名、模型 ID、供应商名称及非连续模糊匹配；同等匹配沿用配置顺序。
- 全局搜索继续使用现有 Modal，内部改为 `Autocomplete.Root inline open`，标题与异步正文／思考结果共用同一选项集合。键盘高亮由 Base UI 管理，没有新增手写方向键导航。
- 正文查询移入 `useLibrarySearch`，保留 350ms 防抖、分页、索引轮询、离线反馈和删除过滤。状态与重试／加载更多控件位于 List 之外，避免 Enter 确认结果时误处理按钮。
- 结果采用 Base UI Item 内的真实链接：普通点击与键盘确认执行 SPA 导航，Cmd/Ctrl 与中键保留浏览器新标签页行为。没有用 Item `render` 覆盖链接角色，真实 href 及复制链接入口保留。
- 输入法 Enter／Escape 通过原生可取消事件避免确认或关闭。选择模型后回到聊天框；Escape 明确回到触发按钮，防止默认恢复到弹窗输入框又重新打开。
- 新增必要的 InputGroupInput 与小型 Combobox／Autocomplete UI 封装，保留 Nova 样式、语义色、鼠标 32px／触屏 44px 最小目标及触屏至少 16px 字号。空状态实时播报区域始终挂载，有模型结果时去掉其占位留白。
- 删除无调用的 `command.tsx`、旧 command 样式与测试 DOM 标记，移除 cmdk 并更新锁文件。锁文件不再包含 `@radix-ui/*` 或 `cmdk`；`pnpm why @radix-ui/react-dialog` 无输出。

## Left alone

Worker、供应商请求、搜索接口、索引与数据存储没有改动。原版分支基线修复在独立 PR #3 完成，后随 main 合入本分支，与组件替换分别提交。Recharts、Streamdown 和 Message Scroller 保持既有实现。未合并 PR 或发布线上版本。

## Behavior changes

模型搜索评分从 cmdk 内置算法切换为 match-sorter，保留多字段模糊搜索与同等匹配顺序，不保证所有查询的排名逐项相同。全局搜索保持既有标题规范化匹配及服务端全文查询，不进行第二次客户端过滤。

空查询显示最近对话，不发送正文搜索请求；重试和加载更多使用原生按钮键盘行为，不再依赖 cmdk 根节点的 Enter 补丁。Escape 取消模型选择不会回焦聊天输入框或重新打开菜单。

473 项单测、Chromium 最终 19 项、WebKit 最终 16 项与生产 PWA 54 项全部通过；体积实测、扩展验证与剩余边界见 [项目报告](project.md#cmdk-替换验收)。

## Verify by hand

自动化覆盖模型显示名／ID／供应商搜索、同名模型、无结果、键盘选择、取消与重复选择回焦、草稿、IME Enter／Escape；标题与正文分组间导航、异步与分页、命中高亮、错误重试、离线标题、原生链接修饰键及中键、移动搜索关闭。真机软键盘与辅助技术仍需人工体验；本次未操作已安装的生产 PWA。
