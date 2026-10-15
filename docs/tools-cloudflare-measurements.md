# 工具链路 Workers Free 实测

2026-10-15，在用户确认的 Workers Free 账户完成隔离验证。部署代码为 `5ea6900`，当前生效版本及两个新 namespace 见[部署记录](measurements/tools-cloudflare-deployment.json)。Worker、Workflow、两个 namespace 和随机验证 Secrets 均已清理，见[清理确认](measurements/tools-cloudflare-cleanup.json)。没有操作正式 Worker，没有调用真实模型或 Tavily。

## 负载与功能结果

使用[专用入口与同一执行器](tool-platform-validation.md)，关闭 `GENERATION_METRICS` 和 `LOCAL_RESOURCE_METRICS`。模型流、生产 SDK 续接和 Tavily 适配器运行在真实平台；只替换外部 HTTP 响应。未绑定 R2。每次接受都重复提交同一请求，核对不增加调用；生成期间不轮询 Library。在线先等待公开 WebSocket 终态，再每两秒读取只读清理状态；离线每五秒读取公开快照。

| 场景 | 实际结果 | 证据 |
|---|---|---|
| 四协议正常往返 | 各两次模型／两次工具，正文与持久化状态一致 | [functional](measurements/tools-cloudflare-functional.json) |
| 首个预览后断开唯一订阅，终态重连 | 页面离开后继续完成；回放等于最终快照，调用次数不增加 | 同上 |
| 轮次上限／服务拒绝／模型中取消 | 分别为四模型六工具、一次模型一次 HTTP 401、一次模型零工具；保留前缀且停止后续步骤 | 同上 |
| 两个任务共享剩余一次额度 | 合计只发出一次实际工具 HTTP，两任务在额度耗尽后失败 | 同上 |
| Responses 大正文 | 完整 90,000 UTF-16 码元，18.8 秒，两模型／两工具 | [large](measurements/tools-cloudflare-large.json) |
| Responses 长流 | 完整 24,000 码元、每段 500ms，83.0 秒，两模型／两工具 | [sustained](measurements/tools-cloudflare-sustained.json) |

11 项场景包含 12 个独立任务，共 22 次模型请求、22 次工具 HTTP。任务结果为 7 完成、4 按预期失败、1 取消；每项 Workflow 都正常结束，私有日志、续接和运行配置清空，通知／搜索 outbox 归零，Conversation 与 Library 无待触发 Alarm。控制面再次确认[12 个 Workflow 实例全部 complete](measurements/tools-cloudflare-precleanup.json)，没有运行、等待或 errored 实例。这里的预期任务失败与 Workflow 引擎失败分别记录。

## 窗口、采样与现有资源证据

三组原始功能报告的摘要与 SHA-256 见[总窗口](measurements/tools-cloudflare-combined.json)。业务执行从 `02:48:28.920Z` 到 `02:55:32.021Z`；指标采用 `02:48:00Z–02:57:00Z` 的单一窗口。窗口包含登录、配置、初始化、重复接受、观察请求、fixture 记账 SQL、组间指标采集及空闲间隔。不是单次模型流的净消耗，也不能直接与排除 schema／fixture 的本地计数相除。

各组的[功能指标](measurements/tools-cloudflare-functional-metrics.json)、[大正文指标](measurements/tools-cloudflare-large-metrics.json)、[长流指标](measurements/tools-cloudflare-sustained-metrics.json)按分钟取整，窗口可能重叠，且查询时数据还在到达。**不把这些子窗口相加。** 总窗口另保留[首轮](measurements/tools-cloudflare-metrics-initial.json)、[清理后补读](measurements/tools-cloudflare-metrics-later.json)和[退避后补读](measurements/tools-cloudflare-metrics-final.json)，补读使用保存的 namespace ID，没有重建资源。

截至 `03:07:41Z` 退避后补读的样本如下，仍不能据此证明数据完整或账户账单：

| 指标 | 当前样本 | 口径 |
|---|---:|---|
| Worker 请求／CPU | 168 次，0.490009 秒 | GraphQL 汇总，包含断流状态；错误计数为 0 |
| Worker 最大 CPU | 16.074ms | GraphQL 原始微秒换算；不是每次都低于 10ms 的证明 |
| Conversation CPU／活跃时长 | 2.527297 秒／156.390904 秒 | namespace periodic 样本 |
| Library CPU／活跃时长 | 0.081695 秒／4.332331 秒 | 同上 |
| 两个 DO 的 duration | 20.572574 GB-s | 平台字段，不能用墙钟时间替代 |
| 两个 DO 的 SQL | 11,549 读行，2,885 写行 | 包含初始化、fixture 和观察；不是精确累计账单 |
| DO 超限／内部错误 | CPU、内存超限及 fatal internal 均为 0 | invocation 仍有 `clientDisconnected`、`responseStreamDisconnected`，不写成全部错误为 0 |
| 终态 SQLite 分配 | 4,915,200 字节（4.69 MiB） | 清理前 12 个 Conversation 与 Library 的分配合计，不是账单或生成中峰值 |
| SQL 计费存储 | 无样本 | `available: false`，不写成 0 |

DO invocation 有自适应采样，报告保留 `sampleInterval`。同一固定窗口的 `02:59:41Z` 补读曾为 14,897 读行／3,708 写行、23.820838 GB-s；`03:07:41Z` 的值反而较低，原因尚未确定，不能只归因于迟到而视为单调累计。两份原始结果都保留，不挑较大的样本充当完整总量，也不根据差值声称优化幅度。当前支持已测负载和资源量级判断，不支持精确账单。终态分配仅是当时保留数据，其他应用、长期共享额度和账户总存储仍不由它证明。

## Workflow 与尾日志

实际 GraphQL [schema 核对](measurements/tools-cloudflare-workflow-schema.json)提供 `cpuTime`（毫秒）、`executionDuration`（GB-s）、`allStepCount`、`stepCount`、`retryCount`、`storageRate` 和 `wallTime`。采集器现分别记录这些字段；Workflow 查询失败不丢弃 Worker／DO 数据。`storageRate` 是状态增长字段，不是保留存储、峰值或 GB-month，不能把生命周期事件不加核对地相加充当账单。

Workflow 图表最初只有 11 个成功事件；按分析 API 的五分钟限流要求退避后，已覆盖 12 个开始、12 个成功。运行中事件记录 55 个总步骤／43 个 `step.do`，成功事件再记录 35／25 个，合计 90 个操作、68 个 `step.do` 和 22 次等待，与本轮有限调用路径一致；CPU 合计 71ms、重试为 0。状态增长分别为开始 786,432 字节、运行 40,960 字节、结束 45,056 字节，保留各类原值，不作为存储账单。`executionDuration: 0` 也不能当作整个执行零开销。限流记录见[失败查询](measurements/tools-cloudflare-query-backoff.json)，它不代表 Workflow 执行失败。

[脱敏 tail](measurements/tools-cloudflare-tail.json)保存 512 项事件，全部有 CPU 字段；包括 12 个 Workflow，CPU 合计 71ms、单条最大 13ms。HTTP Worker 的尾日志最大为 20ms，发生在读取对话接口；GraphQL 的最大值为上述 16.074ms，两种记录分别保留，不强行对齐。日志还存在取消／断流状态，没有 CPU 超限 outcome。连接最初因本机 DNS 失败，改用本机已运行的 HTTP 代理后核对随机运行标识才登录，TLS 验证始终开启。tail 不是完整账单，采集开始前的事件也不能靠它补齐。

官方[免费层定价](https://developers.cloudflare.com/workflows/reference/pricing/)仍限制请求、CPU、每日步骤和状态存储；[步骤定义](https://developers.cloudflare.com/changelog/post/2026-07-07-workflows-billing-updates/)包含等待事件。不能只按本地 `step.do` 的数量估算每天可运行的任务，也不能因为等待不消耗 CPU 而忽略步骤和 DO 活跃时长。当前默认工具日额度为 20 次，用户提高服务额度不会同时提高平台配额。

## 当前结论与后续

本轮证明当前有界工具实现可以在该 Workers Free 账户完成已测的个人原型负载；四协议、较大响应、超过一分钟、离线、取消、失败及并发额度都有真实平台结果，资源与清理证据已保存。它不能证明所有请求严格低于 10ms，不能保证所有账户活动长期免费，也不能证明真实供应商权限和搜索质量。

迟到 Workflow 已补齐到 12 个；不再为没有数据的 SQL 存储图表或非单调的 DO 汇总重复部署。最终范围与验收审查已记录在[实施核对](implementation-audit.md)；本报告的负载与采样边界继续有效，未明确要求的条件项保持原计划范围。
