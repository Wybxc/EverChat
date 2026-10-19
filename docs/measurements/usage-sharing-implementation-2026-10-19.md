# 费用统计与只读分享实施记录

状态：已部署费用统计与分享代码，生产离线迁移和私有接口验收通过；Access 路径配置待最终保存确认，匿名分享尚未完成生产验收。

## 已实现的费用链路

- 独立 UsageStore namespace 保存请求账本、价格版本和按小时聚合；金额使用万亿分之一原币的整数，不混加币种。
- 在真实网络调用前保存请求身份与价格快照；对话／摘要、标题、能力检测和联网服务共用低频 outbox。每轮工具模型独立记录，一个回答只计一次。
- 最终用量与普通生成终态在同一事务记录；孤立请求恢复为未知，不重发供应商请求。复用原有解析检查点，不增加逐 Token 全局写入。
- 对话删除保留待投递计费事实；已入账记录不随对话、模型配置或供应商删除。
- 统计弹窗包含范围、供应商、模型、类型、状态筛选，概览、趋势、分组和游标分页；定价、同供应商价格复制、显式补算、人工修正和 CSV。回答生成信息可查询该回答的模型及联网请求费用。
- 没有价格与明确零价分开；不完整细项仅计可计算部分。缓存、思考不再重复加价，缓存命中率只采用同时报告输入与缓存读取的请求。

## 已取得的本地证据

| 检查                                                   | 结果与覆盖范围                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                            | 427 项通过，包括计价、幂等、时区边界、CSV 公式防护和离线版本 1 → 2 补丁                                                                     |
| `pnpm test:operations`                                 | 原生 workerd 维护通道通过；补丁导入、重试、鉴权及无关数据隔离                                                                               |
| `pnpm build` / `pnpm typecheck`                        | 全项目类型检查及生产构建通过；13 项必需预缓存，966.92 KiB                                                                                   |
| `tests/integration/generation/usage.spec.ts`           | 四种协议真实调用各一条；重复提交去重、最终用量、删除后保留；另验证能力检测成功与 HTTP 401、独立标题／摘要调用、取消后部分用量和实例中断恢复 |
| `tests/integration/generation/alarm.spec.ts`           | 7 项原有生成／取消／重启集成通过                                                                                                            |
| `tests/integration/web-tools/web-tool-service.spec.ts` | 四种协议的真实 Tavily 适配路径均验证两次模型＋两次联网＝四次请求、一个回答                                                                  |
| `tests/e2e/usage/usage.spec.ts`                        | Chromium 和 WebKit 各两项通过，覆盖桌面／手机弹窗、筛选、定价、补算、CSV、人工修正、SPA 定位回答与关闭；已查看截图                          |

上述自动化测试使用隔离数据库和模拟上游，不代表供应商账单对账。后续生产纯测试请求单独记录如下。

## 本地存储测量

重现命令：`node --import tsx/esm scripts/measurements/usage-ledger.ts`。

1,000 次合成请求，三个供应商、十个模型，每次依次写入 running 和 completed：空库 49,152 字节，最终 1,368,064 字节，增加 1,318,912 字节（约 1.26 MiB）；10,000 条 SQL，返回 2,490 行，逻辑改变 5,000 行。本机一次运行耗时 47 ms，仅用于复现观察，不作为性能保证。

这些数字仅覆盖中央账本，**不包含**调用方 outbox、价格 RPC、索引维护计费、实际扫描行、网络与其他聊天写入。Node SQLite 耗时不能代表 Workers 10 ms HTTP CPU、DO CPU 或账单；下文另列 Cloudflare 实测及其限制。UsageStore 与 ShareStore 共享账户 5 GB SQL 存储，不能把 namespace 当成额外免费额度，也不能将单对象上限视为预留空间。现有对话理论预算约 4 GiB，Library 另有 256 MiB 保护，剩余空间必须与两项新功能共同核算；不新增每日应用消费限制或自动删账。

## 数据库与生产准备

Conversation／Library 的版本 2 增加空的 `usage_outbox`；版本 1 对象会拒绝新业务代码，需在维护窗口由本地工具生成补丁。已覆盖未删除和已删除对象的离线转换、补丁回放与数据不变。新建 UsageStore 使用独立初始版本 1，不对历史消息回填消费。

2026-10-19 已依次完成维护部署、控制面与 Library 引用联合枚举、65 个对象备份、本地 schema 1 → 2 转换、补丁导入、逐行／结构／清单验证和临时回执清理。原业务行与 282 条消息均保留，转换只增加空的 `usage_outbox`；没有在线补字段、回填旧消费或重建搜索。

正式业务部署版本为 `8877e562-2bfe-49ab-8ffd-ba27aa079beb`。恢复后逐页读回 63 个可见对话，282 条消息 ID 全部保留；快照与存储接口均正常。统计、定价、分享管理等六个私有接口返回成功，临时 `/api/__operations/identity` 为 404；匿名私有 API 和认证恢复仍被 Access 拦截。部署绑定包含 Conversation、Library、UsageStore、ShareStore；新增 `SHARE_LINK_KEY` 仅保存在 Worker Secret。

270 个运维 JSON／SQLite 文件已转存本机被 Git 忽略的 `.wrangler/operations/storage-2026-10-19-usage`，复制前后核对 SHA-256，目录 0700、文件 0600；不包含 Access 令牌。它是 SQL 迁移备份，不包含 R2 附件。

生产只发送一条有 128 Token 输出上限的官方 DeepSeek Flash 纯测试请求，不带历史、私人系统提示或工具。回答成功，供应商报告输入 30、输出 6、总计 36 Token，缓存读取 0；账本记录一条 completed／最终用量，一个回答。尚未配置价格时保留 `unpriced` 与空金额，不显示为零费用。相同两条消息已冻结并发布 1 天测试分享，持有令牌的生产读取成功；匿名访问待 Access 调整。此验收不等于核对供应商账户账单，也未修改用户定价。

## 统计收尾与分享验收

趋势按实际时间间隔定位，空白时段保留空隙；夏令时重复小时用偏移量区分。大分页测试覆盖同一时间戳的 238 条记录，没有遗漏或重复。独立摘要和取消后部分用量已用模拟上游通过原生运行时验证。

分享在 `shared/sharing`、`worker/sharing` 和 `src/features/sharing` 中实现。当前分支冻结为白名单文本分块，预览完整性校验后发布；默认不含思考，附件省略。支持有效期、跨设备复制密文、令牌轮换、撤销、列表与清理，对话删除先撤销分享。公开读取每页检查最新状态；无效或撤销返回统一 404，不写访问日志或缓存正文。

Chromium／WebKit 各通过两项运行时分享测试与桌面／手机管理测试；包括匿名无 Access cookie、无私有 API／IndexedDB 访问、XSS／危险链接、远程图片不自动加载、思考开关、并发预览幂等、预览后源变化、不可变快照、大正文分页、HEAD／条件读取、轮换、撤销及原对话删除。已核对公开桌面／手机、预览弹窗和统计截图。

真实生产构建的 PWA：Chromium／WebKit 的既有按需缓存与 Cloudflare Assets 共 8 项通过；新增分享用例两端均通过，验证已控制分享页的 SW 安全头、公开数据不进入 CacheStorage、分享页不阻塞更新、加载新版本模块后断网不显示旧正文。Workbox 会替换传入的请求为 `/index.html`，已在调用前保留原导航路径，以免漏设分享 CSP。

## Cloudflare 合成资源测量

仅部署临时 `everchat-usage-sharing-validation`，没有生产 DO、R2、Workflow、Access 绑定或真实 AI 请求。复现流程：

```sh
node --import tsx/esm scripts/measurements/usage-sharing-cloudflare.ts prepare --directory <private-directory> --account <account-id>
pnpm exec wrangler deploy --config <private-directory>/worker.json
node --import tsx/esm scripts/measurements/usage-sharing-cloudflare.ts run --directory <private-directory>
node --import tsx/esm scripts/measurements/usage-sharing-cloudflare.ts analytics --directory <private-directory>
node --import tsx/esm scripts/measurements/usage-sharing-cloudflare.ts clear --directory <private-directory>
pnpm exec wrangler delete --config <private-directory>/worker.json --force
```

配置与认证值只存在 0700 私有目录的 0600 文件，不打印或提交。`run` 保存可公开的合成结果，`clear` 删除本轮三个测试对象的内容，再删除临时 Worker。原始合成报告：[functional JSON](usage-sharing-cloudflare-functional.json)。

2026-10-19T03:29:10Z–03:29:37Z，100 次合成调用采用“价格 RPC → outbox 初始投递 → outbox 终态投递”的完整两次投递路径；一个供应商和模型：

| 范围          | SQL 次数 | `rowsRead` | `rowsWritten` |         分配字节 |
| ------------- | -------: | ---------: | ------------: | ---------------: |
| 中央账本      |    1,100 |        696 |         1,104 | 53,248 → 155,648 |
| 调用方 outbox |    1,000 |      1,000 |           500 |  16,384 → 16,384 |

共 300 次调用方到中央账本 RPC，每次模型调用三个；不包含测试包装入口 RPC。100 次合成调用新增统计写入 1,604 行，约为每日 100,000 行免费额度的 1.6%；这**不是**整个聊天链路的写入量，原生成、索引、通知、Alarm 等仍需另计。未投递初态就完成的短请求可能只投递终态，重试则可能增加 RPC 和读写。字段及索引读写按 Cloudflare 游标消费完成后的计数采集，而非用 SQL 返回行数冒充扫描／计费行数。[游标计数](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

分享合成快照为 10 条文本消息、10 块，共 491,520 UTF-8 正文字节：创建 20 条 SQL、15 行读、28 行写，数据库 45,056 → 544,768 字节。30 次分页读取共 60 条 SQL、130 行读、**0 行写**，每页 4／4／2 块；撤销与回收后数据库为 45,056 字节。本次源分支投影、跨对象传输、Alarm 写入、CSP 渲染和真实 HTTP 鉴权分别由功能测试覆盖，不计入此仓储微基准，不能用这些数字宣称整个分享创建只有 28 行写入。

Cloudflare Adaptive HTTP 指标覆盖同一窗口，返回 60 次请求、0 个采样错误，平均 sampleInterval 约 1.54；CPU P50 839 µs、P99／最大 2,161 µs。它是测量包装入口的采样指标，不代表生产 Access JWT 验证或全部请求的 CPU 上界。两个 DO 指标数据集返回空数组，未取得 DO CPU／活跃时长，不将零条数据解释为零消耗。合成过程没有等待 AI 上游，活跃时长也不能外推真实回答时长。[原始采样结果](usage-sharing-cloudflare-analytics.json)

测量后已清空三个合成对象并删除临时 Worker，没有保留测试公开入口。

共享容量规划已写入[免费层资源政策](../architecture/free-tier-resource-policy.md)：以实际账户总量为准，账本和分享各 128 MiB 仅作为运维复查观察点；不增加应用每日消费限制，不自动删账，不删除有效快照。

## 仍待完成

1. 私有 API 已验证。现有 Access 应用已准备收窄为 `/api`、`/api/*`、`/auth`、`/auth/*`，原 Allow 身份／AUD 保留；控制台尚未保存，等待最终公开范围确认。
2. 路径保存后完成生产匿名访问、令牌轮换、撤销与私有鉴权验收，并核对 GitHub 自动构建。已有 SW 的 Chromium／WebKit 生产构建测试通过，不能冒充独立 iOS／macOS PWA 真机验收。
3. DO 平台 CPU／时长数据缺失作为测量限制保留，当前不宣称完整生产链路在任何负载下均满足免费层。
