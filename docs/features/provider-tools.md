# 供应商工具

在聊天输入栏打开「供应商工具」，按供应商连接和模型单独启用所需工具。设置随对话保存。模型决定是否调用已启用的工具，执行记录和可公开的引用显示在回答下方。

| 接口                        | 工具                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| OpenAI Responses            | 联网搜索、文件检索、代码解释器、图像生成、托管 Shell                       |
| Anthropic Messages          | 联网搜索、读取网页、代码执行、顾问、工具搜索                               |
| Gemini GenerateContent      | Google 搜索、URL Context、文件检索、代码执行                               |
| DeepSeek                    | DeepSeek Flash 的原生搜索与读取网页，DeepSeek V4 Pro 的 Responses 联网搜索 |
| OpenRouter Chat Completions | OpenRouter 联网搜索与读取网页                                              |

EverChat 按供应商地址、接口和模型提供目录。刷新 Claude 模型列表时，目录会优先采用供应商返回的服务端工具能力。配置自建兼容网关时，目录不会自动继承上游的原生工具。可用性仍受账号权限和服务端限制影响。文件检索可以从当前连接的检索库目录选取最多两个库，也可以输入库 ID。

如果已知接口上的联网工具缺少模型能力信息，可点「测试」发送一次简短请求。只有观察到对应工具执行完成才会启用。换接口或密钥后须重新测试。

图像生成显示一张流式预览，并在完成后保留可下载的最终图片。代码执行返回的文件和图片随回答保存，可从原对话和备份中取回。单个产物最多 8 MiB。

开启聊天输入栏的「联网搜索」后，EverChat 优先启用当前模型可用的原生网页搜索和读取工具。原生工具不可用或与当前会话的工具配置不兼容时，使用「联网」设置中配置的服务。一次发送使用一种联网方式，原生调用按供应商用量计费。Claude 可以在使用供应商工具的同时调用 EverChat 附件工具。供应商暂停时，EverChat 续接已确认的模型轮次，最多续接三次。

在「工具 → 远程 MCP」可添加 Streamable HTTP 服务。保存连接后读取工具目录，再为当前对话选择具体工具。EverChat 直接执行时，Bearer 令牌只发送给保存的服务地址。服务端明确声明为只读的工具可直接执行。其余调用会展示目标地址和参数，由用户逐次允许或拒绝。

OpenAI Responses 和 Claude 可以作为 MCP 执行方。选择「模型供应商」后，供应商会收到该连接的凭据和模型工具输入。OpenAI 的托管调用逐次确认，审批随当前对话续接。Claude 托管限服务端声明为只读的工具，启用工具搜索后由 Claude 按需加载已选工具。[OpenAI MCP](https://developers.openai.com/api/docs/guides/tools-connectors-mcp) · [Claude MCP](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)

用量详情显示供应商报告或流中观察到的调用。模型价格和已知的独立工具费分别计量。Google 分层计费、OpenRouter 搜索引擎费率和沙箱运行时长没有可通用的换算规则，界面将相应估算标为部分计价。

供应商协议见 [OpenAI](https://developers.openai.com/api/docs/guides/tools)、[Anthropic](https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools)、[Gemini](https://aistudio.google.com/docs/tool-combination)、[DeepSeek](https://api-docs.deepseek.com/guides/web_tools/)、[OpenRouter](https://openrouter.ai/docs/guides/features/server-tools/overview)。价格参考见 [OpenAI](https://developers.openai.com/api/docs/pricing)、[Anthropic](https://platform.claude.com/docs/en/about-claude/pricing)、[DeepSeek](https://api-docs.deepseek.com/quick_start/pricing/)。
