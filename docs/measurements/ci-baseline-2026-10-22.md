# 独立 CI 首次验证

日期：2026-10-22。测试与构建拆分见 [PR #6](https://github.com/Wybxc/EverChat/pull/6)。本记录保留首次试跑结果，不将未完成或失败的场景写为通过。

## 首次试跑

[GitHub Actions run 39767620039](https://github.com/Wybxc/EverChat/actions/runs/39767620039) 在 Ubuntu 24.04、Node.js 24.18.0、pnpm 12.6.0 上运行。使用本地 workerd、合成身份和模拟上游，不访问生产数据或真实模型。

| 范围                                 | 结果                                          |
| ------------------------------------ | --------------------------------------------- |
| 格式、类型、505 项单测、原生运维集成 | 通过                                          |
| Chromium／WebKit PWA                 | 56 项通过，测试阶段 3.1 分钟                  |
| WebKit 阅读／导航／搜索              | 15 项通过、3 项失败，测试阶段 3.3 分钟        |
| 完整 Chromium 主套件                 | 共 423 项；切分工作流时取消旧运行，不计为通过 |

WebKit 的三个失败位于已有场景：

- `reading-navigation.spec.ts`：触摸布局中新建对话快捷键后，导航仍存在。
- `reading-navigation.spec.ts`：搜索、版本和删除导航场景超时，最终错误显示为清理请求超时，需要 trace 继续定位原始等待。
- `search.spec.ts`：离线移动布局中按查找快捷键后，搜索框未出现。

前两个场景在本机 macOS WebKit 单独复测均通过，共 14.4 秒。失败涉及快捷键与执行平台的差异是排查方向，尚不能据此确认根因，也未修改业务代码或放宽断言。后续独立工作流采用 macOS WebKit，以覆盖实际 Safari 所在平台；该新作业仍需独立验证，不能用本机结果替代。

## 合并门槛

按用户确认，`Required tests` 只包含格式、类型、全部单测和原生运维集成。浏览器／PWA 回归由单独的 [Browser regression 工作流](../../.github/workflows/browser-tests.yml) 手动运行，选择分支和套件，失败报告保留 7 天；目前不作为自动合并门槛。

后续应完成 macOS WebKit CI 复核及完整 Chromium 基线，确认稳定性和耗时后再评估是否加入必需检查。与界面、离线或浏览器兼容相关的修改仍应在合并前运行对应回归。
