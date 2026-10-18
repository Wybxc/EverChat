# 回答通知：Cloudflare 加密路径与点击回归

2026-10-18。通知实现和生产 Secrets 已部署；本轮补充独立平台测量，定位并修复发送请求的运行时兼容性问题。真实设备系统推送仍待用户主动授权与验收。

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

独立通知加密单测、类型检查、生产构建和格式检查通过。此前完整 40 项 PWA 回归保持原记录，本轮没有重新宣称执行全套。目标中的真机验收继续保留：Apple／FCM 实际网关、iOS／macOS PWA 锁屏／挂起／关闭投递、系统激活、权限撤销、专注模式及 Access 过期后的通知点击。

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
