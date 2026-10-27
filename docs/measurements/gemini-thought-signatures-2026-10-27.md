# Gemini 工具续接思考签名警告排查

日期：2026-10-27。代码基线：`bf8ca6b`。依赖：`ai@7.0.145`、`@ai-sdk/google@4.0.93`。

## 结论与证据边界

已确认警告发生在工具结果续接请求的组装阶段：Google 适配器发现历史 `functionCall` 缺少签名，于是补入 `skip_thought_signature_validator` 并报告警告。它不是网页搜索／读取工具执行失败，也不是 Cloudflare 错误。

尚不能确认该生产请求最初在哪里丢失签名。现有证据不支持直接认定是 EverChat 持久化丢字段。正常签名经 EverChat 的收集、JSON 序列化、SQLite 保存恢复和再次发送均可保留；另外复现了一个 SDK 在工具参数流结束块中漏收签名的边界问题，但没有该生产请求的原始流证明它命中了这个边界。

当前最需要区分的是：供应商兼容接口没有返回标准签名，还是返回了当前 SDK 没有正确处理的签名块。下面记录的是修复前诊断；已实施的 SDK 边界修复见文末。

## 生产对话只读核对

- 用户指定对话使用第三方 Gemini 兼容接口，协议为 `gemini`。
- 该回答有四次模型请求与三次联网工具请求。工具依次为读取网页、搜索、读取网页，每轮各一个调用。
- 页面实际保留了三条警告，缺失数依次为 1、2、3。后面的请求会回放前面所有工具轮次，因此数字累加，不代表同一轮有三个并行调用。
- 最终回答已完成。占位值让请求继续，但它不能恢复原始加密思考状态，成功返回不能证明思考上下文完整保留。
- 只读取了目标对话、生成信息、相关请求记录与供应商协议／端点。没有读取明文密钥、修改设置、发送真实模型测试请求或修改生产数据。

## 官方规则与 SDK 行为

[Google 文档](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)要求将收到的签名放回原来的内容部分。对当前用户轮次中的多步工具调用，每个模型步骤的第一个函数调用都需要签名；同一步的后续并行调用可以不带签名。

`skip_thought_signature_validator` 是文档允许的缺失签名占位值，用于没有原签名的特殊历史构造场景。它绕过校验，不等价于保留原签名。

本机 SDK 的 `convert-to-google-messages.ts` 已包含“首个函数调用有签名时，后续并行调用不触发警告”的处理。这是上游 [#16298](https://github.com/vercel/ai/issues/16298) 所述误报的修复方向。目标对话每轮只有一个工具调用，本身也不符合该并行误报场景。

警告里的“Gemini 3”是适配器共用的警告文案。相同校验路径也会在本机 `gemini-4-argon` 配置中触发；这行文字不能证明实际请求的模型 ID 是 Gemini 3。

## EverChat 字段传递检查

1. SDK 从供应商 `Part.thoughtSignature` 生成 `providerMetadata.google.thoughtSignature`。
2. [`ProviderToolCollector`](../../worker/providers/tool-turn.ts) 在 `tool-input-start`、`tool-input-delta`、`tool-input-end`、`tool-call` 中合并 metadata，将其保存在私有 `content[].providerOptions`。
3. [`ToolTaskJournal.saveTurn()`](../../worker/web-tools/task-journal.ts) 将整个 turn 序列化到私有 SQL 字段，没有按字段筛除 `providerOptions`。
4. `providerToolPrompt()` 将 `turn.content` 直接用作 assistant 消息，再附上对应工具结果。签名没有从公开的 `turn.calls` 重建；公开调用对象不带签名是预期行为。
5. 任务结束时，`ToolTaskJournal` 清空私有 `turn`。因此已结束任务中的原签名及供应商原始流无法通过现有聊天记录事后还原。

## 本地验证

使用现有生产调用链与本地合成 SSE，没有真实供应商请求。

| 场景                             | 私有续接状态         | 再次发送                         | 警告 |
| -------------------------------- | -------------------- | -------------------------------- | ---- |
| 同轮两个完整调用，仅第一个带签名 | 保留第一个原签名     | 原签名原位返回，第二个不补占位值 | 无   |
| 完整调用的原始响应没有签名       | 无签名               | SDK 补占位值                     | 有   |
| 流式参数调用，签名在起始块       | 保留原签名           | 原签名返回                       | 无   |
| 流式参数调用，签名仅在结束块     | **SDK 输出缺少签名** | SDK 补占位值                     | 有   |

已有两项回归通过：

```sh
node --import tsx/esm --test --test-name-pattern='gemini.*(continuation|SQLite)' \
  tests/unit/providers/provider-tools.test.ts \
  tests/unit/web-tools/tool-task-journal.test.ts
```

### SDK 边界问题的最小输入

以下两条 SSE 内容按顺序返回，使用本地测试签名：

```json
{"candidates":[{"index":0,"content":{"role":"model","parts":[{"functionCall":{"id":"call_0","name":"web_search","partialArgs":[{"jsonPath":"$.query","stringValue":"query"}],"willContinue":true}}]}}]}
{"candidates":[{"index":0,"content":{"role":"model","parts":[{"functionCall":{},"thoughtSignature":"fixture-signed"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3,"totalTokenCount":8}}
```

`google-language-model.ts` 在解析结束块时计算了 `providerMeta`，但 `isTerminalChunk` 分支直接调用 `finishActiveStreamingToolCall()`，没有合并结束块 metadata。结束函数沿用起始块的 `active.providerMetadata`，使签名在进入 EverChat 收集器之前已经丢失。

不过，EverChat 当前没有开启 `streamFunctionCallArguments`，Google 适配器默认也不开启；该选项在这个版本中只支持 Vertex。若要用这一复现解释生产实际请求，还需要证明其兼容接口确实返回了上述流式参数格式。不能仅凭这个合成案例认定它是生产根因。

## 后续处理建议

1. 在原始响应、SDK 事件、私有 turn、再次组装的消息四个边界增加有界诊断：轮次、调用 ID／顺序、工具名、原始块类型、签名是否存在与长度。不要记录签名值、正文、网页内容或完整原始流，也不要增加逐 token SQL 写入。
2. 在下一次实际使用中检查：原始标准 `functionCall` 是否带签名。如果原始响应就缺失，应修复／反馈供应商的透传行为，或使用能够保留签名的供应商接口；应用无法重造真实签名。
3. 若原始响应有签名而 SDK 事件没有，依据实际块格式修正适配器，优先采用上游修复或最小依赖补丁；不重新实现整套 Gemini 流解析器。
4. 若 SDK 事件有签名而私有 turn 或发出消息没有，再修复 EverChat 的具体传递边界，并增加真实模型 ID 下的多轮、JSON／SQLite 恢复回归。
5. 保留缺签名警告与请求继续策略，不把占位值伪装成真实签名，也不通过过滤警告掩盖缺失。

## 已实施的边界修复

通过 [`config/patches/@ai-sdk__google@4.0.93.patch`](../../config/patches/@ai-sdk__google@4.0.93.patch) 修复 SDK 的原始解析层，同时更新发布包中的源码和实际执行的 `dist/index.js`。`pnpm-workspace.yaml` 声明补丁，锁文件记录补丁哈希，`@ai-sdk/google` 固定为 `4.0.93`，避免自动更新绕过修复。

当续接的 `partialArgs` 块或结束块携带签名时，先将其保存在对应 active tool call，再完成调用。没有新签名的后续块保留已有签名。签名作为不透明的完整值传递，不拼接、不挪到其他工具调用，不在业务层重复解析 Gemini SSE。

新增回归覆盖起始块、普通参数增量、空参数增量、最后参数块、结束块五种签名位置，以及真正不返回签名的对照场景。测试既检查 SDK 最终 `tool-call` 事件，也检查 EverChat JSON 续接后的实际请求；额外验证两个 SQLite 工具轮次保存恢复后，各自签名仍与原调用对应，且签名不进入公开事件。已有完整并行调用回归使用 Gemini 4 模型 ID，确认仅第一个调用带签名时不会给后续调用补占位值。

修复前七项新增场景中五项失败、两项对照通过；应用补丁后七项全部通过。真正没有签名时仍保留占位策略和警告。本次修复不增加生产诊断写入或数据库迁移，也不宣称已还原上述生产请求的原始流。

后续升级 Google SDK 时，应先移除补丁，在候选版本上运行这些回归；上游实现覆盖所有晚到签名场景后，删除补丁及其配置，再解除版本固定。
