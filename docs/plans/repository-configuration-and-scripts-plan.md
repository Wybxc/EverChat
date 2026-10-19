# 配置与脚本整理

目标：减少根目录配置和重复执行逻辑，保持生产运行环境隔离、测试覆盖、离线运维及测量口径。基线为 `1b5fd3e`，根目录 11 份 tsconfig、5 份 Wrangler、2 份 Playwright；scripts 共 36 个文件、5,410 行。

## 配置

- 根 `tsconfig.json` 同时保存公共编译选项和 VSCode 项目引用，`config/` 保留 app、worker、sw、tooling 四种配置，共 5 份。工具、运维和全部测试合并检查；共享代码同时由前端和生产 Worker 检查。生产前端、Worker、SW 不混入测试环境全局类型。
- 根 `wrangler.jsonc` 保留生产入口、域名与绑定。独立验证配置集中到 `config/wrangler.validation.jsonc` 的命名环境；选择验证环境必须显式指定 `--env`，不继承生产资源。动态凭据只写入忽略目录或本机私密运维目录。
- Playwright 保留一个根配置，通过 `scripts/test.ts e2e|pwa` 选择启动模式；维持独立端口、存储、PWA 生产构建和 Chromium／WebKit 范围。单元测试也复用该执行入口，保留递归发现、零匹配失败与退出状态传递。
- Prettier 配置合并到 package.json；删除全为注释、日常开发不需要的 `.dev.vars.example`。本机 `.dev.vars` 保留，联调说明集中到 README。
- Vite、Playwright、Wrangler、tsconfig、shadcn 等常用工具发现入口保留根位置；不新增纯转发配置。预缓存插件并入 Vite，更新模型目录脚本平铺到 scripts。

## 脚本

1. 把工具测量中旧的 round-limit 场景替换为超过原上限的有限多轮成功场景，避免无限模拟循环耗尽测量窗口；保留取消、失败与清理断言。
2. 测量共用本地服务生命周期、HTTP、WebSocket 同步与报告输出。场景和 Cloudflare 计费指标保持各自口径，诊断计数不能冒充平台 CPU／费用。
3. 使用统一 `pnpm measure <stream|tools|notifications|usage|metrics|tail> ...` 入口，明确 local／cloudflare、场景和参数；移除旧别名与零散手动命令。
4. Cloudflare 只读 API 客户端移到 scripts/lib，消除 operations 对 measurements 的依赖；本地验证 Worker 与测量运行时集中。
5. 离线备份、校验、回滚与索引重建保留。历史转换／一次性清理集中到带版本的本地迁移模块；保留已记录备份的重放能力，不在请求、启动或 Alarm 中增加迁移。

## 验收

- 四种类型检查全部通过，整理前已检查源码的覆盖范围不减少；VSCode 能发现四种项目环境和 `@/` 别名。
- 原有验证环境的归一化入口、名称、域名、变量、绑定、Workflow 与 DO migrations 等字段与整理前一致；逐环境本地 dry-run 打包，不部署远端测量资源。
- 单元、原生离线运维、相关浏览器回归及生产 PWA 检查；测试发现清单保持一致，仅增加有意义的新回归。
- 真实本地流式／工具测量执行成功，输出完整报告，退出后服务和临时存储清理；多轮场景超出旧上限并正常结束。远端脚本以本地参数、边界和打包验证，不为整理重复创建付费平台资源。
- 文档、CLI 帮助及引用同步更新，format、构建、diff 检查通过；分批提交推送。

## 进度

- 配置合并已实施，四种类型检查通过；单元发现 71 个文件，主 Playwright 382 项、PWA 51 项，保持原有发现范围。445 项单元、8 项登录／导航回归、原生运维测试、生产构建及格式检查通过。四个 Wrangler 环境的 12 项关键归一化字段与基线一致，全部通过本地 dry-run 打包；完整 PWA 在后续整合完成后复测。
- 脚本整合待实施；完成后在此记录实际验证与保留范围。
