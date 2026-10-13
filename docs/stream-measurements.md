# 流式资源测量

此工具用于路线图阶段 0 的改造前后比较，不证明 Cloudflare 免费层已通过验收。

## 本地运行

```sh
pnpm measure:stream
pnpm measure:stream --chunks 120 --interval 100 --size 200 --output /tmp/everchat-stream-comparison.json
```

工具启动独立 Vite／Cloudflare 本地运行时，使用临时存储和 `provider.test` 模拟 HTTP 响应，不调用真实模型。三个场景分别为在线正文、在线正文加思考，以及收到第一段回答后关闭唯一订阅。每个场景检查完整持久化结果、输出长度和实际供应商增量数，最后停止服务器并清理本次临时数据。默认监听 5184；可用 `--port` 修改。默认本地密码为 `everchat-local`，环境变量 `EVERCHAT_TEST_PASSWORD` 可覆盖，不输出密码。

首次报告位于 [stream-baseline.json](measurements/stream-baseline.json)。比较时使用另一输出路径，避免覆盖基线；相同负载下检查资源变化，时间调度会让检查点数略有浮动。

## 指标与边界

| 字段 | 含义 |
|---|---|
| `coverage` | `claim-to-terminal` 表示完整测量窗口；DO 在途中休眠或重启导致内存计数丢失时，用 `since-last-resume` 标明不完整，基线工具拒绝将它作为完整报告 |
| `elapsedMs` | 任务认领至终态的实际经过时间，包含网络等待；不是 CPU，也不是 Cloudflare 的 DO 计费时长 |
| `textDeltas`、`reasoningDeltas` | 供应商适配器输出的正文和已启用思考增量数 |
| `checkpoints`、`checkpointCharacters` | 已接受检查点数，以及各次提交的正文和思考长度之和；字符按 JavaScript 字符串长度计，用于识别重复发送全文 |
| `sqlStatements`、`sqlRowsRead`、`sqlRowsWritten` | 认领至终态期间 Conversation 的 SQL 语句和游标实际行计数；读完游标后采样，包含运行期间其他 API 查询，但不包含诊断读取 |
| `eventPayloadBytes` | 插入事件日志的 JSON 负载总 UTF-8 字节数，包含此窗口内的状态事件 |
| `broadcastFrames`、`broadcastBytes` | 此窗口内成功排入 WebSocket 发送队列的帧数和 UTF-8 字节数，按订阅数累计；不代表客户端已收到，也不含连接回放、心跳或传输协议开销 |
| `databaseBytes` | 终态时 SQLite 分配的数据库大小，含现有表、索引及诊断表；不是精确的消息负载大小 |
| `client` | 本地订阅实际收到的帧数和字节数，包含初始同步；标明是否在生成中断开，不测浏览器 Markdown 渲染或缓存写入 |

该窗口不包含构造与迁移、接受请求前的写入、Library、Alarm 写入、平台请求计量或 CPU。诊断报告在终态另外保存一行，便于 DO 休眠后读取，此写入不计入报告中的业务 SQL 行数。游标行计数由运行时给出，不能用业务 SQL 语句数替代；索引等操作可能使行写入数高于显式修改的业务行数。

计数开启会增加 UTF-8 大小计算、游标结果收集和诊断保存的开销。它适合定位数据放大和比较相同条件下的实现；平台 CPU 验收还需在关闭计数时测量。说明依据：[SQLite 游标计数](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#sql-api)。

## 部署后的诊断开关

默认关闭测量。设置 Worker 变量 `GENERATION_METRICS=1` 后，生成结束输出 `EVERCHAT_GENERATION_METRICS` 结构化计数，并保存各对话最近一次报告。登录后可读取 `/api/conversations/:id/measurements`；未开启时接口返回 404，开启时仍要求会话鉴权。报告不包含消息、提示词、供应商密钥或 SQL 绑定值，既不添加模型调用，也不自动重试生成。

实际免费层验收需另记录 Worker／Workflow CPU、DO 活跃时长、请求额度及账户级存储和读写总量；本地生成通过、账户登录成功或这一 JSON 报告都不能替代真实部署验证。浏览器渲染及缓存开销也需浏览器测量补齐。
