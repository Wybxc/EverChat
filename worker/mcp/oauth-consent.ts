import type { McpAuthorizationRequest } from './oauth-store';

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const copy = {
  en: {
    title: 'Connect an app to EverChat',
    client: 'App',
    callback: 'Callback',
    summary: 'This app will be able to:',
    generate: 'Start model requests that may incur charges.',
    access: 'Read and continue its own conversations and manage its own attachments.',
    lifetime: 'This connection expires after 30 days. You can disconnect it in MCP settings.',
    allow: 'Allow access',
    deny: 'Cancel',
  },
  zh: {
    title: '连接应用到 EverChat',
    client: '应用',
    callback: '回调地址',
    summary: '此应用将获得以下权限',
    generate: '发起可能产生费用的模型请求。',
    access: '读取和继续自己创建的对话，并管理自己的附件。',
    lifetime: '授权有效期为 30 天。你可以在「设置 → MCP」断开连接。',
    allow: '允许访问',
    deny: '取消',
  },
};

export function mcpConsentPage(
  request: McpAuthorizationRequest,
  id: string,
  path: string,
  cookie: string,
  language: string | null,
) {
  const lang = language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  const text = copy[lang];
  const callback = new URL(request.redirectUri).origin;
  const html = `<!doctype html>
<html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${text.title}</title>
<style>
  :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
  body { min-height: 100svh; box-sizing: border-box; display: grid; place-items: center; margin: 0; padding: 1rem; background: Canvas; color: CanvasText; }
  main { width: min(100%, 30rem); box-sizing: border-box; border: 1px solid GrayText; border-radius: 0.875rem; padding: clamp(1.125rem, 5vw, 2rem); }
  h1 { font-size: clamp(1.25rem, 5vw, 1.6rem); line-height: 1.2; margin: 0 0 1.25rem; }
  p, dl, ul { margin: 0 0 1rem; }
  dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.375rem 1rem; }
  dt { color: GrayText; }
  dd { margin: 0; overflow-wrap: anywhere; }
  ul { padding-inline-start: 1.25rem; }
  form { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.5rem; }
  button { font: inherit; border: 1px solid ButtonBorder; border-radius: 0.5rem; padding: 0.5rem 1rem; color: ButtonText; background: ButtonFace; cursor: pointer; }
  button[value="allow"] { background: #14786c; border-color: #14786c; color: white; }
</style>
<main>
  <h1>${text.title}</h1>
  <dl>
    <dt>${text.client}</dt><dd>${escapeHtml(request.name)} · ${escapeHtml(new URL(request.clientId).hostname)}</dd>
    <dt>${text.callback}</dt><dd>${escapeHtml(callback)}</dd>
  </dl>
  <p>${text.summary}</p>
  <ul><li>${text.generate}</li><li>${text.access}</li></ul>
  <p>${text.lifetime}</p>
  <form method="post" action="${path}">
    <input type="hidden" name="transaction" value="${id}">
    <button type="submit" name="decision" value="deny">${text.deny}</button>
    <button type="submit" name="decision" value="allow">${text.allow}</button>
  </form>
</main></html>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${callback}; frame-ancestors 'none'; base-uri 'none'`,
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-Robots-Tag': 'noindex, nofollow',
      'Set-Cookie': cookie,
    },
  });
}
