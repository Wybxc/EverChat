# i18n 架构方案

2026-10-19。状态：实施中。用户已确认开始实施；首批接入简体中文 `zh-CN`、英文 `en` 和跟随系统。本文记录库、资源组织、运行时边界和翻译维护方式。

### 实施记录

- [x] 安装 i18next／react-i18next，建立独立实例、类型化资源、语言匹配、本机偏好和 Intl 格式化入口。
- [x] 接入通用设置语言入口，迁移主框架、登录状态、快捷键、聊天组件、侧栏及搜索；日期分组使用稳定 ID。
- [x] 浏览器验证无刷新切换，保留草稿／URL／弹窗／焦点，多标签页同步及系统语言变化。
- [ ] 迁移供应商／模型能力、预设、联网工具、附件、备份、用量及分享模块。
- [ ] 迁移前端异步错误／状态和后端语义错误、持久化诊断；需要格式转换时执行离线运维流程。
- [ ] 完成启动占位、第三方 Markdown 控件、导出、PWA 和后台通知语言。
- [ ] 完成剩余模块文案检查、双语主要路径、窄屏／离线／流式／推送验证及包体记录。

目标仍为完成整个 i18n 系统，以上阶段性进度不代表全功能已完成。

## 1. 技术选择

采用 **i18next + react-i18next + 原生 Intl**。

| 部分                       | 方案                           | 在 EverChat 中的用途                                         |
| -------------------------- | ------------------------------ | ------------------------------------------------------------ |
| 翻译运行时                 | i18next                        | 命名空间、参数插值、复数、回退，以及普通 TypeScript 模块翻译 |
| React 集成                 | react-i18next                  | Hook、语言切换订阅及富文本组件                               |
| 日期、数字、相对时间、计数 | Intl                           | 统一展示格式，保留原始值与业务计算规则                       |
| 翻译资源                   | 纯 TypeScript 对象，`as const` | 类型提示、插值检查、Git 审阅，与现有 TS 工程直接集成         |
| 语言检测与保存             | 小型应用偏好模块               | 显式处理“跟随系统”、本机持久化和多标签页同步                 |
| 资源分发                   | Vite 静态模块与已有 PWA 缓存   | 随应用发布，按功能加载，不增加翻译后端                       |

i18next 提供命名空间、语言回退和独立实例；react-i18next 负责组件订阅。类型声明可扩展到资源 key，TS 常量保留消息字面量，有助于检查插值参数。见 [i18next API](https://www.i18next.com/overview/api)、[命名空间](https://www.i18next.com/principles/namespaces)、[TypeScript](https://www.i18next.com/overview/typescript)及 [React Hook](https://react.i18next.com/latest/usetranslation-hook)。

Lingui 的提取／翻译／编译流程适合集中维护翻译目录，但会引入提取和编译步骤。EverChat 当前由开发者维护文案，已有 Vite、TS 和按需模块体系，优先采用直接资源配置；这是项目适配判断。参考 [Lingui React 工作流](https://lingui.dev/tutorials/react/)。

首期只增加两个运行时依赖。不增加 Next.js 集成、HTTP 翻译后端、云翻译服务、语言检测插件、ICU 插件或新的 tsconfig。若以后引入专职译者／翻译平台，再评估 JSON／PO 导入与自动提取；业务 key 和运行时契约保持稳定。

## 2. 当前需要处理的范围

代码基线：`faf27f7`。

| 位置                              | 当前情况                                              | 架构要求                                          |
| --------------------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| React 页面及组件                  | 导航、按钮、标签、占位、提示、aria 文案直接写中文     | 用功能命名空间翻译，保持当前紧凑布局              |
| `src/main.tsx`、`index.html`      | 启动失败、启动占位和 html lang 固定中文               | 启动前就能选择语言；不依赖私有身份或云端设置      |
| `src/platform/pwa`、notifications | 控制器把翻译后的文字存入状态；SW 有独立中文消息       | 状态存原因码与参数，展示时翻译，SW 使用最小资源集 |
| `worker/http`、生成／工具任务     | HttpError 的 code 可选；消息错误主要是字符串          | 逐步建立完整错误码和参数，前端决定展示语言        |
| `shared`                          | 校验错误、阶段名、用量枚举标签与格式化含中文          | 纯规则返回语义信息；展示层翻译标签与提示          |
| 用量、上下文、侧栏分组            | 多处写死 zh-CN，另有未指定 locale 的格式化            | 集中 Intl 格式化，分组 ID 不依赖翻译结果          |
| 分享与导出                        | 分享为独立匿名入口；导出 HTML 的 lang 和 CSV 标签固定 | 独立初始化、跟随查看者语言，导出时显式选定 locale |
| 第三方 UI                         | Radix 封装有隐藏“关闭”，Streamdown 有自带控件文字     | 覆盖可见及辅助文案；优先使用库提供的翻译接口      |

Streamdown 当前安装版本的类型声明已有 `translations?: Partial<StreamdownTranslations>`，应在现有 Markdown 封装传入翻译，不维护渲染器分支。

## 3. 语言与偏好

区分三个概念：

- `LocalePreference`：`system` 或某个支持语言，表示用户选择。
- `ResolvedLocale`：当前实际使用的资源语言。
- `FormatLocale`：日期／数字展示使用的区域标签，例如资源用 en，格式可以保留用户的 en-GB 偏好。

设置入口放在“设置 → 通用 → 语言”，选项用语言自身名称，例如“简体中文”“English”；“跟随系统”随当前界面翻译。

优先级为：本机显式选择 → 按顺序匹配 `navigator.languages` → 产品回退语言。建议英文作为最终回退和资源结构基准；若产品保留中文默认，只调整集中配置。系统标签先规范化，再匹配具体语言、脚本及已支持父语言；不无条件把 zh-TW／zh-Hant 当作已有简体翻译。语言别名在白名单里维护，不用 UA 或 IP 推测。浏览器的语言列表按偏好排序，并提供 `languagechange` 事件，见 [Navigator.languages](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/languages)。

偏好按设备保存，仿照现有主题偏好使用 `everchat:locale`；同一浏览器多标签页通过 storage 事件同步。跟随系统时监听 languagechange；页面恢复前台时重新核对。localStorage 不可用时维持当前内存选择，不阻塞聊天。首期不新增账号语言字段、Library RPC 或跨设备覆盖。

切换语言只更新界面：保留当前 URL、分支、草稿、弹窗、焦点、滚动位置和流式任务，不刷新页面，不触发模型请求，不更改业务查询的缓存 key。

## 4. 模块与资源组织

遵循现有功能内聚原则。公共运行机制集中，功能词条跟随功能模块：

```text
shared/i18n/
  locale.ts                       支持语言、类型、规范化和匹配；无 DOM
shared/errors/
  descriptor.ts                   业务错误码及允许参数；独立于翻译 key

src/platform/i18n/
  runtime.ts                      创建 i18next 实例；不导入 React 或功能模块
  react.ts                        React 插件、页面实例和初始化
  preference.ts                   本机偏好与事件同步
  format.ts                       Intl formatter 缓存
  i18next.d.ts                     统一资源类型声明
  locales/
    en/common.ts                  跨功能操作词、语言名称
    en/errors.ts                  第一方错误摘要与参数模板
    en/system.ts                  最小启动／PWA／通知文案
    zh-CN/...                     对应翻译

src/app/locales/{en,zh-CN}.ts      app：启动框架、导航、设置装配
src/features/chat/locales/...     chat：消息操作、分支、上下文、摘要
src/features/library/locales/...  library：侧栏、搜索、对话管理
src/features/providers/locales/...
src/features/attachments/locales/...
src/features/usage/locales/...
src/features/sharing/locales/...
src/features/backup/locales/...
src/features/presets/locales/...
src/features/web-tools/locales/...
```

目录表示职责，不要求为每个组件新建词条文件。common 只收真正共享的操作，不把所有功能塞入公共目录；同样的中文词在不同语义下可以使用不同 key。

每个页面／SW 运行时创建自己的实例，资源类型形状统一；SW 只注册 system 等实际需要的命名空间，运行时不得调用未注册的功能词条。Worker 业务代码不导入浏览器实例、React 或整套词典，不使用全局 changeLanguage 处理请求，避免共享运行时的请求互相影响。

资源类型声明使用 type-only 导入，不通过一个运行时总入口静态导入全部功能，否则会破坏按需加载。沿用已有 app／worker／sw／tooling 四种类型检查，不为多个翻译实例重新拆分工程配置；在现有 SW 检查的 include 中纳入同一份声明，确保页面和 SW 都能得到类型校验。

## 5. 翻译如何配置和使用

### 资源文件

使用有语义的稳定 key，例如 chat 命名空间的 `newConversation`、providers 命名空间的 `removeConfirm`；字符串调用形式分别为 `chat:newConversation`、`providers:removeConfirm`。不要以整段中文、数组位置、完整错误原文或动态拼接字符串作为 key。

```ts
// src/features/chat/locales/en.ts
export default {
  newConversation: 'New chat',
  removeConfirm: 'Delete “{{title}}”?',
  messageCount_one: '{{count}} message',
  messageCount_other: '{{count}} messages',
} as const;

// src/features/chat/locales/zh-CN.ts
export default {
  newConversation: '新建对话',
  removeConfirm: '删除“{{title}}”？',
  messageCount_other: '{{count}} 条消息',
} as const;
```

复数按各语言的 Intl.PluralRules 校验，不能要求所有语言拥有完全相同的复数后缀。数量通过 count 参数传入，句子整体翻译，不拼接“数量 + 中文后缀”；见 [i18next 复数规则](https://www.i18next.com/translation-function/plurals)。

### 初始化

以下为简化配置；resources 是该入口已经随模块加载、按语言和命名空间组织的词条对象：

```ts
import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';

const i18n = createInstance();
await i18n.use(initReactI18next).init({
  resources, // { en: { common, app, chat, ... }, 'zh-CN': { ... } }
  lng: resolveLocale(preference, navigator.languages),
  supportedLngs: supportedLocales,
  fallbackLng: 'en',
  load: 'currentOnly',
  defaultNS: 'common',
  returnNull: false,
  returnEmptyString: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});
```

React 渲染前完成初始化；每个实例只 init 一次，后续添加资源或 changeLanguage。关闭翻译引起的全局 Suspense 不代表忽略 ready：功能模块必须注册自己的资源后再渲染，加载失败保留当前界面并允许重试。初始化与 ready 的要求见 [i18next API](https://www.i18next.com/overview/api)及 [React Hook](https://react.i18next.com/latest/usetranslation-hook)。

React 会转义插值内容，因此这里关闭重复转义；禁止把翻译结果直接交给 innerHTML。HTML 导出仍通过已有转义函数处理，链接使用组件而非翻译文件中的任意 HTML。插值的默认转义机制见 [i18next 插值](https://www.i18next.com/translation-function/interpolation)。

### 类型与组件

```ts
// src/platform/i18n/i18next.d.ts
import 'i18next';
import type common from './locales/en/common';
import type chat from '../../features/chat/locales/en';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    returnNull: false;
    enableSelector: true;
    strictKeyChecks: true;
    resources: {
      common: typeof common;
      chat: typeof chat;
      // 其余命名空间同样使用 type-only 导入
    };
  }
}

// React 中
const { t } = useTranslation('chat');
t(($) => $.newConversation);
t(($) => $.removeConfirm, { title });
```

普通 TS 模块使用已初始化实例的固定命名空间 translator；共享校验函数返回错误描述，不反向依赖 UI 实例。固定选项数组保存 value 和 key，渲染时翻译，不在模块加载时调用 t 并永久缓存标签。

只在存在嵌入式链接／强调组件时使用 Trans；普通按钮和短文本直接使用 t。功能模块内使用自己的 namespace，跨域操作词显式引用 common。

## 6. 翻译维护流程

1. 添加稳定语义 key，同时提交英文基准和已支持语言的翻译；附必要语境说明。术语保持一致，例如 conversation／chat、reasoning、preset、provider 的产品含义分别固定。
2. 使用完整句子、命名占位符及复数规则；不把显示名、用户消息、文件名、API 端点和密钥放进词典。
3. 在现有 pnpm test 中增加目录校验：语义 key 覆盖、非空值、占位符一致、合法复数类别、无多余 key。英文 one／other 与中文 other 的差异按语义家族校验。
4. TypeScript 检查错误 key 和常用插值参数；校验测试检查跨语言差异。运行时回退只防止意外，不能代替翻译完整性验收。
5. 增加源码文案检查，覆盖 JSXText、属性及已迁移的状态文案；给模型提示、日志、协议常量和用户数据设置有理由的允许范围。扫描中文只是辅助手段，英文硬编码同样可能遗漏。
6. 翻译与代码同 PR／提交发布，不在运行时向第三方发送用户数据请求机器翻译。暂不增加翻译配置入口、运营后台或独立翻译服务。

当前 TS 资源适合仓库内协作。未来需要非开发者编辑时，可增加确定性的导入／导出工具，再决定迁移 JSON 或 PO；不预建双份资源、生成文件和同步链。

## 7. 错误、状态与持久化

第一方错误统一返回稳定业务 code 和经过白名单验证的 params。API 保留脱敏的 fallback 摘要供未知错误使用，例如：

```json
{
  "error": "The input exceeds the context budget.",
  "code": "CONTEXT_BUDGET_EXCEEDED",
  "params": { "estimatedTokens": 42000, "budgetTokens": 32000 }
}
```

前端按显式 code → 词条映射生成摘要；不把任意上游 code 当作翻译 key。供应商原始诊断继续脱敏保留原文，阶段、字段名和用户操作提示翻译，API Key 等信息不进入参数。

PWA／通知／保存控制器存原因码和参数，UI 每次渲染时翻译；异步操作中途切换语言后，成功／失败提示使用当前语言。跨标签页更新协调传原因码，避免收到另一页面已经翻译好的句子。

已保存的消息错误、工具失败、标题／导入任务等也要排查，不能只改 HttpError。新记录保存结构化描述，展示语言不写入同步事件或每个流式增量。若需要改变 SQL／持久化格式，先增加版本门禁和本地运维转换；可可靠识别的错误转换为 code／params，无法识别的文本作为历史诊断保留，用通用摘要展示。保留原始内容，不以中文正则猜测供应商错误含义。

迁移、备份格式升级和验证按现有离线运维流程执行，不在请求、DO 构造函数、Alarm、SW 激活或页面启动中补写历史数据。第一阶段的界面翻译与本机新增偏好本身不需要数据库迁移。

## 8. 加载、公开页面和 PWA

- 首屏 common／system／app 及聊天所需的核心文案随已有启动依赖加载；示例的两种语言核心资源一并打包，首次切换不额外访问后端。大功能的词条随对应功能模块一起加载，进入功能时同时注册其支持语言，避免“功能代码 → 独立翻译 HTTP”串行 roundtrip。
- 不预缓存全部语言的全部功能资源，不通过 CDN 请求词典；复用 Vite 哈希资源和现有 SW 按需缓存。增加更多语言时，先测资源体积，再按语言拆分大目录；在线缺失或离线未缓存时保留现有语言与可操作界面。
- 启动占位和 main.tsx 的异常分支使用最小启动词条；在 React 前设置 html lang，语言切换时同步更新。最小词条只有一份源文件，可在构建时把必要内容嵌入 index.html，不增加独立构建配置，不依赖加载完整应用才改启动文案。
- 匿名分享入口只初始化 common／sharing／必要错误资源，不导入私有 bootstrap，不读取账号缓存或调用私有接口。语言选择不写入分享 URL、不改 token hash、不过问 Access。分享内容保留原文，查看者决定界面语言。
- SW 单独使用 i18next core 和最小 system 词条，不导入 React 或完整聊天词典；两种示例语言的通知模板直接包含在 SW 中，推送处理不再下载翻译模块。
- 私有页面把语言偏好镜像为已有通知 IndexedDB store 中的独立本机记录，与通知订阅 revision 分开；语言切换不触发服务器同步。SW 在投递时读取记录：显式选择使用该语言，system 根据自己的 navigator.languages 匹配，没有记录时按系统及产品回退规则展示，不补写旧通知配置。App 关闭后仍能显示对应语言，语言改变无需重新申请权限或创建新订阅。保持去重、跨设备前台抑制、点击定位和推送负载不含正文的现有规则；匿名分享页不修改私有通知状态。
- PWA 名称保持 EverChat，id、scope、start_url 保持稳定。安装元数据与页面语言分开处理；manifest 可本地化成员的规范定义见 [Web App Manifest](https://www.w3.org/TR/appmanifest/)。先保留稳定品牌名，不承诺已安装的 iOS／macOS App 名称会随页面即时变化，真机确认后再决定是否采用本地化 manifest 字段。

## 9. 格式、AI 内容与数据边界

统一 formatNumber、formatCompact、formatDateTime、formatDuration 等小型格式化函数，formatter 按 locale／options 缓存。侧栏分组返回 pinned／today／yesterday／last7days 等稳定 ID，日期标题只在显示时格式化。切换语言不能改变分组顺序、查询条件或历史范围。

界面语言不改变设备时区、UTC 每日服务额度、用量统计分桶、排序、ISO 时间和数据库字段。金额继续使用现有精确整数／小数表示；接入 Intl 展示时不得先转 Number 造成精度丢失，也不自动兑换币种。CSV 数字和 ISO 日期保持机器可读，界面化列名／状态按导出时 locale 生成。

用户输入、正文、思考、代码、数学公式、标题、供应商／模型显示名、附件名、自定义预设和系统提示词均视为内容。切换 UI 不翻译或重写这些数据，不重新生成标题和摘要，不改变已接受请求的配置快照。

当前内置默认系统提示含“请默认使用中文回答”。它不能仅靠界面翻译解决：建议新安装的内置默认提示采用“跟随用户提问语言”的语言中立规则；已有默认预设和用户编辑内容保留，由用户显式编辑／重置。标题／摘要／工具的模型侧指令按任务语义单独审查，不按当前页面 locale 动态拼接，以免改变上下文预算及任务重现结果。

## 10. 实施顺序与验收

| 阶段              | 内容                                                        | 完成标准                                                         |
| ----------------- | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| A：最小架构验证   | 两个依赖、资源类型、偏好、Intl、核心示例、一个按需功能      | 原地切换；无刷新、无云端写；启动及设置资源加载路径明确           |
| B：界面覆盖       | app／聊天／侧栏／设置／供应商／附件／用量／搜索／第三方控件 | 已支持语言完整；placeholder、aria、Tooltip、确认框和富文本均覆盖 |
| C：错误与任务状态 | code／params、API、共享校验、控制器及持久化错误             | 需要的格式转换先离线完成；语言切换不影响鉴权、重试和任务         |
| D：外部输出       | 匿名分享、导出、启动失败、PWA 协调和系统通知                | 断网、App 退出、不同设备语言、Access 登录前后均使用正确文案      |
| E：发布验收       | 目录检查、主要用户路径、英文布局和真机验证                  | 无遗漏／裁切；首屏及 SW 体积增量有记录；不扩大全部预缓存         |

现有中文浏览器测试显式固定 locale，避免默认系统语言改变造成整套定位失效；新增独立英文核心路径，不机械复制整套端到端用例。类型、目录完整性和规则测试进入既有 pnpm typecheck／pnpm test；主要双语路径覆盖新建、发送、分支、设置、搜索、错误、分享与导出。

重点回归：流式中切换语言、编辑草稿与焦点保留、多标签页 system／显式选择、localStorage 故障、未缓存资源离线打开、公开分享不触发私有请求、系统通知在 App 关闭后按设备语言显示。检查英文长标签、窄屏、200% 缩放、键盘和屏幕阅读器；保持紧凑间距，不用扩大所有按钮来容纳译文。

先完成 A 的库接入与资源示例并核对包体，再批量迁移文案；不以一次机械字符串替换作为整个 i18n 功能完成。
