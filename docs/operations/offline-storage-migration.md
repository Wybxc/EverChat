# 数据库离线运维迁移

数据库格式转换只在本地 Node.js 进程执行。对话访问、对象构造函数和 Alarm 不做旧数据转换。业务代码仅创建空库，并校验已有库的 `storage_schema`；版本不匹配时停止处理，要求先完成运维迁移。

Durable Object 的 SQLite 存储属于对象实例，不能像 D1 一样直接使用 `wrangler d1 execute`，也不能从本地文件原地修改云端数据库。因此迁移分为维护窗口内的导出、本地转换、写回和校验。云端临时程序只搬运 SQL 数据及执行已生成的参数化补丁，不运行历史格式转换或供应商流解析。[存储访问范围](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[Access 命令行认证](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/)。

## 实施顺序

先结束正在生成的回答、标题、联网工具调用及备份导入／复制。维护期间不启动这些任务。保留当前部署版本 ID，并暂停向 `main` 推送，避免自动构建打断维护窗口。

通用 `wrangler.jsonc` 不含生产身份参数。运维时另准备被 Git 忽略的私有配置 `<private-production-config>`，保留本部署的资源绑定，并在 `vars` 中填写真实的 `APP_ORIGIN`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD` 和唯一管理员邮箱 `ACCESS_ALLOWED_EMAILS`；相对路径按配置位置调整。每次 `ops:storage` 都显式传入 `--config`，不能从通用配置推断目标站点或管理员。该文件仅用于本机运维，不加入源码或普通自动构建。

```sh
pnpm test
pnpm test:operations
pnpm build
pnpm exec wrangler deployments list
pnpm ops:storage prepare --config <private-production-config> --directory /private/tmp/everchat-storage-maintenance --account <account-id>
cloudflared access login --quiet https://chat.example.com/auth/resume
umask 077
cloudflared access token --app=https://chat.example.com > /private/tmp/everchat-storage-maintenance/access-token
pnpm ops:storage preflight --config <private-production-config> --directory /private/tmp/everchat-storage-maintenance
```

`prepare` 只读取绑定和命名空间对象清单，不实例化业务对象。目前要求配置中有且只有一个允许邮箱，明确作为运维身份。该目录权限为 0700，备份、补丁及本地 SQLite 权限为 0600；文件含对话文本和凭据，不应提交到 Git、打印到控制台或上传公共制品。

同一时间只启动一个 `cloudflared access login` 进程，使用当前进程给出的链接，等命令成功退出后再取令牌。独立 PWA 的导航缓存可能拦截根路径，因此命令行登录使用 `/auth/resume`。浏览器显示成功不能代替 CLI 完成和 `preflight` 成功。

临时部署保留 Worker 名称、DO 类和命名空间、Workflow、R2 绑定、域名和 Access。普通业务请求统一返回 503；已有业务 WebSocket／上游连接随部署中断。临时 `/api/__operations/` 同时接受 Access 边缘认证和应用 JWT 签名、邮箱验证，POST 还校验 Origin。只有配置的单个运维邮箱可以调用；临时接口随正式版本恢复而移除，不新增长期令牌或放宽 Access。`preflight` 只验证原服务的认证恢复入口，不唤醒数据库；必须成功后才进入维护窗口。

```sh
pnpm exec wrangler deploy --config /private/tmp/everchat-storage-maintenance/maintenance.json
pnpm ops:storage backup --config <private-production-config> --directory /private/tmp/everchat-storage-maintenance
pnpm ops:storage convert --config <private-production-config> --directory /private/tmp/everchat-storage-maintenance
pnpm ops:storage apply --config <private-production-config> --directory /private/tmp/everchat-storage-maintenance
pnpm ops:storage verify --config <private-production-config> --directory /private/tmp/everchat-storage-maintenance
pnpm ops:storage cleanup --config <private-production-config> --directory /private/tmp/everchat-storage-maintenance
pnpm exec wrangler deploy --config dist/everchat/wrangler.json
```

- `backup` 在暂停业务后重新枚举 Conversation／Library 对象，并合并 Library 中对话、删除记录、复制任务及导入任务引用的对象。控制面清单曾遗漏实际已有数据的旧对话，不能单独作为完整性依据。逐页导出迁移涉及的表和索引／触发器；全部备份完成前不能转换。备份只覆盖迁移涉及的 SQL 表，不冒充包含附件的完整站点备份；其他表、DO KV 和 R2 附件不受补丁影响。
- `convert` 完全在本地工作，生成 SQLite 校验结果及确定的 SQL 补丁，不连接 Cloudflare。对旧库移除事件历史，规范公开流的可靠前缀与检查点，将输入指纹转为 SHA-256；保留消息 ID、分支、删除标记及幂等结果。Library 的历史归档字段、复制字段及工具服务凭据也在这里转换。
- `apply` 每批以事务写回，并同时记录任务 ID、页码及补丁摘要。网络中断后重复执行该命令，从确认的批次继续。版本标记在补丁末尾写入；部分导入的对象不能被业务代码误当成完整新库。单批最多 64 条语句，通常不超过 256 KiB；单个较大参数化语句单独一批。
- `verify` 再次核对控制面与应用索引合并后的对象清单，并比较线上与本地预期的涉及表结构、索引／触发器和逐行值。全部通过后才能清理批次记录、部署正式程序恢复访问。恢复后还须逐个检查可见对话的快照及存储接口，确认业务构造函数可以读取。

临时维护程序的 Alarm 只延后一分钟，不读取或转换业务数据；正式代码恢复后按原有任务恢复逻辑处理。不要长时间停留在维护版本。

## 全文搜索索引的离线重建

Library 启动不再扫描已有对话、创建历史索引回填任务；新建空对话也不再排队扫描。普通消息由原有 `search_outbox` 增量更新。复制或导入完成后，对刚创建的对话分页建索引仍是该业务操作的一部分，不用于迁移旧数据。

需要修复历史索引、升级索引规则，或清除旧版本尚未完成的历史回填队列时，在上述维护窗口中将转换命令替换为：

```sh
pnpm ops:storage convert --config <private-production-config> --rebuild-search --directory /private/tmp/everchat-storage-maintenance
```

其余 `prepare → preflight → backup → convert → apply → verify → cleanup → 恢复业务版本` 步骤相同，必须使用新的运维目录。不要把历史任务重新放回在线 Alarm。转换中断后重试须保留 `--rebuild-search`，工具拒绝在同一批次中途更换转换选项。

备份保存规范消息、内容分块、搜索版本、摘要／删除标记、Library 可见性及原索引字段；联合清单同时保存对话名称与 DO ID 的对应关系。先转换所有本地 Conversation 副本，再本地重建 Library 索引。正文和思考沿用与在线增量索引相同的 Markdown 提取与规范化规则，包含全部可见分支及已保存的失败回答，排除生成中、已删除、内部摘要和未完成导入／复制。缺少任一可见对话副本或内容损坏时，整个本地重建回滚，不生成可导入的部分索引。

重建清除旧历史队列和旧索引错误，并递增搜索修订号。写回的是本地生成的字段、版本及 FTS 参数，不在云端读取消息、解析 Markdown 或调用业务 RPC。FTS 虚表仅备份结构，内容由规范 `search_fields` 恢复；不导出其影子表或重复正文。回滚也由本地生成逐行的 FTS 插入补丁。新索引在本地和维护导入末尾执行 FTS 完整性检查。

本次移除在线回填不改变现有 SQL 格式或消息内容，已建立的索引继续使用。发布前核对搜索没有待处理旧历史任务；存在时先在维护窗口完成离线重建。

## 在线迁移排查（2026-10-18）

| 范围                                | 排查结果及处理                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Library 构造函数与新建对话          | 删除自动为已有／空对话排队的全文索引回填；历史重建移至 `convert --rebuild-search`。                                |
| Conversation 构造函数、请求及 Alarm | 已有 `storage_schema` 版本门禁；旧事件删除、历史流转换、指纹哈希只在本地 `migrations.ts`，未发现剩余历史格式转换。 |
| Library 设置及模型／工具配置        | 归档字段移除、复制字段补齐、工具凭据拆分均已在本地运维工具；运行时不再转换旧字段。                                 |
| 复制／备份导入与正常消息更新        | 保留显式用户操作产生的分页索引任务和增量 outbox；不会遍历历史对话进行升级。                                        |
| 生成、标题、附件、导入任务恢复      | 保留中断标记、租约及重试处理；这是当前格式的任务恢复，避免重复计费与丢失任务，不是数据迁移。                       |
| 客户端 localStorage／IndexedDB      | 未发现历史格式升级；保留同一数据格式的双存储写入、失败回退及启动恢复。                                             |
| Service Worker、PWA                 | 保留版本化静态资源缓存清理；不转换对话或草稿。                                                                     |
| Wrangler `migrations`               | 保留 Cloudflare DO 类／命名空间注册声明；不是在业务请求中执行的历史数据迁移。                                      |

新增 SQL 格式或持久化数据格式变更，必须更新版本门禁并先执行本地运维转换。运行时的 `CREATE ... IF NOT EXISTS` 仅声明当前版本结构，不得附加 `ALTER`、历史数据扫描、补字段或旧数据改写。

若本机通过系统代理访问 Cloudflare，CLI 进程也需要设置现有代理的 `HTTPS_PROXY`／`HTTP_PROXY`；Node 需要时使用 `NODE_USE_ENV_PROXY=1`，`NO_PROXY` 包含本机地址。先通过 `preflight` 验证，不在停机后才排查网络。不要把代理地址或会话令牌写进仓库。

## 失败恢复

导入前失败：生产 SQL 尚未变化，可以重新部署原版本恢复服务。导入中断：保持维护窗口，用同一目录重试 `apply` 和 `verify`，不要重新覆盖备份或生成不同补丁。

必须撤回时，使用完整原始备份生成反向补丁，逐对象恢复涉及表和索引／触发器并校验，然后回滚到维护前的业务代码版本：

```sh
pnpm ops:storage rollback --config <private-production-config> --directory /private/tmp/everchat-storage-maintenance
pnpm ops:storage cleanup --config <private-production-config> --directory /private/tmp/everchat-storage-maintenance
pnpm exec wrangler rollback <previous-version-id>
```

回滚后不能部署要求新版本标记的正式代码，必须先重新完成迁移。运维目录在验收后转存到私有备份位置；系统可能清理 `/private/tmp`，它不是长期备份存储。

## 边界

本地 `VACUUM` 只整理本地验证副本，不会缩小云端 DO 已分配的物理空间。云端操作保留原对象和 URL，不调用 `deleteAll()`，不复制附件，也不承诺删除历史表后立即释放物理文件容量。

后续新增格式变更继续放在本地运维程序中。`storage_schema` 只用于拒绝不兼容格式；不能把迁移重新接回构造函数、请求处理或 Alarm。临时 `Operations`／Access 运维路由及 SQL 搬运入口不进入正式构建依赖图。

## 本次验证（2026-10-18）

379 项单元测试、本地 workerd 运维通道测试、7 项生成／取消／重启恢复集成测试、类型检查、构建和格式检查通过。覆盖已有库拒绝启动且不修改数据、本地转换失败回滚、历史流可靠前缀保留、补丁重试、无关数据隔离，以及 Miniflare 内部元数据不影响空库创建。

生产迁移已完成：38 个 Conversation（含 1 个已删除对象）及 1 个 Library 均为版本 1。全部 143 条消息、分支字段、运行记录及对话删除标记与迁移前一致；移除 2,363 条旧事件记录，公开流不再保留历史 wire 日志。云端涉及表的结构、索引／触发器和逐行值已与本地结果核对一致，临时批次记录已清除。

首次控制面清单只覆盖 28 个对象，恢复后的读取检查发现 11 个旧对话缺少版本标记。工具随后增加应用索引联合枚举，使用独立补充批次完成全部 39 个对象的备份、转换、写回及校验，保留首轮原始备份。后续迁移必须使用联合枚举，不能仅凭控制面清单或结构校验判定成功。

正式服务恢复版本为 `63f4aaaf-5015-4a16-b1c8-12e7611a2bf4`。只读验收：首页及 Library 为 200，37 个可见对话的存储接口和所有分页均为 200，共读回 143 条消息；临时 `/api/__operations/identity` 为 404。验收未发送模型生成请求。

两轮私有备份保存在本机 `.wrangler/operations/storage-2026-10-18/{initial,supplement}`，目录权限 0700、文件权限 0600，复制后已核对 SHA-256，且被 Git 忽略。备份不含 Access 令牌和认证日志。若需撤回两轮迁移，先恢复补充批次，再恢复首轮批次，最后回滚业务版本。

后续迁移排查验证：新增 3 项离线搜索测试覆盖规范内容分块、分支、删除／摘要排除、损坏和缺失清单回滚、FTS 备份恢复、CLI 完全离线及重试选项锁定。原生 workerd 验证本地补丁逐批导入后能全文检索；浏览器验证 Library 重启及读取不会补建历史索引。生产只读检查 `GET /api/search` 返回 200 且 `indexing: false`，没有待处理的旧回填任务；本次无需停机重建索引，也未执行生产数据转换。

## 费用 outbox 生产迁移（2026-10-19）

在维护窗口完成控制面与 Library 引用联合枚举，65 个 Conversation／Library 对象全部备份、本地转换 schema 1 → 2、写回和校验；转换只增加空的 `usage_outbox`，原业务行、消息 ID、分支及索引保持一致。未执行历史计费回填或搜索重建。`verify` 于 2026-10-19T03:44:30Z 通过全部对象的清单、表结构、索引／触发器及逐行值比较；随后清除临时批次回执并恢复业务。

正式恢复版本 `8877e562-2bfe-49ab-8ffd-ba27aa079beb`。逐页读回 63 个可见对话的全部 282 条消息，ID 均与备份一致，快照与存储接口正常。统计和分享管理私有接口通过，临时 `/api/__operations/identity` 已返回 404。新增 UsageStore、ShareStore 是独立当前版本空库初始化，不在请求内转换历史数据。

270 个运维 JSON／SQLite 文件保存在本机 `.wrangler/operations/storage-2026-10-19-usage`，目录 0700、文件 0600，复制后逐文件核对 SHA-256，且被 Git 忽略。备份不含 Access 令牌、认证日志或 R2 附件。维护前业务版本为 `bc04533e-03b9-4c8b-8b5f-b30b743b2dd3`；若必须回滚，需要先用此批次原始备份离线恢复 schema 1 并核验，不能直接让旧业务代码读取 schema 2。

## 历史用量统计清理

仅维护统计库时，使用新的私有目录执行 `prepare --usage-only`；后续命令继续使用该目录。清单结合 USAGE 命名空间和规范的 personal 对象，备份只含 storage_schema、usage_attempts、usage_prices、usage_rollups。临时 UsageStore 同样只搬运 SQL，不运行业务构造函数。

```sh
pnpm ops:storage prepare --config <private-production-config> --usage-only --directory /private/tmp/everchat-usage-cleanup --account <account-id>
```

其余预检、维护部署、backup → convert → apply → verify → cleanup、恢复正式部署的顺序与上文一致。在本地 convert 时删除备份中已结束且没有最终用量、价格快照或完整估算的请求，保留进行中请求；完整记录移除已取消的手动修正字段，按原始估算重新构建全部小时聚合。价格配置不变，不访问对话或分享表。每个对象生成仅含数量的 `.cleanup.json` 审计文件；先检查该文件再 apply。

不增加线上清理、补算入口或启动扫描。清理后的新失败／取消请求仍按实际情况保留部分或未知用量。出错时本地转换整批回滚；线上导入失败沿用批次重试及原始备份恢复机制。

2026-10-19 已在生产执行本次统计清理：原 23 条请求中删除 22 条已结束但用量或计价不完整的历史记录，保留 1 条完整记录；没有价格配置或修正字段需要处理。小时汇总已离线重建，线上与本地结构、索引及逐行值验证通过，临时回执已清除。私有备份保存在 `.wrangler/operations/usage-cleanup-2026-10-19`，目录 0700、文件 0600，已核对 SHA-256，不含 Access 会话令牌。正式恢复版本 `22382d94-e569-4ed5-a410-e4adbf1d7b09`。445 项单元测试、原生 workerd 运维测试、12 项相关浏览器场景、类型检查与构建通过；生产恢复后统计、根页面和临时入口移除均已只读验收。
