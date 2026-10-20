# AI Elements / Chart 实施记录

基线：`dcf3616`。pnpm、Radix Nova、Recharts 3.10。官方 CLI 4.22.1 dry-run / diff 检查后安装；保留现有 Button，新组件改用项目已有 cn，移除重复依赖。

官方注册表部分 CDN 地址在本机超时。公开 DNS 核对后，`76.76.21.98` 可连接，临时仅为 CLI 进程指定解析地址，TLS 校验保持开启；没有修改系统 DNS 或运行配置。CLI 已成功安装官方 Radix 文件。

## Chart

- 基线 build / typecheck、原趋势图 Chromium 用例通过。
- 基线 SW 预缓存 12 项、1147.41 KiB；Chart 阶段仍为 12 项、1180.63 KiB。新增组件 Tailwind 类增加公共样式，没有把图表 JS 加入必需预缓存。
- 原统计页 5 项 Chromium 回归通过。新增双 Token 线及图例、比较图排序、原始整数金额、缺失金额不作零、币种分离、前 8 项及其他的回归。
- 468 项单元测试、Chart 阶段生产构建通过。金额排序与汇总使用 BigInt，绘图才转换为 Number，Tooltip 使用原始金额。
- 基线截图和产物清单保留在本机 `/tmp/everchat-ai-elements-baseline-phone.png`、`/tmp/everchat-ai-elements-baseline-assets.json`，收尾再比较。

## 消息、过程与输入

- 私有消息与分享使用 Message / Bubble，历史压缩使用 Marker；模型、供应商和生成信息集中到回答头部。分享仍只显示模型名，思考默认折叠。
- 思考、工具和来源改为受控 Trace，沿用原来的流式 Markdown 和交错顺序。折叠记忆、搜索展开、失败调用定位保持可用。
- 修复基线中同一工具错误重复显示：通过终止阶段关联故障，并避免把 undefined 传给默认显示摘要的组件；独立供应商故障仍单独展示。
- ChatComposer 保持单草稿、单输入实例，用 InputGroup 组合附件、输入和工具栏。Attachment 映射原上传／处理状态；原 PDF 提取、选页和取消逻辑不变。上下文 Progress 只在窗口已知时显示比例。
- 消息／分支／搜索／工具 42 项、桌面与手机分享 2 项、输入／附件／PDF／模型选择 66 项 Chromium 回归通过。470 项单元测试、类型检查与生产构建通过。SW 仍为 12 项、1200.77 KiB。

## 待完成

Message Scroller 隔离对照及切换、公开入口构建边界、完整 PWA 回归和本轮真机验收尚未完成。
