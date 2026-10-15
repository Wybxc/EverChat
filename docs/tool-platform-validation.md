# 工具链路平台验证

2026-10-15：隔离入口和执行器已完成本地验证，随后通过 Workers Free 的 11 项平台场景。真实资源样本、限制与远程清理见[平台实测](tools-cloudflare-measurements.md)。下方保留复现方式，不改变[已有本地计数](tool-measurements.md)的口径。

## 隔离与观察边界

- [独立配置](../wrangler.tool-validation.jsonc)仅用于 `everchat-tools-validation`，提供两个独立 SQLite DO 和 `everchat-tools-validation-flow`。不绑定 R2，未配置附件时聊天／工具仍能工作。使用生产 Workflow、供应商请求构造、AI SDK 续接和 Tavily 适配器，模型与工具 HTTP 响应由 fixture 模拟；其余外部供应商网络被禁用。
- `LOCAL_RESOURCE_METRICS=0`、`GENERATION_METRICS=0`。不使用本地计数代理或测量版 Workflow，不在模型生成期间轮询 Library。mock 工作负载独立配置：默认 120 段 × 200 UTF-16 码元、每段 25ms；`large` 为 120 × 750；`sustained` 为 120 × 200、每段 500ms。协议控制事件和两次 1.5 秒工具响应照常保留。
- [执行器](../scripts/tool-platform-runner.ts)在发送密码或写设置前核对 Worker 类型、版本、随机 `VALIDATION_RUN_ID`、模拟上游和关闭的计数开关。远程仅接受专用 `workers.dev` 地址；本地模式只接受显式的 `127.0.0.1`。拒绝跟随 HTTP 重定向。
- `/api/__test/*` 在该入口返回 404。专用准备接口要求登录、同源、UUID 和两个固定模式，且仅允许未开始工具任务的对话；没有通用故障注入接口。
- 公开 WebSocket 报告终态后，才每两秒查询只读终态接口。该接口直接 SELECT，不调用会过期／恢复任务的 `toolTaskState()`，不人工触发 Alarm；只返回状态、计数与 SQLite 分配。断开唯一订阅时，每五秒读公开快照，完成后重新订阅并比较最终结果。
- 查询会产生真实请求，也可能唤醒对象并执行正常构造逻辑。因此报告保存查询次数，**不将本次观察方式当作自然休眠证明**。平台时间窗包含配置、fixture 记账 SQL、验证查询和其他设置活动；不能把平台 SQL 总量直接当作去除 fixture 后的产品净开销。
- 报告只保存引用、字符数、状态和计数，不保存密码、API 密钥、正文或供应商私有续接。中途失败会保存 `complete: false`，不能交给平台指标脚本充当完整窗口。

## 本地复现与结果

```sh
pnpm measure:tools-platform-local
# 默认端口 5191；也可以只跑一组：
pnpm measure:tools-platform-local --suite sustained --port 5192 --output /tmp/everchat-tools-recheck
```

该命令生成随机本地 Secrets，使用临时配置和持久化目录启动自建 Wrangler 服务，复用将要部署的 API-only 入口，完成后只停止自己的进程并删除临时状态。不会连接正在开发的 5173 服务。输出按 suite 分为 `-functional.json`、`-large.json`、`-sustained.json`，明确标记 `runtime: local`。

| 报告 | 实际验证 |
|---|---|
| [functional：9 项](measurements/tools-platform-local-functional.json) | 四协议各两次模型／两次工具；首预览后断开唯一订阅及终态重连；四模型／六工具轮次上限；HTTP 401；初始模型期间取消；两对话共享仅剩一次的额度 |
| [large：1 项](measurements/tools-platform-local-large.json) | Responses 完整 90,000 码元，约 10 秒，两次模型／两次工具 |
| [sustained：1 项](measurements/tools-platform-local-sustained.json) | Responses 完整 24,000 码元，77.5 秒，两次模型／两次工具，期间没有 Library 诊断保活 |

11 项全部通过。每项重复接受同一请求而不增加调用，完成后 Workflow 结束、私有日志／续接／运行配置清空、通知／索引 outbox 归零，两个 DO 无待触发 Alarm。并发额度场景只发出一次实际工具 HTTP，两个任务都在耗尽额度后停止；取消场景只调用一次模型、零次工具。在线结果及断线终态回放与数据库快照相同，公开状态没有密钥或签名。

另外，285 项单元测试、应用／Worker／脚本类型检查、改动 fixture 和测试的独立严格类型检查、生产构建及差异检查通过。两项新增单元测试验证错误运行时／开启计数时不会发送密码，以及远程地址限制。专用 Worker `wrangler deploy --dry-run` 打包通过，gzip 526.93 KiB；dry-run 不创建远程资源。

## Workers Free 复现

1. 检查账户和专用 Worker／Workflow 名称，确认使用本轮隔离资源，保存 namespace ID 和部署版本。使用本地权限为 0600 的随机 Secrets JSON，包含不少于 32 字符的 `APP_PASSWORD`、随机 `SESSION_SECRET` 和 UUID `VALIDATION_RUN_ID`；不得使用正式环境密钥。部署命令为 `pnpm exec wrangler deploy --config wrangler.tool-validation.jsonc`，然后用该配置执行 `wrangler secret bulk`。Secrets 未齐全时入口拒绝业务请求。
2. 三组分别运行下方命令，保存完整报告。并行启动专用 tail，使用 `--worker everchat-tools-validation`；tail 只保留脱敏路径、状态和可选资源字段。
3. 每组用 `measure:cloudflare-metrics --functional <该组报告>` 查询对应分钟窗口，使用 `--url` 和同一 Secrets 文件取得终态 SQLite 分配。工具报告必须标记 `runtime: cloudflare`，本地报告会被拒绝。
4. Worker／DO 图表与 Workflow 图表分别查询；某个数据集缺失不能使其他数据丢失。Workflow 使用 [`workflowsAdaptiveGroups`](https://developers.cloudflare.com/workflows/observability/metrics-analytics/)，本轮实际 schema 另核对 CPU、执行时长、步骤、重试和状态增长字段。`cpuTime` 为毫秒；`storageRate` 不是保留存储或账单。查询后保留缺失项，不写成零。各子窗口分钟取整后可能重叠，应另建总窗口，不能相加。
5. 保存报告和资源 ID 后，删除本轮 Workflow（含实例）、Worker 和残留的两个 namespace，核实远程已不存在，再删除临时 Secrets。不要用 `--force` 绕过其他 Worker 依赖检查。可以在资源清理后，用保存的 namespace 报告读取迟到指标，不为等待采样保留公共验证资源。

```sh
pnpm measure:cloudflare-tail --worker everchat-tools-validation --seconds 300 --output /tmp/everchat-tools-tail.json
pnpm measure:cloudflare-tools --suite functional --url https://everchat-tools-validation.YOUR-SUBDOMAIN.workers.dev --credentials /tmp/everchat-tools-validation-secrets.json --output /tmp/everchat-tools-functional.json
pnpm measure:cloudflare-tools --suite large --url https://everchat-tools-validation.YOUR-SUBDOMAIN.workers.dev --credentials /tmp/everchat-tools-validation-secrets.json --output /tmp/everchat-tools-large.json
pnpm measure:cloudflare-tools --suite sustained --url https://everchat-tools-validation.YOUR-SUBDOMAIN.workers.dev --credentials /tmp/everchat-tools-validation-secrets.json --output /tmp/everchat-tools-sustained.json
pnpm measure:cloudflare-metrics --account YOUR_ACCOUNT_ID --functional /tmp/everchat-tools-functional.json --url https://everchat-tools-validation.YOUR-SUBDOMAIN.workers.dev --credentials /tmp/everchat-tools-validation-secrets.json --output /tmp/everchat-tools-metrics.json
```

本轮真实平台负载与资源样本已见[实测报告](tools-cloudflare-measurements.md)。账户级长期共享额度、SQL 计费存储采样和真实 Tavily 权限／质量仍保留边界；这里的本地通过不替代平台结果。
