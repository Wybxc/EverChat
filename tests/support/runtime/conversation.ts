import { createHash } from 'node:crypto';
import type { StreamBatch } from '../../../shared/streaming/protocol';
import type { WebToolServiceConfig } from '../../../shared/web-tools/service';
import type { WebToolCall, WebToolName, WebToolOutcome } from '../../../shared/web-tools/tasks';
import type { Env } from '../../../worker/http/env';
import { Conversation as ProductionConversation } from '../../../worker/index';
import { MAX_DATABASE_BYTES } from '../../../worker/platform/resource-limits';
import type { openProviderStream } from '../../../worker/providers/stream';
import { toolWorkflowId, type ToolWorkflowParams } from '../../../worker/web-tools/workflow';
import type { MeasurementEnv } from './env';
import type { Library } from './library';
import { FixtureResourceMeter } from './resource-meter';
import { ToolJournalFixture, type ToolJournalControl } from './tool-task-journal';

export class Conversation extends ProductionConversation {
  private readonly resourceMeter?: FixtureResourceMeter;
  private readonly resourceStorage: DurableObjectStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    const resourceStorage = ctx.storage;
    const resourceMeter =
      (env as MeasurementEnv).LOCAL_RESOURCE_METRICS === '1'
        ? new FixtureResourceMeter()
        : undefined;
    super(resourceMeter ? resourceMeter.wrapState(ctx) : ctx, env);
    this.resourceMeter = resourceMeter;
    this.resourceStorage = resourceStorage;
  }
  async fixtureTitles(restart = false) {
    if (restart) this.ctx.abort('Intentional title task restart');
    return {
      calls: this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name='fixture_title_calls'")
        .toArray().length
        ? this.ctx.storage.sql
            .exec<{ calls: number }>(
              'SELECT COALESCE(SUM(calls),0) AS calls FROM fixture_title_calls',
            )
            .one().calls
        : 0,
      jobs: this.ctx.storage.sql
        .exec(
          'SELECT id,state,version,automatic,error,config IS NOT NULL AS retainsConfig FROM title_jobs ORDER BY rowid',
        )
        .toArray(),
      automatic: this.ctx.storage.sql.exec('SELECT consumed FROM title_automatic').toArray(),
      alarmAt: await this.ctx.storage.getAlarm(),
    };
  }
  async fixtureResourceControl(windowId?: string) {
    if (!this.resourceMeter) throw new Error('Local resource measurement is disabled');
    if (windowId) this.resourceMeter.begin(windowId);
    // Use unwrapped storage: observing completion must not add SQL to the workload.
    const sql = this.resourceStorage.sql;
    const count = (table: string, where = '') =>
      sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table} ${where}`).one().count;
    const alarmAt = await this.resourceStorage.getAlarm();
    return {
      report: this.resourceMeter.read(),
      databaseBytes: sql.databaseSize,
      alarmAt,
      pendingSearch: count('search_outbox'),
      pendingNotifications: count('web_tool_notifications'),
      privateStreams: count('tool_stream_commits'),
      privatePayloads: count('web_tool_models', 'WHERE turn IS NOT NULL'),
      retainedContexts: count('runs', "WHERE config IS NOT NULL OR context != '[]'"),
      task:
        sql
          .exec<{ status: string; round: number; modelRequests: number; toolRequests: number }>(
            'SELECT status, round, modelRequests, toolRequests FROM web_tool_tasks ORDER BY rowid DESC LIMIT 1',
          )
          .toArray()[0] ?? null,
    };
  }
  override async submit(...args: Parameters<ProductionConversation['submit']>) {
    if (args[2]?.model.startsWith('tools-service-') && !this.serviceMode())
      this.ctx.storage.sql.exec('INSERT INTO fixture_tool_service VALUES (1, ?)', 'service');
    return super.submit(...args);
  }
  private consumeToolFault(kind: string) {
    const sql = this.ctx.storage.sql;
    sql.exec(
      'CREATE TABLE IF NOT EXISTS fixture_tool_faults (kind TEXT PRIMARY KEY, remaining INTEGER NOT NULL)',
    );
    if (
      !sql
        .exec<{ remaining: number }>(
          'SELECT remaining FROM fixture_tool_faults WHERE kind = ? AND remaining > 0',
          kind,
        )
        .toArray().length
    )
      return false;
    sql.exec('UPDATE fixture_tool_faults SET remaining = remaining - 1 WHERE kind = ?', kind);
    return true;
  }
  protected override async createWebToolWorkflow(params: ToolWorkflowParams) {
    const instance = await super.createWebToolWorkflow(params);
    if (this.consumeToolFault('create-lost'))
      throw new Error('Injected lost Workflow creation response');
    return instance;
  }
  protected override async notifyWebToolWorkflow(taskId: string, round: number) {
    if (this.consumeToolFault('event-once'))
      throw new Error('Injected Workflow event delivery failure');
    await super.notifyWebToolWorkflow(taskId, round);
  }
  private serviceMode() {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS fixture_tool_service (id INTEGER PRIMARY KEY, mode TEXT NOT NULL)',
    );
    return this.ctx.storage.sql
      .exec<{ mode: string }>('SELECT mode FROM fixture_tool_service WHERE id = 1')
      .toArray()[0]?.mode;
  }
  protected override webToolsConfigured(
    names: readonly WebToolName[],
    service?: WebToolServiceConfig,
  ) {
    return this.serviceMode() ? super.webToolsConfigured(names, service) : true;
  }
  protected override async fetchWebTool(request: Request): Promise<Response> {
    if (!['https://api.tavily.com/search', 'https://api.tavily.com/extract'].includes(request.url))
      throw new Error('Unexpected service origin');
    this.resourceMeter?.upstream('toolRequests');
    const sql = this.ctx.storage.sql,
      mode = this.serviceMode(),
      body = await request.json();
    sql.exec(
      'CREATE TABLE IF NOT EXISTS fixture_service_requests (seq INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT, body TEXT, authDigest TEXT)',
    );
    sql.exec(
      'INSERT INTO fixture_service_requests(url, body, authDigest) VALUES (?, ?, ?)',
      request.url,
      JSON.stringify(body),
      createHash('sha256')
        .update(request.headers.get('Authorization') ?? '')
        .digest('hex'),
    );
    await new Promise<void>((resolve) => {
      const timer = setTimeout(
        resolve,
        mode === 'service-timeout' ? 20_000 : mode === 'service-slow' ? 10_000 : 1500,
      );
      request.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    request.signal.throwIfAborted();
    if (mode === 'service-401' || mode === 'service-429') {
      const rejected = request.headers.get('Authorization') ?? '';
      this.resourceMeter?.upstream(
        'toolResponseBytes',
        new TextEncoder().encode(rejected).byteLength,
      );
      return new Response(rejected, { status: Number(mode.slice(-3)) });
    }
    const source = {
      url: 'https://developers.cloudflare.com/',
      title: 'Cloudflare 文档',
      content: '本地工具结果🙂',
    };
    const result = request.url.endsWith('/search')
      ? { results: [source] }
      : { results: [{ url: source.url, raw_content: source.content }], failed_results: [] };
    this.resourceMeter?.upstream(
      'toolResponseBytes',
      new TextEncoder().encode(JSON.stringify(result)).byteLength,
    );
    return Response.json(result);
  }
  protected override async executeWebTool(
    call: WebToolCall,
    signal: AbortSignal,
    service?: WebToolServiceConfig,
  ): Promise<WebToolOutcome> {
    if (this.serviceMode()) return super.executeWebTool(call, signal, service);
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS fixture_tool_calls (id TEXT PRIMARY KEY, calls INTEGER NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'INSERT INTO fixture_tool_calls VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET calls = calls + 1',
      call.id,
    );
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1500);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    signal.throwIfAborted();
    return {
      id: call.id,
      name: call.name,
      status: 'completed',
      sources: [
        {
          title: 'Cloudflare 文档',
          url: 'https://developers.cloudflare.com/',
          content: '本地工具结果🙂',
        },
      ],
    };
  }
  async fixtureToolRuntime(taskId: string, fault?: string, expire?: boolean) {
    const sql = this.ctx.storage.sql;
    if (fault?.startsWith('service')) {
      this.serviceMode();
      sql.exec(
        'INSERT INTO fixture_tool_service VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET mode = excluded.mode',
        fault,
      );
    }
    if (fault) {
      sql.exec(
        'CREATE TABLE IF NOT EXISTS fixture_tool_faults (kind TEXT PRIMARY KEY, remaining INTEGER NOT NULL)',
      );
      sql.exec(
        'INSERT INTO fixture_tool_faults VALUES (?, 1) ON CONFLICT(kind) DO UPDATE SET remaining = 1',
        fault,
      );
    }
    const exists = sql.exec('SELECT id FROM web_tool_tasks WHERE id = ?', taskId).toArray().length;
    if (exists && expire)
      sql.exec('UPDATE web_tool_tasks SET deadline = ? WHERE id = ?', Date.now() - 1, taskId);
    const state = this.toolTaskState(taskId);
    const dispatch = sql
      .exec<{ conversationId: string }>(
        'SELECT conversationId FROM tool_workflows WHERE rootId = ?',
        taskId,
      )
      .toArray()[0];
    return {
      state,
      workflow: dispatch
        ? await this.env.WEB_TOOLS.get(toolWorkflowId(dispatch.conversationId, taskId))
            .then((instance) => instance.status())
            .catch(() => null)
        : null,
      privatePayloads: sql
        .exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM web_tool_models WHERE turn IS NOT NULL',
        )
        .one().count,
      modelCalls: this.fixtureResources().calls,
      toolCalls: this.fixtureCount('fixture_tool_calls')
        ? sql.exec<{ calls: number }>('SELECT SUM(calls) AS calls FROM fixture_tool_calls').one()
            .calls
        : 0,
      privateStreams: sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM tool_stream_commits')
        .one().count,
      pendingNotifications: sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM web_tool_notifications')
        .one().count,
      serviceRequests: this.fixtureCount('fixture_service_requests')
        ? sql.exec('SELECT * FROM fixture_service_requests ORDER BY seq').toArray()
        : [],
      alarmAt: await this.ctx.storage.getAlarm(),
    };
  }
  private toolJournalFixture?: ToolJournalFixture;
  async fixtureToolJournal(input: ToolJournalControl) {
    if (input.action === 'reset') {
      await this.ctx.storage.sync();
      this.ctx.abort('Intentional tool journal reset', { retryAlarm: true });
    }
    this.toolJournalFixture ??= new ToolJournalFixture(this.ctx.storage);
    return this.toolJournalFixture.control(input);
  }
  async fixtureSearchState(reset: boolean) {
    if (reset) {
      await this.ctx.storage.sync();
      this.ctx.abort('Intentional index reset', { retryAlarm: true });
    }
    return {
      pending: this.ctx.storage.sql.exec('SELECT * FROM search_outbox').toArray(),
      retry: this.ctx.storage.sql.exec('SELECT * FROM search_retry').toArray()[0] ?? null,
      alarmAt: await this.ctx.storage.getAlarm(),
    };
  }
  fixtureIndexedHistory(count: number) {
    if (!Number.isInteger(count) || count < 1 || count > 60)
      throw new Error('Invalid indexed history count');
    if (this.ctx.storage.sql.exec('SELECT id FROM messages LIMIT 1').toArray().length)
      throw new Error('Seed only empty conversation');
    this.ctx.storage.transactionSync(() => {
      for (let i = 0; i < count; i++)
        this.ctx.storage.sql.exec(
          'INSERT INTO messages(id, role, content, reasoning, status, createdAt, runId) VALUES (?, ?, ?, ?, ?, ?, NULL)',
          crypto.randomUUID(),
          'assistant',
          `全文TOKEN 第 ${i} 条，跨越 **格式** 搜索。Unicode ÅBC 😀 中文，literal*mark [a+b]。`,
          `独立思考 ${i}`,
          'completed',
          i,
        );
    });
  }
  private failNextCommit = false;
  private failDelete = false;
  private resetDelete = false;
  fixtureDeleteFailure(reset: boolean) {
    if (reset) this.resetDelete = true;
    else this.failDelete = true;
  }
  override async deleteConversation(deletedAt: number) {
    if (this.failDelete) {
      this.failDelete = false;
      throw new Error('Injected deletion failure');
    }
    return super.deleteConversation(deletedAt);
  }
  protected override async eraseDeletedStorage() {
    await super.eraseDeletedStorage();
    if (this.resetDelete) this.ctx.abort('Intentional reset after deleting storage');
  }
  async fixtureDeletionState() {
    const marker =
      this.ctx.storage.sql
        .exec<{ deletedAt: number }>('SELECT deletedAt FROM conversation_deletion WHERE id = 1')
        .toArray()[0]?.deletedAt ?? null;
    return {
      ...this.fixtureResources(),
      deletedAt: marker,
      alarmAt: await this.ctx.storage.getAlarm(),
      events: this.fixtureCount('events'),
      submissions: this.fixtureCount('submissions'),
    };
  }
  override snapshotResponse() {
    const faults = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE name = 'fixture_storage_fault'")
      .toArray();
    if (faults.length) throw new Error('SQLITE_FULL private fixture diagnostic');
    return super.snapshotResponse();
  }
  fixtureStorageError() {
    this.ctx.storage.sql.exec('CREATE TABLE fixture_storage_fault (id INTEGER)');
  }
  fixtureFillDatabase(target: number) {
    if (!Number.isInteger(target) || target < 0 || target > MAX_DATABASE_BYTES - 512 * 1024)
      throw new Error('Invalid storage fixture size');
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS fixture_padding (payload BLOB NOT NULL)');
    while (sql.databaseSize < target)
      sql.exec(
        'INSERT INTO fixture_padding VALUES (zeroblob(?))',
        Math.min(256 * 1024, target - sql.databaseSize),
      );
    return this.fixtureResources();
  }
  fixtureResources() {
    const sql = this.ctx.storage.sql;
    const hasCalls = sql
      .exec("SELECT name FROM sqlite_master WHERE name = 'fixture_calls'")
      .toArray().length;
    return {
      databaseBytes: sql.databaseSize,
      messages: this.fixtureCount('messages'),
      runs: this.fixtureCount('runs'),
      dependencies: this.fixtureCount('run_dependencies'),
      retainedContexts: this.fixtureCount('runs', "WHERE context != '[]'"),
      journalRows: this.fixtureCount('stream_commits'),
      calls: hasCalls
        ? sql
            .exec<{ calls: number }>('SELECT COALESCE(SUM(calls), 0) AS calls FROM fixture_calls')
            .one().calls
        : 0,
    };
  }
  private fixtureCount(table: string, where = '') {
    if (
      !this.ctx.storage.sql.exec('SELECT name FROM sqlite_master WHERE name = ?', table).toArray()
        .length
    )
      return 0;
    return this.ctx.storage.sql
      .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table} ${where}`)
      .one().count;
  }
  protected override async openModelStream(...args: Parameters<typeof openProviderStream>) {
    const fixtureSql = this.resourceStorage.sql;
    if (args[0].model.startsWith('title-fixture-')) {
      fixtureSql.exec(
        'CREATE TABLE IF NOT EXISTS fixture_title_calls(id TEXT PRIMARY KEY,calls INTEGER NOT NULL)',
      );
      const job = fixtureSql
        .exec<{ id: string }>("SELECT id FROM title_jobs WHERE state='running'")
        .one();
      fixtureSql.exec(
        'INSERT INTO fixture_title_calls VALUES (?,1) ON CONFLICT(id) DO UPDATE SET calls=calls+1',
        job.id,
      );
    }
    if (args[0].model === 'benchmark-summary-write-failure') this.failNextCommit = true;
    if (
      args[0].model.startsWith('alarm-') ||
      args[0].model.startsWith('benchmark-') ||
      args[0].model.startsWith('vision-') ||
      args[0].model.startsWith('documents-') ||
      args[0].model.startsWith('tools-')
    ) {
      fixtureSql.exec(
        'CREATE TABLE IF NOT EXISTS fixture_calls (runId TEXT PRIMARY KEY, calls INTEGER NOT NULL)',
      );
      const run = fixtureSql
        .exec<{ id: string; conversationId: string }>(
          `SELECT runs.id, runs.conversationId FROM runs JOIN messages ON messages.id = runs.assistantId AND messages.runId = runs.id WHERE messages.status = 'running'`,
        )
        .one();
      fixtureSql.exec(
        'INSERT INTO fixture_calls VALUES (?, 1) ON CONFLICT(runId) DO UPDATE SET calls = calls + 1',
        run.id,
      );
      await (this.env.LIBRARY as unknown as DurableObjectNamespace<Library>)
        .getByName('personal')
        .fixtureSupplierCall(run.conversationId);
      if (args[0].model === 'alarm-cancel-tail-failure') {
        let step = 0;
        return new ReadableStream<Uint8Array>({
          pull: async (controller) => {
            if (step++ === 0) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: '停止前的内容'.repeat(200) } }] })}\n\n`,
                ),
              );
              return;
            }
            // Let the first complete event become durable, then fail cancel's tail write.
            await new Promise((resolve) => setTimeout(resolve, 1700));
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: '尚未保存的尾部' } }] })}\n\n`,
              ),
            );
            await new Promise((resolve) => setTimeout(resolve, 150));
            this.failNextCommit = true;
            await this.cancel(run.id);
            try {
              controller.close();
            } catch {
              /* The reader may already have been cancelled. */
            }
          },
        });
      }
    }
    const stream = await super.openModelStream(...args);
    if (!this.resourceMeter) return stream;
    this.resourceMeter.upstream('modelRequests');
    return stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (bytes, controller) => {
          this.resourceMeter!.upstream('modelBytes', bytes.byteLength);
          controller.enqueue(bytes);
        },
      }),
    );
  }
  override commit(runId: string, batches: StreamBatch[]) {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error('Injected storage failure');
    }
    return super.commit(runId, batches);
  }
  async fixtureState(runId: string) {
    const run = this.ctx.storage.sql
      .exec<{ executor: string; cancelRequested: number; startedAt: number | null }>(
        'SELECT executor, cancelRequested, startedAt FROM runs WHERE id = ?',
        runId,
      )
      .one();
    const hasCalls = this.ctx.storage.sql
      .exec(`SELECT name FROM sqlite_master WHERE name = 'fixture_calls'`)
      .toArray().length;
    const calls = hasCalls
      ? (this.ctx.storage.sql
          .exec<{ calls: number }>('SELECT calls FROM fixture_calls WHERE runId = ?', runId)
          .toArray()[0]?.calls ?? 0)
      : 0;
    const timing = this.ctx.storage.sql
      .exec('SELECT providerStartedAt, firstTokenAt FROM generation_timings WHERE runId = ?', runId)
      .toArray()[0];
    return { ...run, calls, timing };
  }
  fixtureContext(runId: string) {
    const run = this.ctx.storage.sql
      .exec<{ assistantId: string; context: string; config: string | null }>(
        'SELECT assistantId, context, config FROM runs WHERE id = ?',
        runId,
      )
      .one();
    const config = run.config ? JSON.parse(run.config) : null;
    if (config) {
      delete config.apiKey;
      if (config.webTools) delete config.webTools.apiKey;
    }
    return { assistantId: run.assistantId, context: JSON.parse(run.context), config };
  }
  fixtureParent(messageId: string, parentId: string) {
    this.ctx.storage.sql.exec('UPDATE messages SET parentId = ? WHERE id = ?', parentId, messageId);
  }
  fixtureReenterAlarm() {
    return this.alarm();
  }
  async fixtureActivity(retry: boolean) {
    if (retry) {
      this.ctx.storage.sql.exec('UPDATE conversation_activity SET nextAt = 0 WHERE pending = 1');
      await this.alarm();
    }
    return {
      row:
        this.ctx.storage.sql
          .exec('SELECT * FROM conversation_activity WHERE id = 1')
          .toArray()[0] ?? null,
      alarmAt: await this.ctx.storage.getAlarm(),
      ...this.fixtureResources(),
    };
  }
  fixtureRetrySearch() {
    this.ctx.storage.sql.exec('UPDATE search_retry SET nextAt = 0');
    return this.alarm();
  }
  async fixtureAbort(runId: string, stopping: boolean) {
    if (stopping)
      this.ctx.storage.sql.exec('UPDATE runs SET cancelRequested = 1 WHERE id = ?', runId);
    await this.ctx.storage.sync();
    this.ctx.abort('Intentional test reset', { retryAlarm: true });
  }
  fixtureHistory(pairs: number) {
    if (!Number.isInteger(pairs) || pairs < 1 || pairs > 16)
      throw new Error('Invalid history fixture size');
    const sql = this.ctx.storage.sql;
    if (sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM messages').one().count)
      throw new Error('Seed only an empty test conversation');
    const content = '正文🙂'.repeat(22500),
      reasoning = '思考🙂'.repeat(22500),
      input = '历史🙂'.repeat(4000);
    this.ctx.storage.transactionSync(() => {
      for (let index = 0; index < pairs; index++) {
        const userId = crypto.randomUUID(),
          runId = crypto.randomUUID();
        sql.exec(
          'INSERT INTO messages (id, role, content, status, createdAt, runId) VALUES (?, ?, ?, ?, ?, ?)',
          userId,
          'user',
          input,
          'completed',
          index * 2,
          null,
        );
        sql.exec(
          'INSERT INTO messages (id, role, content, reasoning, status, createdAt, runId, parentId, model, modelName) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          crypto.randomUUID(),
          'assistant',
          content,
          reasoning,
          'completed',
          index * 2 + 1,
          runId,
          userId,
          'history-fixture',
          'History fixture',
        );
      }
      // Simulate compacted old events, so a cursor of zero must use the full snapshot path.
      sql.exec("INSERT INTO events (seq, payload) VALUES (501, '[]')");
    });
    return {
      messages: pairs * 2,
      contentCharacters: pairs * (input.length + content.length),
      reasoningCharacters: pairs * reasoning.length,
      databaseBytes: sql.databaseSize,
    };
  }
  fixtureSearchHistory() {
    const sql = this.ctx.storage.sql;
    if (sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM messages').one().count)
      throw new Error('Seed only an empty test conversation');
    const user = crypto.randomUUID(),
      assistant = crypto.randomUUID(),
      last = crypto.randomUUID();
    const filler = Array.from(
      { length: 80 },
      (_, index) => `阅读段落 ${index + 1}，用于验证长消息中的搜索定位。`,
    ).join('\n\n');
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        'INSERT INTO messages (id, role, content, status, createdAt) VALUES (?, ?, ?, ?, ?)',
        user,
        'user',
        '用户 TARGET 与 [a+b] 😀',
        'completed',
        1,
      );
      sql.exec(
        'INSERT INTO messages (id, role, content, reasoning, status, createdAt, modelName, parentId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        assistant,
        'assistant',
        `## 章节\n\n跨越 **格式** 搜索。\n\nTARGET 起点\n\n${filler}\n\n\`\`\`js\nconst TARGET = 1;\n\`\`\`\n\n数学：\n\n$$E = mc^2$$\n\n\`\`\`mermaid\ngraph TD\n  A[输入] --> B[回答]\n\`\`\`\n\n尾部 TARGET 与 [a+b]`,
        `隐藏目标在开头\n\n${filler}\n\n末尾思考终点`,
        'completed',
        2,
        'TARGET 模型名',
        user,
      );
      sql.exec(
        'INSERT INTO messages (id, role, content, status, createdAt, parentId) VALUES (?, ?, ?, ?, ?, ?)',
        last,
        'assistant',
        '第二个回答 target，Unicode 😀 中文。',
        'completed',
        3,
        assistant,
      );
    });
    return { user, assistant, last };
  }
}
