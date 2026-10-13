# 流式资源测量

本地工具用于路线图阶段 0 的改造前后比较；隔离部署工具用于记录真实平台指标。两者的测量窗口和计量口径分别说明，不能互相替代。

## 本地运行

```sh
pnpm measure:stream
pnpm measure:stream --chunks 120 --interval 100 --size 200 --output /tmp/everchat-stream-comparison.json
```

工具启动独立 Vite／Cloudflare 本地运行时，使用临时存储和 `provider.test` 模拟 HTTP 响应，不调用真实模型。三个场景分别为在线正文、在线正文加思考，以及收到首个实时预览后关闭唯一订阅。每个场景检查完整持久化结果、输出长度和实际供应商增量数；在线场景还检查客户端增量回放与数据库最终快照一致。最后停止服务器并清理本次临时数据。默认监听 5184；可用 `--port` 修改。默认本地密码为 `everchat-local`，环境变量 `EVERCHAT_TEST_PASSWORD` 可覆盖，不输出密码。

报告默认写入系统临时目录中的 `everchat-stream-measurements.json`。首次报告位于 [stream-baseline.json](measurements/stream-baseline.json)，增量日志检查点报告位于 [stream-incremental.json](measurements/stream-incremental.json)，DO 执行迁移报告位于 [stream-do.json](measurements/stream-do.json)，分层保存报告位于 [stream-layered.json](measurements/stream-layered.json)。使用 `--output` 保存比较结果；相同负载下检查资源变化，时间调度会让检查点数略有浮动。

## 指标与边界

| 字段 | 含义 |
|---|---|
| `executor` | 当前报告执行器为 `do-v1`；历史报告保留当时的口径。用于区分执行迁移前后路径，不据此推断 CPU 或平台请求数量 |
| `coverage` | `claim-to-terminal` 表示完整测量窗口；DO 在途中休眠或重启导致内存计数丢失时，用 `since-last-resume` 标明不完整，基线工具拒绝将它作为完整报告 |
| `elapsedMs` | 任务认领至终态的实际经过时间，包含网络等待；不是 CPU，也不是 Cloudflare 的 DO 计费时长 |
| `textDeltas`、`reasoningDeltas` | 共享解析器识别的正文和已启用思考增量数，当前在最终日志整理时汇总 |
| `checkpoints`、`checkpointBytes` | 当前报告（版本 2）的已接受提交数和实际原始 SSE 字节数，不含 base64 编码及同步元数据。历史版本 1 的 `checkpointCharacters` 是正文／思考字符数，不能直接与字节数相减 |
| `sqlStatements`、`sqlRowsRead`、`sqlRowsWritten` | 认领至终态期间 Conversation 的 SQL 语句和游标实际行计数；读完游标后采样，包含运行期间其他 API 查询，但不包含诊断读取 |
| `eventPayloadBytes` | 插入事件日志的 JSON 负载总 UTF-8 字节数，包含此窗口内的状态事件 |
| `broadcastFrames`、`broadcastBytes` | 此窗口内成功排入 WebSocket 发送队列的预览、保存确认和状态帧数和 UTF-8 字节数，按订阅数累计；不代表客户端已收到，也不含持久化事件回放、心跳或传输协议开销；重连时发送的内存预览尾部计入 |
| `databaseBytes` | 终态时 SQLite 分配的数据库大小，含现有表、索引及诊断表；不是精确的消息负载大小 |
| `client` | 本地订阅实际收到的帧数和字节数，包含初始同步；标明是否在生成中断开，不测浏览器 Markdown 渲染或缓存写入 |

该窗口不包含构造与初始化、接受请求前的写入、Library、Alarm 写入、平台请求计量或 CPU。诊断报告在终态另外保存一行，便于 DO 休眠后读取，此写入不计入报告中的业务 SQL 行数。游标行计数由运行时给出，不能用业务 SQL 语句数替代；索引等操作可能使行写入数高于显式修改的业务行数。

计数开启会增加 UTF-8 大小计算、游标结果收集和诊断保存的开销。它适合定位数据放大和比较相同条件下的实现；平台 CPU 验收还需在关闭计数时测量。说明依据：[SQLite 游标计数](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#sql-api)。

## 部署后的诊断开关

默认关闭测量。设置 Worker 变量 `GENERATION_METRICS=1` 后，生成结束输出 `EVERCHAT_GENERATION_METRICS` 结构化计数，并保存各对话最近一次报告。登录后可读取 `/api/conversations/:id/measurements`；未开启时接口返回 404，开启时仍要求会话鉴权。报告不包含消息、提示词、供应商密钥或 SQL 绑定值，既不添加模型调用，也不自动重试生成。

实际免费层验收需另记录 Worker／DO CPU、DO 活跃时长、请求额度及账户级存储和读写总量；本地生成通过、账户登录成功或这一 JSON 报告都不能替代真实部署验证。浏览器渲染及缓存开销也需浏览器测量补齐。


## 分层保存检查点

当前实现以 100ms 预览、1.5 秒或 32 KiB 提交运行，单组最多 64 KiB／32 个微批次。客户端接收确认用于限制慢订阅的预览窗口，只有服务端保存确认能推进持久化状态。WebSocket 接收确认属于平台请求计量，当前 JSON 不测量其 CPU 或计费请求数。

同负载的 SQL 写入行数从三个场景各 169 行降到 24、29、44 行；事件字节数基本持平。端到端测试另外检查了浏览器生成中导出不含尚未确认的预览、终态缓存与云端一致，以及 40 个增量场景的完整快照缓存写入少于 10 次。缓存写入频率也有独立的模拟时钟测试；这些结果不等于浏览器渲染或平台 CPU 测量。

## 原始流解析检查点

客户端即时解析原始供应商字节，服务端高频路径只转发和保存；服务端在快照读取和最终整理时使用同一解析器。原始批次允许截断 UTF-8、SSE 和 JSON，快照携带未完成事件、字符与协议状态。最终校验完成原因和用量后原子整理消息并删除原始日志。每次读取新的上游片段前等待当前提交完成，避免持久化落后时无限接收。

同负载的报告见 [stream-raw.json](measurements/stream-raw.json)。提交次数仍为 3、4、7，SQL 写入为 26、31、46 行；相比上一检查点每个场景多 2 行，用于供应商结果元数据。原始事件包含供应商协议字段，并以 base64 放入 JSON 同步帧，事件负载增至 162,485、306,386、548,297 字节，比语义增量版本增加约 27%、24%、20%。这一步转移高频语义解析，仍保留字节封装与编码开销，不据本地经过时间声称 CPU、请求计费或活跃时长下降。

四种协议的浏览器回归均将半个 UTF-8 字符保存为检查点，再从 API 快照重连，验证正文、思考和供应商用量一致。上游提前结束、保存失败、停止、关闭页面与慢订阅仍保留已有语义。原始响应限 4 MiB；正文与思考各限 100,000 字，单个 SSE 数据事件限 256 Ki 字符。云端语义校验在读取／最终整理时进行，不能把客户端解析报错当作已终止上游的证明。

## Workers Free 隔离部署验证

2026-10-13 在用户确认的 Workers Free 账户部署 `everchat-stream-validation`，关闭生成诊断计数，使用独立 SQLite namespaces 和随机登录 Secrets。该入口只提供 API，真实供应商网络访问被禁止，所有模型响应均由模拟供应商产生。没有修改正式 Worker 或用户配置。功能报告见 [cloudflare-functional.json](measurements/cloudflare-functional.json)，平台报告见 [cloudflare-metrics.json](measurements/cloudflare-metrics.json)，清理确认见 [cloudflare-cleanup.json](measurements/cloudflare-cleanup.json)。

9 项功能场景全部通过：在线正文；正文加思考和第二订阅；首个预览后断开唯一订阅；四种协议保存半个 UTF-8 字符后读取快照并重连；慢订阅不确认而被断开、健康订阅完成及慢订阅恢复；取消并保存已接收前缀。每个场景重复提交同一请求 ID，终态重新订阅并比较数据库快照。长正文场景为 90,000 字符，慢订阅场景另含 90,000 字符思考。它验证实际平台上的 API／DO／WebSocket 链路，不包含网页渲染或真实供应商服务质量。

平台调用统计窗口为 `13:04:00–13:07:00 UTC`；9 项功能执行窗口约 66 秒。分钟取整会包含窗口内初始化和空闲活动。部署版本为 `0bafefa4-a493-4b5f-b83d-2ed4ef02474e`，生产代码基于 `58a1691`；存储采样随后在仅增加只读测量接口的版本上读取。

| 指标 | 实测 | 口径 |
|---|---:|---|
| Worker 请求 | 85 | Adaptive 数据，存在采样 |
| Worker 成功请求最高 CPU | 7.434ms | 当前样本最高值，不是未来上限 |
| Worker 所有状态最高 CPU | 12.448ms | 出现在 `responseStreamDisconnected`；未出现 `exceededCpu` |
| Worker 最高内存 | 约 13.94 MiB | isolate 采样，不含浏览器 |
| DO 调用 | 405 | 含 RPC、Alarm、HTTP 和休眠 WebSocket 事件；不直接等同于账单请求 |
| DO 总 CPU | 1.662 秒 | 两个 namespace 的 periodic 汇总 |
| DO 活跃时长 | 4.4149472 GB-s | Conversation 4.140958592，Library 0.273988608 |
| DO SQL 读取／写入 | 1,299／614 行 | 平台统计，含初始化、任务接受、同步、取消及 Library |
| DO CPU／内存超限、内部致命错误 | 均为 0 | periodic 计数 |
| 最终 SQLite 分配大小 | 3,608,576 字节 | 随后从部署对象读取；含 Library 和 10 个测试对话，其中一个是早期连接失败留下的空对话 |

DO 调用统计有 3 个 `clientDisconnected`、9 个 `responseStreamDisconnected`，对应断线状态，不能将它们写成“所有错误均为零”。这些状态下的生成及恢复断言仍通过。WebSocket 入站 periodic 计数返回 0，但 hibernation 调用返回 195，不能据前者宣称接收确认没有平台开销。SQL 存储 GraphQL 返回空数组；另读的 `databaseSize` 是最终分配大小，不能用来宣称平台存储计费量或生成中峰值已经测得。

本轮 DO 时长约占每日 13,000 GB-s 的 0.034%，SQL 写入占每日 100,000 行的 0.614%，读取占每日 5,000,000 行的 0.026%。若每天重复 10 套相同短负载，约为 44.15 GB-s、6,140 写入行和 12,990 读取行，尚有较大余量；这包含 90 次测试任务和测试中的多次读取／重连，不能外推成 90 次一分钟的真实模型响应。真实响应持续时间、输出大小、设备数、其他应用及额外工具调用会改变预算。

**这次短负载功能验证通过。** Worker 有一次超过免费层标称 10ms 的样本；官方允许偶发 CPU 波动，但不能依赖它持续超限。[Workers CPU 限制](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)。后续长流与重连补充结果见下节。当前报告作为改造后的平台基线；没有改造前的真实平台 CPU 报告，不能宣称 CPU 下降比例。

### 一分钟以上生成与重复重连

同日重新部署隔离入口，版本 `cd6b50c0-2da2-4b03-a037-80e164e9237f`，生产代码仍基于 `58a1691`，未修改生产流处理。测试继续关闭诊断计数、禁止真实供应商调用。报告见 [长流结果](measurements/cloudflare-sustained.json)、[长流指标](measurements/cloudflare-sustained-metrics.json)、[重连结果](measurements/cloudflare-reconnect.json)、[重连指标](measurements/cloudflare-reconnect-metrics.json) 和 [CPU 调用摘要](measurements/cloudflare-cpu.json)。

三项生成均使用 16,000 字符输入，每次接收 140 个增量、间隔 500ms，生成持续约 72 秒：

| 场景 | 正文／思考字符 | 断线行为 | 结果 |
|---|---:|---|---|
| 在线正文 | 84,000／0 | 保持订阅 | 实时结果、终态快照和完整回放一致 |
| 正文与思考 | 84,000／84,000 | 生成中重连 20 次，另保留第二订阅 | 两个客户端均恢复完整结果，无重复或缺口 |
| 首次预览后离线 | 84,000／0 | 关闭唯一订阅，每 5 秒查询终态 | 云端继续生成并完整保存 |

随后对已完成的正文与思考对话测试 30 次独立 WebSocket 连接，交替进行 15 次从头回放和 15 次最新游标连接；每次均与数据库快照一致并以 1000 正常关闭，没有再次调用模型。一次握手的临时连接重置经重试恢复，合计 31 次握手尝试。工具仅在此只读重连场景对三类临时网络错误最多重试三次，不重试生成或供应商请求。

| 指标 | 三项长流 | 30 次终态重连 |
|---|---:|---:|
| 平台调用窗口（UTC） | 13:44:00–13:49:00 | 13:56:00–13:58:00 |
| Worker 请求 | 86 | 34 |
| Worker 最高 CPU | 11.518ms | 5.738ms |
| DO 调用 | 613 | 94 |
| DO 总 CPU | 2.758946 秒 | 0.151010 秒 |
| DO 活跃时长 | 27.48776704 GB-s | 0.142772352 GB-s |
| DO SQL 读取／写入 | 2,361／872 行 | 880／3 行 |
| DO CPU／内存超限、内部致命错误 | 均为 0 | 均为 0 |

Worker 错误计数和资源超限计数均为零；DO HTTP 的断线状态仍计入错误，其中终态重连记录 30 次 `responseStreamDisconnected`，不能写成所有 DO 错误为零。调用数是 Adaptive 汇总，部分分组存在采样，不能直接等同账单请求数。WebSocket 的 periodic 入站计数仍为零，但长流含 449 次 hibernation 调用，接收确认的开销仍需纳入预算。

长流的成功 Worker 请求最高 CPU 为 11.518ms，断线状态最高 10.606ms。实时 tail 捕获的 Worker `/sync` 样本最高整毫秒值为 11ms；随后 30 次终态重连平台最高 CPU 为 5.738ms。tail 中 DO HTTP 也使用 `/sync`，必须先依据 `durableObject` 标志区分 Worker 与 DO，不能仅按路径比较不同 CPU 限制。捕获覆盖部分请求，尚未证明高样本的根因，也不能据后续低样本删去先前风险。[实时日志的覆盖边界](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)。

若每天重复 100 次这组负载的平均生成，**按本次三个样本外推**，约消耗 916.26 GB-s（每日额度约 7.05%）、29,067 行写入（约 29.07%）和 78,700 行读取（约 1.57%）。这不是 100 次实际测试，且包含长输入、长输出、思考、多订阅和重连；响应时长、设备数及其他应用会改变预算。供应商费用另计。

长流结束后的 Library 与三个 Conversation SQLite 分配合计 3,854,336 字节（约 3.68 MiB）。SQL 存储 GraphQL 仍无采样，不能将分配大小当作平台账单量或生成中峰值。隔离 Worker 及本轮两个 namespaces 已删除，随机 Secrets 已移除，见 [清理确认](measurements/cloudflare-sustained-cleanup.json)。

**阶段 0 的剩余验证：**当前快照接口把整个对话经 RPC 返回，再在 Worker 中序列化 JSON。长历史可能增加这个 10ms 路径的 CPU，需单独构造大历史测量并验证优化；这只是代码检查发现的风险，不能归因于本轮 `/sync` 的偶发高样本。平台存储采样及长期保留预算仍需补齐。

### 复现

使用项目的 Node 26 工具环境和 pnpm。先用 `pnpm exec wrangler whoami --json` 确认账户，确认 `everchat-stream-validation` 尚不存在，避免覆盖他人的验证环境。创建权限为 `0600` 的临时 JSON，包含随机 `APP_PASSWORD` 和至少 32 字符的随机 `SESSION_SECRET`；不要使用正式登录密码或供应商密钥，也不要打印或提交该文件。

```sh
pnpm exec wrangler deploy --config wrangler.stream-validation.jsonc
pnpm exec wrangler secret bulk /tmp/everchat-stream-validation-secrets.json --config wrangler.stream-validation.jsonc
pnpm measure:cloudflare --url https://everchat-stream-validation.YOUR-SUBDOMAIN.workers.dev --credentials /tmp/everchat-stream-validation-secrets.json --output /tmp/everchat-cloudflare-functional.json
pnpm measure:cloudflare-metrics --account YOUR_ACCOUNT_ID --functional /tmp/everchat-cloudflare-functional.json --url https://everchat-stream-validation.YOUR-SUBDOMAIN.workers.dev --credentials /tmp/everchat-stream-validation-secrets.json --output /tmp/everchat-cloudflare-metrics.json
```

功能报告即使失败也会保存；只有命令成功且 `complete: true`、9 项结果齐全才算通过。分析数据可能延迟，空数组不算零用量。指标读取需要账户分析权限；套餐由账户订阅或人工确认，`usageModel: standard` 不能单独证明 Workers Free。

补充负载使用以下命令。在独立终端先启动 tail，再运行测试；其输出只保留调用元数据，不保存请求头、正文、控制台文字或异常内容。JSON tail 没有人类可读的连接提示，以收到有效调用事件作为连接证据；无事件或部分捕获均不代表零 CPU。

```sh
pnpm measure:cloudflare-tail --seconds 300 --output /tmp/everchat-cloudflare-tail.json
pnpm measure:cloudflare --suite sustained --url https://everchat-stream-validation.YOUR-SUBDOMAIN.workers.dev --credentials /tmp/everchat-stream-validation-secrets.json --output /tmp/everchat-cloudflare-sustained.json
pnpm measure:cloudflare --suite reconnect --source /tmp/everchat-cloudflare-sustained.json --url https://everchat-stream-validation.YOUR-SUBDOMAIN.workers.dev --credentials /tmp/everchat-stream-validation-secrets.json --output /tmp/everchat-cloudflare-reconnect.json
```

两套报告分别要求 3 项和 30 项完整结果。使用 `measure:cloudflare-metrics --functional` 分别指定其报告，查询对应窗口，保留各自输出。资源删除后仍可用已保存的 namespace IDs 读取历史指标，不必为等待指标保留测试 Worker：

```sh
pnpm measure:cloudflare-metrics --account YOUR_ACCOUNT_ID --functional /tmp/everchat-cloudflare-sustained.json --namespace-report /tmp/everchat-cloudflare-sustained-metrics.json --output /tmp/everchat-cloudflare-later-metrics.json
```

延迟查询另写文件，以保留原报告中的部署存储样本。工具为每个数据集记录 `available`，空数组明确标为无数据。

本机存在系统代理时，Node 不会自动读取 macOS 代理设置。可按现有代理配置设置 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NODE_USE_ENV_PROXY=1`；WebSocket 工具使用显式代理 agent，保持 TLS 证书验证。

保存报告后执行 `pnpm exec wrangler delete everchat-stream-validation --config wrangler.stream-validation.jsonc`，检查 Worker 返回 404、两个本轮 namespace 已不在账户列表中，再删除临时 Secrets 文件。不要使用 `--force` 跳过其他 Worker 的依赖检查。若 namespaces 仍存在，只清理本轮创建的 namespaces，并再次核实；不要删除正式对话数据。
