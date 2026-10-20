# AI SDK 集成完善：调研与验证

日期：2026-10-20。对应[计划](../plans/ai-sdk-integration-improvements-plan.md)。

## 调研范围

核对项目安装的 Provider V4 类型与实现，并在隔离目录安装 `ai@7.0.145` 验证 Core，不将 Core 加入生产依赖。项目的 OpenAI、OpenAI-compatible、Open Responses、Anthropic、Google 适配器继续使用锁文件中的版本。新增 `@ai-sdk/valibot@3.0.63` 与其 peer `@valibot/to-json-schema@1.7.1`。

参考官方文档：[streamText](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)、[低内存流](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text-low-memory)、[Valibot 参数](https://ai-sdk.dev/docs/reference/ai-sdk-core/valibot-schema)、[SDK 错误](https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-api-call-error)。实现以实际安装源码及本地模拟结果为准。

## Core 实验

单步 `streamText({ model, prompt: 'fixture', maxRetries: 0, onError: () => {} })`；模型为 V4 模拟实现，`doStream` 返回标准事件，只有一次调用，没有工具 execute 和自动后续请求。输入的关键片段：

```js
{ type: 'reasoning-start', id: 'r' }
{ type: 'reasoning-delta', id: 'r', delta: 'thought' }
{ type: 'reasoning-delta', id: 'r', delta: '',
  providerMetadata: { anthropic: { signature: 'first-' } } }
{ type: 'reasoning-delta', id: 'r', delta: '',
  providerMetadata: { anthropic: { signature: 'second' } } }
{ type: 'reasoning-end', id: 'r' }
```

再发送 `text-start／delta／end` 和正常 `finish`，消费 `fullStream` 后读取 `responseMessages`，得到：

```json
{
  "calls": 1,
  "messages": [
    {
      "role": "assistant",
      "content": [
        {
          "type": "reasoning",
          "text": "thought",
          "providerOptions": { "anthropic": { "signature": "second" } }
        },
        { "type": "text", "text": "answer" }
      ]
    }
  ]
}
```

应续传的签名是 `first-second`。这与当前 Anthropic 适配器把每个 `signature_delta` 原样放入 `reasoning-delta.providerMetadata` 的行为一致；Core 的聚合器直接替换上一份 metadata。现有 collector 会拼接签名，不能直接用 responseMessages 替代。

另外，Open Responses 适配器会把 reasoning_summary_text 和 reasoning_text 都映射为 reasoning-delta；Core 本身无法据此选择全文并去重。SDK 可能为缺失的工具 ID 生成替代值，应用仍须检查原始调用身份。Responses 加密资料、Anthropic 签名／redactedData、调用与结果匹配也必须在私有持久化边界验证。

低内存 API 在该版本是 `experimental_streamTextLowMemory`（源码实现 `streamTextLowMemory`），单消费者、不提供最终 responseMessages；带 tools、回调等选项时仍可能收集内容。它解决的不是上述协议资料缺失问题。因此本轮保留 `doStream` 和必要的私有 collector，不引入一套额外的多步执行引擎。

## 实际改动

- 通过既有 usage 事件的可选字段传递公共诊断，保持事件类型和 `events-v1`。旧客户端忽略额外字段；没有在线迁移。新增字段可选，旧记录仍可读取。
- 警告最多 8 项、每项 512 字节，响应只允许模型、响应 ID、请求 ID 和时间；先脱敏，再经过共享严格 schema。不会复制完整 SDK 元数据、签名、请求参数或响应头。
- 检查点保存诊断，最终生成结果合并各工具轮次的去重警告和最近收到的响应信息；刷新、复制、备份和恢复沿用相同结构。生成详情显示这些信息。
- 最终用量复用 `sdkUsage`。原始计数仍为依据，仅在缓存／推理维度有足够报告时补足 noCache／text，避免适配器默认零覆盖未知或 DeepSeek 专属计数。不把子集再次加入总量。
- `APICallError.isInstance`、JSON／类型／响应结构／空响应／模型与不支持功能等 SDK 错误判断统一流、请求建立和能力探测的错误分类。HTTP 200 后的解码失败归为协议错误，保留脱敏正文和请求 ID，不作自动重试。
- 参数声明由共享 Valibot 生成，通用搜索上限与运行时一致为 500；DeepSeek 的服务专属 128 字符约束、公开 HTTPS 地址策略和总参数字节检查仍在执行边界生效。
- 容量检查直接接受结构化事件，复用原先的替换、UTF-8／代理对和截断规则；首字时间由首个非空文字／思考事件观察一次。每个事件只在传输时编码，不再为这两项工作额外解码、克隆检查点。

## 验证

- `pnpm test`：465 项通过。新增真实 SDK unsupported-setting 警告、中断后的响应身份、严格诊断结构、HTTP／JSON／类型错误、用量证据与默认零、共享工具参数、结构化事件容量及代理对回归。旧 FirstTokenProbe 的重复解析测试随实现删除，首字时间改由四协议与生成集成测试验证。
- `pnpm test:operations`：原生离线运维传输与重放通过。
- `pnpm build`：全项目类型检查、前后端生产构建和 SW 构建通过。
- `pnpm format:check`、`git diff --check`：通过。
- 生成信息、取消、原生 Alarm／DO 恢复、用量组：23 项浏览器／运行时测试通过。覆盖四协议刷新、第二客户端、复制、备份及恢复；Chat 响应模型／ID 和补全用量已核对到 UI。
- 供应商设置、错误详情、流式恢复、四协议工具 Workflow、私有续接及原生事务组：49 项通过，合计 72 项。响应时间改用应用语言格式后，另复测一项生成详情通过。

## 本地资源

命令：

```sh
pnpm measure stream --chunks 120 --interval 25 --size 200 --output /tmp/everchat-sdk-stream-final.json
pnpm measure tools --chunks 120 --interval 25 --size 200 --output /tmp/everchat-sdk-tools-final.json
```

原始报告：[普通流](ai-sdk-integration-stream.json)、[工具流](ai-sdk-integration-tools.json)。与上一轮相同工作负载的诊断计数相比，检查点、SQL 写入行与分配空间均未增加：

| 场景               | 检查点 | Conversation SQL 写入行 | 数据库字节 |
| ------------------ | ------ | ----------------------- | ---------- |
| 在线正文           | 3      | 55                      | 356,352    |
| 在线正文与思考     | 4      | 70                      | 434,176    |
| 断线长正文         | 7      | 95                      | 569,344    |
| Chat 工具在线      | 4      | 207                     | 327,680    |
| Responses 工具在线 | 4      | 206                     | 327,680    |
| Anthropic 工具在线 | 4      | 206                     | 327,680    |
| Gemini 工具在线    | 4      | 204                     | 327,680    |
| Chat 工具断线      | 4      | 207                     | 327,680    |
| 服务拒绝           | 1      | 122                     | 303,104    |
| 五轮工具交换       | 8      | 579                     | 335,872    |

工具场景模型／工具请求分别保持 2／2、服务拒绝 1／1、多轮 6／10，私有原始流字节与同步事件持久化均为 0，终态清理检查通过。`modelBytesSource` 仍表示应用事件字节，不能当成供应商网络流量。

结构化容量检查另有[本地微测量](ai-sdk-event-budget-2026-10-20.json)：5000 个事件，每个事件重复四次 `中🙂"\\\n`，每三个事件有一个是思考。两条路径都编码最终传输；基线额外 `feed`、`drainDeltas`、`checkpoint().failure`，新路径使用 `accept`、`drainDeltas`、`failure`。交替顺序执行并排除前两轮预热，记录七次样本。该测量只比较容量桥接，不含完整模型／网络／持久化管线，不设不稳定的耗时测试阈值。首轮与其他验证并行的样本也保留；空闲后的复测中位数为编码再解码 20.59 ms、直接应用 11.61 ms，仅该局部约降低 44%。

## 证据边界

所有供应商和联网请求均使用本地模拟，不产生真实模型费用。资源测量是本地诊断；不代表 Workers Free 的 CPU 时间、DO 活跃时长、线上延迟或计费额度证明。现有低频持久化和客户端预览机制保持不变。

本地 `wrangler deploy --dry-run --config dist/everchat/wrangler.json` 得到约 3.4 MiB 未压缩、623 KiB gzip。按[当前平台限制](https://developers.cloudflare.com/workers/platform/limits/#worker-size)，Workers Free 的包大小约束为未压缩 64 MiB，压缩体积仅供参考；这一检查没有执行线上部署，也不能证明运行时 CPU／启动时间或免费额度。
