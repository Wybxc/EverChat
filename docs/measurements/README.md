# 测量命令

统一入口为 `pnpm measure <command> [options]`，帮助为 `pnpm measure --help`。这些测量按需运行，不纳入日常 `pnpm check`。本地使用模拟模型与工具服务；Cloudflare 模式只连接事先显式部署的隔离验证 Worker，不操作生产对话或配置。

| 命令                                                            | 范围                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm measure stream`                                           | 本地正文、思考、断线续传及诊断计数                                                   |
| `pnpm measure stream --runtime cloudflare --suite functional`   | 部署后四协议、取消、慢客户端等功能验证                                               |
| `pnpm measure stream --runtime cloudflare --suite sustained`    | 分钟级持续生成                                                                       |
| `pnpm measure stream --runtime cloudflare --suite reconnect`    | 使用已有报告验证重连                                                                 |
| `pnpm measure stream --runtime cloudflare --suite history`      | 使用合成历史验证读取与重放                                                           |
| `pnpm measure tools`                                            | 本地工具诊断计数；用 `--scenario multi-round` 单独验证五轮工具、六次模型请求正常完成 |
| `pnpm measure tools --mode platform --suite functional`         | 本地真实 Workflow，关闭诊断计数；`all` 包含 large／sustained                         |
| `pnpm measure tools --runtime cloudflare --suite functional`    | 同一平台执行器连接独立工具验证 Worker                                                |
| `pnpm measure notifications --suite transport`                  | 隔离 Web Push 加密、VAPID 与模拟网关                                                 |
| `pnpm measure notifications --suite pipeline`                   | outbox、Alarm、Library 和多设备通知管线                                              |
| `pnpm measure usage`                                            | 本地 SQLite 合成账本，无网络请求                                                     |
| `pnpm measure usage --runtime cloudflare prepare\|run\|metrics` | 合成用量／分享的隔离平台准备、运行及指标查询                                         |
| `pnpm measure metrics`                                          | 根据完整测量报告读取 Cloudflare 平台分析                                             |
| `pnpm measure tail`                                             | 脱敏记录独立验证 Worker 的日志指标                                                   |

参数沿用各套件的明确校验，例如 `--output`、`--url`、`--credentials`、`--source`、`--account`。诊断和平台执行不合并计量口径：本地 SQL 计数、分配空间和墙钟时间均不等于 Cloudflare CPU、账单或账户额度。

## 本地复现

```sh
pnpm measure stream --chunks 12 --interval 5 --size 32 --output /tmp/everchat-stream.json
pnpm measure tools --scenario multi-round --chunks 12 --interval 5 --size 32 --output /tmp/everchat-tools.json
pnpm measure tools --mode platform --suite functional --output /tmp/everchat-platform
pnpm measure usage
```

本地启动器持有进程及临时状态，正常结束、启动失败和执行异常均关闭进程并移除其临时目录。Worker 输出不进入报告，避免绑定或凭据泄露。协议订阅统一处理握手超时、就绪前关闭、解析失败、增量确认和断线。

## Cloudflare 隔离环境

`config/wrangler.validation.jsonc` 集中 stream、tools、notifications、notification-pipeline、usage 五个命名环境。部署必须同时选择该文件与 `--env`；各环境使用独立 Worker 名称、DO／Workflow 和模拟上游，不复用生产绑定。用途与字段可用本地打包核对：

```sh
pnpm exec wrangler deploy --dry-run --config config/wrangler.validation.jsonc --env tools
```

用量测量的 `prepare` 从 usage 配置生成私密运行目录内的配置，再加入该次随机凭据与账户，不在仓库保存密钥。通知 transport 与 pipeline 使用不同 Worker；两者均可显式指定 `--runtime local --url http://127.0.0.1:5182` 连接已启动的隔离运行时，同一端口每次只运行一种夹具。

实际部署、Access 凭据、采样边界和资源清理步骤分别见 [流式](stream-measurements.md)、[工具](tool-platform-validation.md)、[通知加密](notifications-cloudflare-2026-10-18.md)、[通知管线](notifications-pipeline-2026-10-18.md)、[用量与分享](usage-sharing-implementation-2026-10-19.md)。验证后清理当次资源；历史报告继续保留其当时版本和实际测量结果。
