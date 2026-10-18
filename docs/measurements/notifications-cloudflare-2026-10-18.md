# 回答通知：Cloudflare 加密路径与点击回归

2026-10-18。通知实现和生产 Secrets 已部署；本轮补充独立平台测量，定位并修复发送请求的运行时兼容性问题。macOS 后台及退出 App 后的真实推送与点击已获用户确认；iOS 仍在排查订阅保存问题。

## 发现与修复

隔离 Worker 首次调用生产 `sendWebPush` 时返回 500：Cloudflare 的 `Request` 不接受 `redirect: 'error'`。Node 单测的 mock 没有覆盖这个平台行为。

通知发送改为 `redirect: 'manual'`，禁止跟随网关重定向，不向其他 URL 转发 VAPID 凭据。返回的 3xx 由已有投递规则按失败终止，不当作成功，也不盲目重试。修复后的生产发送函数通过以下平台验证。

## 实际测量范围

- 临时 `everchat-notifications-validation` Worker 直接导入生产通知加密／发送函数，使用独立随机测试密钥、接收端 ECDH 密钥和测试订阅。
- 仅允许 Apple／FCM 测试路径；网关由内存 mock 返回 201，拒绝其他外部请求。没有真实推送、生产数据、DO、SQL、R2 或 AI 请求。
- 5 次无加密基线、10 次加密调用；Apple 和 FCM audience 各 5 次。Node 使用独立 ECDH／HKDF／AES-GCM 解密并验证内容，同时验证 VAPID ES256 签名与 audience，10 次全部通过。每条加密负载为 4,096 字节（库的默认填充）。见[功能报告](notifications-cloudflare-functional.json)。
- [平台分析](notifications-cloudflare-metrics.json)在该分钟统计 18 次请求、错误计数 0、总 CPU 49.922ms、最大 7.999ms、P50 2.474ms。分析含身份／基线请求且采用自适应采样（平均 sample interval 约 1.385），不能据此计算每条实际通知的精确均值。
- [脱敏 tail](notifications-cloudflare-tail.json)接收 11 项事件，其中 3 项加密请求的 CPU 分别为 7、6、4ms，outcome 均为 `ok`。它没有覆盖全部 10 次加密，不能当作完整请求账单。

功能报告中的 `serverElapsedMs: 0` 不是零 CPU：Workers 在没有真实 I/O 的区间时钟可能不推进。CPU 结论只使用平台分析／tail，不能使用该字段推断计算成本。

普通 [Workers Free](https://developers.cloudflare.com/workers/platform/limits/) HTTP 请求上限为 10ms CPU；这次加密 wrapper 的样本低于该值。生产发送发生于已有 Library DO，仍应按 [DO 调用限制](https://developers.cloudflare.com/durable-objects/platform/limits/)及免费层每日资源核算。此次没有测量完整 Library Alarm、焦点确认、SQL、重试或多设备分发，不能证明其整体用量，也不据此提高批次。

## 点击与本地回归

新增生产 SW 浏览器测试：模拟通知点击后通过 SPA 定位对应对话／回答分支，文档没有重载，开启新对话后原草稿仍在。测试通过，合成事件没有系统用户激活，因此不宣称验证了操作系统窗口唤醒。

独立通知加密单测、类型检查、生产构建和格式检查通过。此前完整 40 项 PWA 回归保持原记录，本轮没有重新宣称执行全套。真机验收的已完成与剩余范围见下文；合成点击回归本身不证明系统激活。

## 首次生产设备验证

修复 `bc30ebd` 的 Cloudflare 自动构建成功。用户已在 macOS 独立 PWA 允许系统通知，最初反馈「页面通知可用」；随后只读原生 AX 检查确认设置面板实际显示「后台推送已就绪」，说明订阅登记已完成。首次反馈与后续状态不同，尚不据此推断确定的同步耗时或失败原因。

2026-10-18 09:27:31–09:27:35 UTC，最小化该 PWA 后，通过现有生产聊天接口使用 DeepSeek Flash 完成一次「后台通知验收（纯测试）」回答，使用独立测试提示词、无附件／联网工具，不读取私人聊天内容。用户确认「收到，点击后定位正确」。

2026-10-18 09:38:59–09:39:03 UTC，用户确认完全退出 EverChat App 后，再完成一条「关闭应用通知验收（纯测试）」回答。用户确认「收到，重新打开并定位正确」。这两项是 Apple 真实网关／macOS 系统推送证据，并分别覆盖已有窗口和 App 退出后的点击定位；不扩展为锁屏、iOS、FCM 或 Access 过期验收。

该分钟的[生产平台初次分析](notifications-production-metrics.json)提供了真实请求、CPU 和 SQL 样本，但覆盖整个 namespace，包含测试生成、身份校验、同步和可能的其他活动，不能作为通知的独立增量成本。主要原值如下：

| 范围            | 请求／CPU                                               | SQL／其他                                                                                              |
| --------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 普通 Worker     | 7 次请求，CPU 合计 33.016ms、最大 10.458ms，错误计数 0  | 不能宣称所有普通请求均低于 10ms；运行时有偶发超限缓冲，不应依赖它                                      |
| Conversation DO | periodic CPU 47.798ms、活跃 1.246s                      | 267 行读、156 行写；invocation 数据还有 2 次 RPC 和 1 次 Alarm 的 `clientDisconnected`，不写成全部成功 |
| Library DO      | 21 次 RPC、10 次 Alarm，periodic CPU 73.384ms、活跃 60s | 1,677 行读、49 行写；整个分钟保持活跃，原因及通知增量不能仅靠该汇总归因                                |

两类 DO 的 CPU／内存超限及 fatal internal 计数均为 0。指标为采样、最终一致的观测，既不等同账单，也不能用少量成功样本保证长期免费层用量。

## iOS 订阅保存排查

用户在 iOS 主屏幕 PWA 授权后，重试仍显示「页面通知可用」及「请求内容不是有效的 JSON 对象」。这是订阅登记 API 的解析／校验错误，不能解释为 Apple 网关投递失败。

原实现直接使用 `subscription.toJSON()` 并强制断言内部类型；原校验要求 `expirationTime` 必填。已复现省略过期时间的合法订阅字典被原校验拒绝。修复显式读取浏览器订阅，按标准编码密钥、将未指定过期时间置为 `null`；API 同时接受省略过期时间。新增错误诊断只返回已知字段路径，不返回敏感值。尚未抓取真实 iOS 请求，具体字段需通过更新后的重试结果确认。

投递端增加脱敏日志 `EverChat notification delivery`，区分网关接受、失效订阅、可重试和终止失败，异常仅记录固定允许的类型名。日志不含订阅 URL、公钥材料、聊天内容、异常原文；`accepted` 只表示网关接收，不表示用户已读。

## 复测与清理

配置为 `wrangler.notification-validation.jsonc`。每次先确认同名 Worker 不存在，再在仓库外生成独立 P-256 VAPID 密钥和随机 `VALIDATION_SECRET`（0600 文件），部署该配置并写入其 Secrets。不要使用生产密钥。使用以下入口，结束后删除临时 Worker 并通过 Cloudflare API 核对 404：

```sh
pnpm exec wrangler deploy --config wrangler.notification-validation.jsonc
pnpm exec wrangler secret bulk <临时密钥文件> --config wrangler.notification-validation.jsonc
pnpm measure:cloudflare-tail --worker everchat-notifications-validation --seconds 90 --output /tmp/notifications-tail.json
node --import tsx/esm scripts/measurements/notifications-cloudflare.ts --url <部署返回的workers.dev地址> --secrets <临时密钥文件> --output /tmp/notifications-functional.json
pnpm exec wrangler delete --config wrangler.notification-validation.jsonc --force
```

鉴权令牌、公私钥、订阅地址、JWT 和加密负载均未写入报告。清理证据见[清理记录](notifications-cloudflare-cleanup.json)。
