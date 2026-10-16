import { messageFiles,messageImages,messageText } from '../../../shared/conversation/content';
import type { Message } from '../../../shared/conversation/types';
import { downloadFile,escapeHtml } from './download';

export function exportChatFile(selected: string, title: string, messages: Message[], format: 'md' | 'txt' | 'html') {
    const markdown = `# ${title}\n\n${messages.map((message) => {
      const role = message.summary ? '历史摘要' : message.role === 'user' ? '你' : 'EverChat';
      const model = message.role === 'assistant' && (message.modelName || message.model) ? `\n模型：${message.modelName || message.model}\n` : '';
      const reasoning = messageText(message, 'reasoning') ? `\n### 思考过程\n\n${messageText(message, 'reasoning')}\n` : '';
      const status = message.status === 'completed' ? '' : `\n状态：${message.status}${message.error ? `（${message.error}）` : ''}\n`;
      return `## ${role}${message.revisionOf ? ' · 新版本' : ''}${model}\n\n${messageText(message)}${messageImages(message).map((image) => `\n[图片：${image.name}]`).join('')}${messageFiles(message).map((file) => `\n[文件：${file.name}]`).join('')}${reasoning}${status}\n`;
    }).join('\n')}`;
    if (format === 'md') downloadFile(`EverChat-${selected}.md`, markdown, 'text/markdown;charset=utf-8');
    else if (format === 'txt') downloadFile(`EverChat-${selected}.txt`, markdown.replace(/^#{1,6} /gm, '').replace(/^\n### /gm, '\n'), 'text/plain;charset=utf-8');
    else {
      const body = messages.map((message) => `<article><h2>${escapeHtml(message.summary ? '历史摘要' : message.role === 'user' ? '你' : 'EverChat')}${message.revisionOf ? ' · 新版本' : ''}</h2>${message.role === 'assistant' && (message.modelName || message.model) ? `<p class="meta">模型：${escapeHtml(message.modelName || message.model || '')}</p>` : ''}<pre>${escapeHtml(messageText(message))}${messageImages(message).map((image) => `\n[图片：${escapeHtml(image.name)}]`).join('')}${messageFiles(message).map((file) => `\n[文件：${escapeHtml(file.name)}]`).join('')}</pre>${messageText(message, 'reasoning') ? `<details open><summary>思考过程</summary><pre>${escapeHtml(messageText(message, 'reasoning'))}</pre></details>` : ''}${message.status !== 'completed' ? `<p class="error">状态：${escapeHtml(message.status)}${message.error ? `（${escapeHtml(message.error)}）` : ''}</p>` : ''}</article>`).join('');
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:54rem;margin:2rem auto;padding:0 1rem;color:#1f2937}article{border-top:1px solid #d1d5db;padding:1.5rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.meta{color:#6b7280;font-size:.875rem}.error{color:#b91c1c}summary{cursor:pointer}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
      downloadFile(`EverChat-${selected}.html`, html, 'text/html;charset=utf-8');
    }
}
