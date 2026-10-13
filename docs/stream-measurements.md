# 流式资源测量

此工具用于路线图阶段 0 的改造前后比较，不证明 Cloudflare 免费层已通过验收。

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
