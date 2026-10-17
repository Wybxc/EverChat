# 有限联网工具的供应商协议基础

阶段 5 的供应商协议基础。固定工具的输入／结果校验、供应商请求构造及已保存响应的协议回放，已接入[逐轮状态日志](tool-task-state.md)、[生产 Conversation／Workflow 执行与过程展示](tool-workflow.md)及[联网服务](../features/web-tool-service.md)。网页提供服务配置和默认关闭的会话开关；整体验证与边界见[路线图](../plans/serverless-feature-roadmap.md#阶段-5联网搜索与网页读取)。

## 请求与续接

仅声明 `web_search` 与 `read_webpage` 两种只读函数。模型元数据必须明确支持工具调用，未知能力拒绝；每轮最多两个调用，最多三次工具交换，随后的一次模型请求可返回最终回答。普通聊天不传工具参数，沿用原始流转发和低频持久化。

`openProviderStream` 继续用已安装的 AI SDK 构造请求，实际响应保持供应商原始 SSE。`collectProviderToolTurn` 只处理已保存、有限大小的回放流，使用 SDK 解码工具及协议资料；注入的本地 fetch 返回该流，不调用模型、搜索或网页。普通 DO 接收路径没有增加逐 Token 的 SDK 解析。

私有续接保留助手内容部分的原始顺序、完整思考块、函数参数及供应商元数据。DeepSeek 兼容协议保留 `reasoning_content`；Anthropic 合并流式签名片段并保留 redacted thinking；Responses 使用 `store: false` 和 `reasoning.encrypted_content`，带回推理项目及调用关联；Gemini 保留每个内容部分的 thought signature。关闭用户可见思考内容不移除这些协议资料。依据：[OpenAI 推理模型](https://developers.openai.com/api/docs/guides/reasoning)、[Anthropic Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)、[Gemini thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)。

调用 ID 用于对应结果。部分 SDK 会替换重复或缺少的标识，因此在 SDK 解码前校验原始 SSE 的标识；Gemini 未返回 ID 时允许 SDK 生成并固定保存，供应商已提供的 ID 必须保留。续接绑定供应商协议、端点和模型；每个结果必须且只能对应一个调用。错误使用原生工具错误结果，网页资料留在工具结果中，不进入系统提示词。[Anthropic 结果格式](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)

供应商签名及私有内容与可展示的调用／结果是不同结构，不将私有续接放入消息、快照、导出或浏览器缓存。[状态日志](tool-task-state.md)负责逐轮 SQLite 保存、对应关系复验与终态清理；[DO 执行器](tool-workflow.md#公开流与私有续接)将工具响应的原始字节保存在私有日志，只把正文／可见思考／用量转换成公开展示流。普通聊天保持原始流路径。

## 实现边界

| 内容         | 上限                                            |
| ------------ | ----------------------------------------------- |
| 每轮原始回放 | 2 MiB                                           |
| 每轮私有续接 | 1 MiB，按轮独立保存                             |
| 正文／思考   | 各 100,000 字符，保留部分顺序                   |
| 助手内容部分 | 每轮 64 个                                      |
| 函数参数     | 8 KiB；查询最多 500 字符，URL 最多 2,048 字符   |
| 单次结果     | 64 KiB；最多 5 个来源，正文合计最多 12,000 字符 |
| 工具交换     | 最多 3 次，每次最多 2 个调用                    |

拒绝截断、缺少协议终态、无效 UTF-8／SSE、未知工具、供应商自行执行的工具、额外权限、重复／变化的标识、参数或结果超限及不匹配的续接。错误不会自动重试模型。校验失败时只丢弃有限回放；解析信号取消会终止读取。

公开来源及网页输入只接受无凭据的 HTTPS 域名，禁止 IP 字面量、localhost、常见内部后缀、非标准端口及控制字符。这个检查只验证 URL 语法，不能证明 DNS 解析目标公开；[联网服务后端](../features/web-tool-service.md)只向固定 Tavily 端点发送请求，拒绝重定向，不直接抓取任意网页。第三方抓取的网络隔离未在本地模拟验证中证明。

## 验证

新增 18 项协议单元测试与全部 224 项单元测试通过；应用／Worker／工具类型检查及新增测试的独立严格 TypeScript 检查通过。四协议验证真实安装 SDK 的请求与下一轮续接，经过 JSON 序列化模拟状态保存，覆盖分段 UTF-8、并行调用、思考签名／加密项目／redacted thinking、调用身份、普通最终回答、未知能力、异常流、未闭合内容块、缺少私有推理资料、超限和取消。另测 OpenAI 官方 Chat Completions 适配器及正文／思考交替时的部分顺序。

生产构建通过。现有 11 项流式浏览器回归通过，覆盖四协议的分段恢复、预览／保存边界、慢订阅者、尾部保存失败及退出清理；供应商设置 4 项在新建隔离服务后全部通过。首轮设置中的鉴权请求遇到 Vite／Miniflare 转发层 `fetch failed`，返回 500 错误页并影响下一项页面操作；未修改产品或测试断言，独立重跑通过。

使用模拟供应商响应，未发起真实模型、搜索或网页请求，也未部署或创建 Cloudflare 资源。本地协议验证不证明真实模型质量、Workflow 恢复、Cloudflare CPU 或免费账单。
