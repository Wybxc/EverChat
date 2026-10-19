# 通知投递子系统：Cloudflare 隔离测量

2026-10-18 11:23:23–11:23:40 UTC。临时 Worker `everchat-notification-pipeline-validation` 使用独立随机 VAPID 和验证口令，未使用生产数据、供应商 API、R2、Workflow 或真实推送网关。测试完毕已清空六个测试对象的数据及 Alarm、删除 Worker，并核对 API 返回 404；测试密钥及本地夹具数据库也已删除。[清理证据](notifications-pipeline-cleanup.json)

## 覆盖范围

从生产 `CompletionOutbox` 的持久登记开始，经真实 Alarm、Library RPC、生产 `Library`／`NotificationRegistry`、真实 SQLite 和生产 Web Push 加密发送，终点为内存模拟网关 201。每次加密请求校验请求方法、测试端点、VAPID 头、`aes128gcm` 和 4,096 字节负载，禁止其他外部请求。独立解密和签名验证沿用[此前加密测量](notifications-cloudflare-2026-10-18.md)。

使用专用 Producer DO 承载原生产 outbox，未生成聊天消息；所以测到的是通知子系统，不包括模型流、正文存储和完整 Conversation 的其他维护。Library 使用生产实现，保留其正常调度及维护查询。无焦点 WebSocket、网关故障或重试；这些规则仍由既有回归覆盖，本轮不报告它们的独立成本。真实设备收件结果另见[真机记录](notifications-cloudflare-2026-10-18.md#首次生产设备验证)。

## 原生 SQL 与批量投递

0、1、9 个订阅各完成一次，成功加密提交共 10 次，完成项最终均为 `done`，Producer outbox 均清空。[功能及原生游标计数](notifications-pipeline-functional.json)

| 启用订阅 | Producer 读／写 | Library 读／写 | 两者合计写入 | 成功提交 | Library Alarm 设置次数 |
| -------- | --------------- | -------------- | ------------ | -------- | ---------------------- |
| 0        | 4／3            | 9／0           | 3            | 0        | 0                      |
| 1        | 4／3            | 29／6          | 9            | 1        | 2                      |
| 9        | 4／3            | 100／54        | 57           | 9        | 3                      |

读写值合计全部 SQL 分类，来自 Cloudflare SQLite 游标的 `rowsRead / rowsWritten`，包括索引影响；不是 SQL 语句数。计数窗口从准备完成后开始，不包含建表、预置订阅、观察用 SQL 或最终 `deleteAll()`。平台 CPU 会包含这些操作及计数器开销，不能直接以此表充当账户账单。

当前每次分发最多 8 项。9 个订阅需要第二批，全部完成且没有丢失；多出的 Alarm 设置也包含最后的 TTL 清理调度，不能把设置次数当作已经执行的 Alarm 次数。保留批次 8，未因样本成功提高上限。未启用任何订阅时，仍有一次 outbox／RPC 的基线成本。

## 平台 CPU 与请求观测

[脱敏实时 tail](notifications-pipeline-tail.json)收到 55 个事件，无解析错误、丢弃或未完成帧，均为 `ok`：普通 Worker 19 项、Library 17 项、Producer 19 项，CPU 最大值分别为 2ms、21ms、3ms。该观测包含准备、报告及清理，不把某个 CPU 样本强行归因到一次加密，也不宣称实时 tail 覆盖了所有账单请求。

普通 Worker 的免费层单次 CPU 为 10ms；DO 默认单次 CPU 为 30 秒。本轮发送在 Library DO 中，21ms 不能与普通 Worker 的 10ms 限制混为一谈。少量样本不保证长期账户用量，也不替代每日请求／GB-s／SQL 资源管理。[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[DO 限制](https://developers.cloudflare.com/durable-objects/platform/limits/)

[初次聚合查询](notifications-pipeline-metrics-partial.json)仅取得 8 次普通请求的早期样本，最大 CPU 2.946ms，DO 聚合数组为空；[清理后重查](notifications-pipeline-metrics-after-cleanup.json)全部为空。因此本轮不提供聚合总 CPU、DO 请求账单、GB-s 或存储账单数值，不将空数组当作零消耗。有效证据为上述实时平台 CPU／请求事件和原生游标计数。

## 复测入口

配置为 `config/wrangler.validation.jsonc --env notification-pipeline`，脚本为 `scripts/measurements/notifications.ts`。每次先确认同名 Worker 不存在，生成仓库外的随机测试 VAPID／验证口令文件（0600），部署后写入 Secrets；勿复用生产密钥。运行脚本前先连接 tail：

```sh
pnpm exec wrangler deploy --config config/wrangler.validation.jsonc --env notification-pipeline
pnpm exec wrangler secret bulk <测试密钥文件> --config config/wrangler.validation.jsonc --env notification-pipeline
pnpm measure tail --worker everchat-notification-pipeline-validation --seconds 60 --output /tmp/notifications-pipeline-tail.json
pnpm measure notifications --suite pipeline --url <部署返回地址> --secrets <测试密钥文件> --output /tmp/notifications-pipeline-functional.json
pnpm exec wrangler delete --config config/wrangler.validation.jsonc --env notification-pipeline --force
```

tail 与功能脚本在不同终端运行。功能脚本结束会对每个测试对象执行 `deleteAll()` 并清除 Alarm；随后删除临时 Worker，核对 404，再删除测试密钥。若中断发生在脚本清理之前，应先核对本次测试对象的状态，不重复生成未知结果的任务，也不将未完成样本写成通过。报告不含订阅地址、加密负载、私钥、JWT、聊天内容或生产身份。
