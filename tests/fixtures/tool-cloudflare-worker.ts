// API-only isolated deployment: native Workflow, mock supplier HTTP and no R2 dependency.
import fixture, { Conversation as BaseConversation, Library as BaseLibrary } from './cloudflare-worker';
import { authenticated } from '../../worker/http/auth';
import { json } from '../../worker/http/response';
import type { Env } from '../../worker/http/env';
import { toolWorkflowId } from '../../worker/web-tools/workflow';
import { TOOL_VALIDATION_WORKER, type ToolValidationConversation, type ToolValidationIdentity, type ToolValidationLibrary } from '../../scripts/measurements/support/validation';
export { WebToolWorkflow } from '../../worker/web-tools/workflow';
type ValidationEnv = Env & { VALIDATION_RUN_ID?: string; LOCAL_RESOURCE_METRICS?: string; LOCAL_TOOL_WORKLOAD?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class Conversation extends BaseConversation {
  validationPrepare(mode: 'service' | 'service-401') {
    const sql = this.ctx.storage.sql;
    if (sql.exec('SELECT id FROM web_tool_tasks LIMIT 1').toArray().length) throw new Error('Prepare only an unused validation conversation');
    sql.exec('CREATE TABLE IF NOT EXISTS fixture_tool_service (id INTEGER PRIMARY KEY, mode TEXT NOT NULL)');
    sql.exec('INSERT INTO fixture_tool_service VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET mode = excluded.mode', mode);
  }
  async validationStatus(taskId: string): Promise<ToolValidationConversation> {
    // Deliberately do not call toolTaskState(), snapshot(), expire() or any
    // cleanup helper. Observation must not repair the state it is testing.
    const sql = this.ctx.storage.sql;
    const count = (table: string, where = '') => sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} ${where}`).one().n;
    const exists = (table: string) => sql.exec('SELECT name FROM sqlite_master WHERE name = ?', table).toArray().length > 0;
    const task = sql.exec<{ status: string; round: number; modelRequests: number; toolRequests: number }>(
      'SELECT status, round, modelRequests, toolRequests FROM web_tool_tasks WHERE id = ?', taskId).toArray()[0] ?? null;
    const dispatch = sql.exec<{ conversationId: string }>('SELECT conversationId FROM tool_workflows WHERE rootId = ?', taskId).toArray()[0];
    const workflowStatus = dispatch ? await this.env.WEB_TOOLS.get(toolWorkflowId(dispatch.conversationId, taskId))
      .then((instance) => instance.status()).then((status) => status.status).catch(() => null) : null;
    return { databaseBytes: sql.databaseSize, alarmAt: await this.ctx.storage.getAlarm(), task, workflowStatus,
      pendingSearch: count('search_outbox'), pendingNotifications: count('web_tool_notifications'),
      privateStreams: count('tool_stream_commits'), privatePayloads: count('web_tool_models', 'WHERE turn IS NOT NULL'),
      retainedContexts: count('runs', "WHERE config IS NOT NULL OR context != '[]'"),
      modelCalls: exists('fixture_calls') ? sql.exec<{ n: number }>('SELECT COALESCE(SUM(calls), 0) AS n FROM fixture_calls').one().n : 0,
      serviceRequests: exists('fixture_service_requests') ? count('fixture_service_requests') : 0 };
  }
}
export class Library extends BaseLibrary {
  async validationStatus(): Promise<ToolValidationLibrary> {
    const sql = this.ctx.storage.sql;
    return { databaseBytes: sql.databaseSize, alarmAt: await this.ctx.storage.getAlarm(),
      pendingBackfills: sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM search_backfill WHERE done = 0').one().n,
      usedToday: sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM web_tool_requests WHERE day = ?', new Date().toISOString().slice(0, 10)).one().n };
  }
}
export default {
  async fetch(request: Request, env: ValidationEnv, ctx: ExecutionContext) {
    const url = new URL(request.url), path = url.pathname;
    const identity: ToolValidationIdentity = { kind: TOOL_VALIDATION_WORKER, version: 1, runId: env.VALIDATION_RUN_ID ?? '', mockUpstreams: true,
      counters: { generation: env.GENERATION_METRICS === '1', local: env.LOCAL_RESOURCE_METRICS === '1' },
      workload: env.LOCAL_TOOL_WORKLOAD ? JSON.parse(env.LOCAL_TOOL_WORKLOAD) : { chunks: 120, size: 200, interval: 25 } };
    if (path === '/api/__validation/identity' && request.method === 'GET') return json(identity);
    if (identity.counters.generation || identity.counters.local || !uuid.test(identity.runId)) return json({ error: 'Validation configuration is unsafe' }, 503);
    if (path.startsWith('/api/__test/')) return json({ error: 'Not found' }, 404);
    if (path.startsWith('/api/__validation/') && path !== '/api/__validation/storage') {
      if (!await authenticated(request, env)) return json({ error: 'Unauthorized' }, 401);
      if (path === '/api/__validation/library' && request.method === 'GET')
        return json(await (env.LIBRARY as unknown as DurableObjectNamespace<Library>).getByName('personal').validationStatus());
      const match = /^\/api\/__validation\/conversations\/([^/]+)\/(prepare|status)$/.exec(path);
      if (!match || !uuid.test(match[1])) return json({ error: 'Not found' }, 404);
      const conversation = (env.CONVERSATIONS as unknown as DurableObjectNamespace<Conversation>).getByName(match[1]);
      if (match[2] === 'status' && request.method === 'GET') {
        const taskId = url.searchParams.get('taskId');
        return taskId && uuid.test(taskId) ? json(await conversation.validationStatus(taskId)) : json({ error: 'Invalid task ID' }, 400);
      }
      if (match[2] === 'prepare' && request.method === 'POST') {
        if (request.headers.get('Origin') !== url.origin) return json({ error: 'Untrusted origin' }, 403);
        // Only two bounded preparation modes; no generic fixture mutation RPCs.
        const reader = request.body?.getReader(); let text = '';
        if (!reader) return json({ error: 'Missing body' }, 400);
        try {
          const decoder = new TextDecoder(); let bytes = 0;
          while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength;
            if (bytes > 1024) { await reader.cancel(); return json({ error: 'Body too large' }, 413); } text += decoder.decode(part.value, { stream: true }); }
          const body = JSON.parse(text + decoder.decode()) as { mode?: unknown };
          if (body.mode !== 'service' && body.mode !== 'service-401') return json({ error: 'Invalid preparation mode' }, 400);
          await conversation.validationPrepare(body.mode); return json({ prepared: true });
        } catch { return json({ error: 'Invalid preparation' }, 400); }
        finally { reader.releaseLock(); }
      }
      return json({ error: 'Not found' }, 404);
    }
    return fixture.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<ValidationEnv>;
