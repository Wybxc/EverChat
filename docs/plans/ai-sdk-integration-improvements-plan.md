# AI SDK 集成完善

日期：2026-10-20。状态：已实施，完成本地验收。承接已完成的[流解析迁移](provider-sdk-streaming-plan.md)。

后续扩展见 [AI SDK Core 与 UI 深度集成计划](ai-sdk-core-ui-adoption-plan.md)：在本轮已完成的 Provider 集成上继续接入 Core／UI，覆盖工具容错、消息与状态管理、传输和重复实现清理；该后续计划尚未实施，不改变本页的历史验收范围。

## 调研结论

当前四种协议已使用 LanguageModelV4.doStream。剩余问题主要在 SDK 输出到应用状态的桥接层：警告和响应元信息被忽略；用量重复映射遗漏 noCache／text；错误分类依赖属性猜测；工具 JSON Schema 与运行时约束不一致；结构化事件为了容量检查又被编码、解码；首字时间也重复解码。

官方 [streamText](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text) 能聚合工具响应消息，但默认有请求重试；采用时必须禁用重试、工具执行与自动多步。[低内存模式](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text-low-memory) 不提供 responseMessages，不能同时把它作为私有续接消息聚合的依据。[valibotSchema](https://ai-sdk.dev/docs/reference/ai-sdk-core/valibot-schema) 可从共享参数定义生成 JSON Schema；公共 HTTPS 地址等业务检查仍保留在运行时。[APICallError](https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-api-call-error) 提供可靠的类型判断与响应正文，但请求参数和任意供应商元数据不能直接暴露给客户端。

## 实施顺序与验收

1. **诊断透传**：有界、脱敏保存 SDK 警告、实际模型、响应 ID／时间；在生成详情显示，断流、工具多轮、刷新和备份后保留。只公开允许字段，不公开签名、加密推理、请求或完整响应头。
2. **统一用量**：复用 sdkUsage，补足未缓存输入和正文输出；保留供应商原始总量、早期用量与最终性。SDK 根据缺失字段合成的零不能当成真实报告。
3. **错误归类**：使用 SDK 的 isInstance 判断 HTTP、JSON 和类型校验错误，保留脱敏响应正文、请求 ID 和中断回答，不引入隐式重试。
4. **工具参数单一来源**：由共享 Valibot 参数生成模型 JSON Schema，运行时复用同一定义；DeepSeek 服务专属查询长度检查和 URL 网络约束继续单独执行。
5. **减少流开销**：容量检查直接应用结构化事件；首字时间观察结构化文字／思考输出，只在传输边界编码。保持字符容量、截断前缀、取消、背压、低频 SQL 持久化及多端恢复。
6. **Core 可行性实验**：以当前 SDK V4 兼容版本做单步、零重试的本地模拟。核对思考摘要／全文、Anthropic 签名、Responses 加密资料、工具 ID 和块顺序。全部满足且能减少重复职责才替换 collector；若实验不满足，记录具体反例，保留有必要的最小适配层，不扩大为 Agent 引擎迁移。

## 验证和发布

增加诊断、用量、错误、工具参数、容量与首字时间回归；执行四协议和工具恢复相关测试、类型检查、构建、格式检查与本地资源测量。不开真实收费模型请求；本地耗时和字节统计不冒充 Cloudflare CPU／免费额度证据。不添加在线历史迁移。完成后更新执行记录，提交并推送。

## 执行记录

六项均已按上述验收门槛完成。新增公共诊断与用量维度，统一类型化错误，工具参数由共享 Valibot 生成；移除容量检查与首字计时的重复解码。Core 实验证明 responseMessages 会丢失分片推理签名，因此保留必要的私有 collector，不增加 Core 生产依赖。

465 项单元、72 项浏览器／运行时用例、原生离线运维测试、类型检查与生产构建通过；响应时间本地化后另复测生成详情。普通流和七种工具场景保持既有低频写入；局部事件处理微测量有改善，不能换算为 Cloudflare CPU。实现、实验、数据和验证边界详见[执行记录](../measurements/ai-sdk-integration-2026-10-20.md)。
