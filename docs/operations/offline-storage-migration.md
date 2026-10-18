# 数据库离线运维迁移

数据库格式转换只在本地 Node.js 进程执行。对话访问、对象构造函数和 Alarm 不做旧数据转换。业务代码仅创建空库，并校验已有库的 `storage_schema`；版本不匹配时停止处理，要求先完成运维迁移。

Durable Object 的 SQLite 存储属于对象实例，不能像 D1 一样直接使用 `wrangler d1 execute`，也不能从本地文件原地修改云端数据库。因此迁移分为维护窗口内的导出、本地转换、写回和校验。云端临时程序只搬运 SQL 数据及执行已生成的参数化补丁，不运行历史格式转换或供应商流解析。[存储访问范围](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[Access 命令行认证](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/)。

## 实施顺序

先结束正在生成的回答、标题、联网工具调用及备份导入／复制。维护期间不启动这些任务。保留当前部署版本 ID，并暂停向 `main` 推送，避免自动构建打断维护窗口。

```sh
pnpm test
pnpm test:operations
pnpm build
pnpm exec wrangler deployments list
pnpm ops:storage prepare --directory /private/tmp/everchat-storage-maintenance --account <account-id>
cloudflared access login https://chat.wybxc.cc
umask 077
cloudflared access token --app=https://chat.wybxc.cc > /private/tmp/everchat-storage-maintenance/access-token
pnpm ops:storage preflight --directory /private/tmp/everchat-storage-maintenance
```

`prepare` 只读取绑定和命名空间对象清单，不实例化业务对象。目前要求配置中有且只有一个允许邮箱，明确作为运维身份。该目录权限为 0700，备份、补丁及本地 SQLite 权限为 0600；文件含对话文本和凭据，不应提交到 Git、打印到控制台或上传公共制品。

临时部署保留 Worker 名称、DO 类和命名空间、Workflow、R2 绑定、域名和 Access。普通业务请求统一返回 503；已有业务 WebSocket／上游连接随部署中断。临时 `/api/__operations/` 同时接受 Access 边缘认证和应用 JWT 签名、邮箱验证，POST 还校验 Origin。只有配置的单个运维邮箱可以调用；临时接口随正式版本恢复而移除，不新增长期令牌或放宽 Access。`preflight` 只验证原服务的认证恢复入口，不唤醒数据库；必须成功后才进入维护窗口。

```sh
pnpm exec wrangler deploy --config /private/tmp/everchat-storage-maintenance/maintenance.json
pnpm ops:storage backup --directory /private/tmp/everchat-storage-maintenance
pnpm ops:storage convert --directory /private/tmp/everchat-storage-maintenance
pnpm ops:storage apply --directory /private/tmp/everchat-storage-maintenance
pnpm ops:storage verify --directory /private/tmp/everchat-storage-maintenance
pnpm ops:storage cleanup --directory /private/tmp/everchat-storage-maintenance
pnpm exec wrangler deploy --config dist/everchat/wrangler.json
```

- `backup` 在暂停业务后重新枚举所有有存储的 Conversation／Library 对象，避免遗漏准备阶段后新增的对象；逐页导出迁移涉及的表和索引／触发器。全部备份完成前不能转换。备份只覆盖迁移涉及的 SQL 表，不冒充包含附件的完整站点备份；其他表、DO KV 和 R2 附件不受补丁影响。
- `convert` 完全在本地工作，生成 SQLite 校验结果及确定的 SQL 补丁，不连接 Cloudflare。对旧库移除事件历史，规范公开流的可靠前缀与检查点，将输入指纹转为 SHA-256；保留消息 ID、分支、删除标记及幂等结果。Library 的历史归档字段、复制字段及工具服务凭据也在这里转换。
- `apply` 每批以事务写回，并同时记录任务 ID、页码及补丁摘要。网络中断后重复执行该命令，从确认的批次继续。版本标记在补丁末尾写入；部分导入的对象不能被业务代码误当成完整新库。单批最多 64 条语句，通常不超过 256 KiB；单个较大参数化语句单独一批。
- `verify` 再次核对命名空间对象清单，并比较线上与本地预期的涉及表结构、索引／触发器和逐行值。全部通过后才能清理批次记录、部署正式程序恢复访问。

临时维护程序的 Alarm 只延后一分钟，不读取或转换业务数据；正式代码恢复后按原有任务恢复逻辑处理。不要长时间停留在维护版本。

若本机通过系统代理访问 Cloudflare，CLI 进程也需要设置现有代理的 `HTTPS_PROXY`／`HTTP_PROXY`；Node 需要时使用 `NODE_USE_ENV_PROXY=1`，`NO_PROXY` 包含本机地址。先通过 `preflight` 验证，不在停机后才排查网络。不要把代理地址或会话令牌写进仓库。

## 失败恢复

导入前失败：生产 SQL 尚未变化，可以重新部署原版本恢复服务。导入中断：保持维护窗口，用同一目录重试 `apply` 和 `verify`，不要重新覆盖备份或生成不同补丁。

必须撤回时，使用完整原始备份生成反向补丁，逐对象恢复涉及表和索引／触发器并校验，然后回滚到维护前的业务代码版本：

```sh
pnpm ops:storage rollback --directory /private/tmp/everchat-storage-maintenance
pnpm ops:storage cleanup --directory /private/tmp/everchat-storage-maintenance
pnpm exec wrangler rollback <previous-version-id>
```

回滚后不能部署要求新版本标记的正式代码，必须先重新完成迁移。运维目录在验收后转存到私有备份位置；系统可能清理 `/private/tmp`，它不是长期备份存储。

## 边界

本地 `VACUUM` 只整理本地验证副本，不会缩小云端 DO 已分配的物理空间。云端操作保留原对象和 URL，不调用 `deleteAll()`，不复制附件，也不承诺删除历史表后立即释放物理文件容量。

后续新增格式变更继续放在本地运维程序中。`storage_schema` 只用于拒绝不兼容格式；不能把迁移重新接回构造函数、请求处理或 Alarm。临时 `Operations`／Access 运维路由及 SQL 搬运入口不进入正式构建依赖图。

## 本次验证（2026-10-18）

379 项单元测试、本地 workerd 运维通道测试、7 项生成／取消／重启恢复集成测试、类型检查、构建和格式检查通过。覆盖已有库拒绝启动且不修改数据、本地转换失败回滚、历史流可靠前缀保留、补丁重试、无关数据隔离，以及 Miniflare 内部元数据不影响空库创建。

线上对象清单已读取，共 26 个 Conversation 和 1 个 Library；尚未导出或写回生产 SQL。临时维护部署已撤回，网站继续运行维护前的业务版本。本机 Access 会话仍需完成登录，认证预检成功后再执行维护窗口；在数据库迁移验收前，不推送会触发自动部署的新代码。
