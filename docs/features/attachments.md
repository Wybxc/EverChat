# 对话文件与 R2 存储

对话文件管理支持：上传、进度、取消、下载、删除和跨设备列表。文件管理保存 PNG／JPEG／WebP、UTF-8 文本（含 HTML／SVG／XML、代码、Markdown、CSV 等）和 PDF 原文件。阶段 4 第 2 项另有聊天中的[图片输入](images.md)，可上传、粘贴、预览并交给视觉模型；阶段 4 第 3 项另有[轻量文本文件输入](documents.md)，第 4 项另有 [PDF 文本输入](pdf.md)；[独立附件复制](attachment-copies.md)和[可恢复 ZIP 备份](attachment-backups.md)均已实现。

## 使用与部署

打开已经保存到云端的对话，在右上角选择「管理对话文件」。上传进度表示浏览器已发送的字节，100% 后仍需等待云端保存完成；只有「已保存」文件可下载。关闭窗口会继续当前上传，离开对话或退出应用会取消。整个页面关闭或网络中断可能使上传未完成，不能将进度条视作持久化确认。已保存的文件可由同一空间的其他登录设备读取。

本地 `pnpm dev` 使用 Cloudflare 模拟 R2，数据与 DO 一同保存在 `.wrangler/`。端到端测试使用独立临时目录，不访问真实桶。

生产环境需要在目标账户启用 R2，并创建私有 Standard 桶：

```sh
pnpm exec wrangler r2 bucket create everchat-attachments --storage-class Standard
```

`wrangler.jsonc` 的 `ATTACHMENTS` 绑定指向该桶；若更换名字，修改对应的 `bucket_name`。保留私有访问，不开启 `r2.dev` 或公共域名。私有接口由 Cloudflare Access 与应用鉴权保护。上传先签发不可覆盖的短期 R2 PUT URL，长期桶凭据不会发送给浏览器。绑定和流式读写方法依据 [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)。自行部署的签名与 CORS 配置见[部署指南](../operations/self-hosting.md)。

不使用文件功能时，可以移除 `r2_buckets` 绑定后部署：普通聊天继续工作，文件入口隐藏，附件登记／读取明确返回未配置错误。已有清理登记保留，待重新绑定后由 Alarm 继续处理，不因缺少桶而丢弃记录或持续空转。

## 持久化与并发

Library DO 保存文件元数据、固定版本、上传／准备状态及清理任务；R2 保存原文件、规范文本、索引和私有输入快照。正文不重复存入消息 SQL，浏览器草稿只保存引用。

客户端登记文件后直接 PUT 到私有 R2，再通过 HEAD 接收确认。签名绑定独立随机键与 `If-None-Match: *`，防止旧 URL 覆盖已保存内容。相同 ID 的相同登记幂等，改变元数据或跨对话复用 ID 会被拒绝。上传与文本准备是两个阶段；接收只确认大小和类型，完整 UTF-8 与内容哈希在文本准备时验证。

读取要求当前对话的 ready 文件，并在异步读取后复核删除状态。响应使用 `no-store`、下载头及 `nosniff`，不会通过 SW 缓存泄露私有内容。HTML／SVG 只作为原始文本处理。图片和 PDF 使用各自的解码／提取路径。

删除先持久化移除标记，再由 Alarm 清理原文件、规范文本、索引和快照；正在准备的操作、消息及活动任务引用继续复核。登记租约、取消、重试和未知结果清理沿用现有机制。复制和备份恢复保留固定文本版本，不重新提取历史资料。

## 资源边界

单个原文件允许 1 至 100,000,000 字节，不设每日上传次数、文件数量或累计容量的应用配额。Cloudflare 实际请求、SQL、存储、CPU 和账户账单仍是边界，不能从文件数量推算免费额度。

普通文本超过 1 MiB 增量准备；预览与模型按需工具使用范围读取和有界扫描。显式全文读取仍有 32 MiB 工作集保护，模型请求还受上下文和序列化预算约束。详见[文本输入](documents.md)、[R2 直传](../plans/r2-direct-upload-plan.md)和[当前资源政策](../architecture/free-tier-resource-policy.md)。

## 验证

元数据、UTF-8、哈希和位置处理有单元回归；本地原生 Worker／DO／R2 与浏览器测试覆盖直传、接收、解析、范围预览、模型工具交换、权限、故障清理、复制与备份。最新证据见[文本附件执行记录](../measurements/on-demand-attachments-2026-10-31.md)。本地测试不证明实际免费额度、CPU 余量或供应商问答质量。
