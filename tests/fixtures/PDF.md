# PDF 测试样本

`pdf.ts` 生成带真实对象、内容流、字体和 xref 偏移的 PDF。Unicode 样本使用内置 `UniGB-UCS2-H` 与显式 ToUnicode，验证浏览器和生产构建的中文资源路径。超长文本使用小字号，使全部测试文字仍在页面范围内；普通大字号会被 PDF.js 按页面裁掉，不适合证明提取长度上限。

`password.pdf` 为这里的单页 `textPdf()` 经过 MuPDF `mutool clean` 生成的 AES-256 加密样本；用户口令为 `fixture-user`，所有者口令为 `fixture-owner`。这些只是测试值。可复现的加密命令：

```sh
mutool clean -E aes-256 -O fixture-owner -U fixture-user source.pdf password.pdf
```

测试读取已经保存的样本，不要求开发者安装 MuPDF。
