export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  let result: { error?: string };
  try { result = await response.json(); }
  catch {
    if (!response.ok) throw new ApiError(response.status, '云端服务暂时不可用，请稍后重试。');
    throw new Error('云端响应格式无效，请重新同步。');
  }
  if (!response.ok) throw new ApiError(response.status, typeof result?.error === 'string' ? result.error : '请求失败，请稍后重试。');
  return result as T;
}
