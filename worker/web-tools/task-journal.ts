import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { estimateTextTokens } from '../../shared/conversation/token-estimate';
import type { ProviderConfig } from '../../shared/providers/types';
import { assertWebToolSupport,MAX_TOOL_EXCHANGES,validateWebToolOutcome,type PublicToolTask,type WebToolCall,type WebToolName,type WebToolOutcome } from '../../shared/web-tools/tasks';
import type { SqlQuery } from '../generation/metrics';
import { providerToolIdentity,providerToolPrompt,validateProviderToolTurn,type ProviderToolExchange,type ProviderToolTurn } from '../providers/tool-turn';

export const TOOL_TASK_TIMEOUT_MS = 10 * 60_000;
export const MAX_TOOL_TASKS = 256;
export const TOOL_DEFINITION_TOKENS = 2048;
type Terminal = 'completed' | 'failed' | 'cancelled';
type Root = { id: string; requestHash: string; identity: string; enabled: string; status: 'active' | Terminal; round: number;
  createdAt: number; deadline: number; inputBudget: number; initialTokens: number; modelRequests: number; toolRequests: number;
  textCharacters: number; reasoningCharacters: number; error: string | null } & Record<string, SqlStorageValue>;
type Model = { runId: string; rootId: string; round: number; messageId: string; phase: 'queued' | 'running' | 'tools' | Terminal;
  turn: string | null; turnHash: string | null; plannedTokens: number } & Record<string, SqlStorageValue>;
type Call = { rootId: string; runId: string; ordinal: number; callId: string; payload: string; state: 'queued' | 'running' | Terminal;
  outcome: string | null } & Record<string, SqlStorageValue>;
export interface ToolTaskState {
  id: string; status: Root['status']; round: number; deadline: number; modelRequests: number; toolRequests: number;
  runId: string; messageId: string; phase: Model['phase']; calls: string[]; error: string | null;
}
interface ToolCallView { call: WebToolCall; state: Call['state']; result?: WebToolOutcome }
interface ToolNotification { rootId: string; round: number; nextAt: number; expires: number; attempts: number }
export interface StartToolTask { id: string; runId: string; messageId: string; requestHash: string; enabled: readonly WebToolName[]; inputBudget: number; initialTokens: number }
const uuid = v.pipe(v.string(), v.uuid());
const serialized = (value: unknown) => JSON.stringify(value);
const errorText = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 500) || '工具任务已停止。';
const taskError = (message: string): never => { throw new Error(message); };

/** All mutations run inside the caller's storage transaction, together with its messages and Alarm. */
export class ToolTaskJournal {
  constructor(private readonly query: SqlQuery, private readonly now: () => number = Date.now) {
    query(`CREATE TABLE IF NOT EXISTS web_tool_tasks (
      id TEXT PRIMARY KEY, requestHash TEXT NOT NULL, identity TEXT NOT NULL, enabled TEXT NOT NULL,
      status TEXT NOT NULL, round INTEGER NOT NULL, createdAt INTEGER NOT NULL, deadline INTEGER NOT NULL,
      inputBudget INTEGER NOT NULL, initialTokens INTEGER NOT NULL, modelRequests INTEGER NOT NULL, toolRequests INTEGER NOT NULL,
      textCharacters INTEGER NOT NULL, reasoningCharacters INTEGER NOT NULL, error TEXT)`);
    query(`CREATE TABLE IF NOT EXISTS web_tool_models (
      runId TEXT PRIMARY KEY, rootId TEXT NOT NULL, round INTEGER NOT NULL, messageId TEXT NOT NULL,
      phase TEXT NOT NULL, turn TEXT, turnHash TEXT, plannedTokens INTEGER NOT NULL, UNIQUE(rootId, round))`);
    query(`CREATE TABLE IF NOT EXISTS web_tool_calls (
      rootId TEXT NOT NULL, runId TEXT NOT NULL, ordinal INTEGER NOT NULL, callId TEXT NOT NULL, payload TEXT NOT NULL,
      state TEXT NOT NULL, outcome TEXT, PRIMARY KEY(rootId, callId), UNIQUE(runId, ordinal)) WITHOUT ROWID`);
    query(`CREATE TABLE IF NOT EXISTS web_tool_notifications (
      rootId TEXT NOT NULL, round INTEGER NOT NULL, nextAt INTEGER NOT NULL, expires INTEGER NOT NULL,
      attempts INTEGER NOT NULL, PRIMARY KEY(rootId, round)) WITHOUT ROWID`);
    query('CREATE INDEX IF NOT EXISTS web_tool_tasks_status ON web_tool_tasks(status, deadline)');
    query('CREATE INDEX IF NOT EXISTS web_tool_models_root ON web_tool_models(rootId, round)');
    query('CREATE INDEX IF NOT EXISTS web_tool_calls_run ON web_tool_calls(runId, ordinal)');
  }
  private root(id: string): Root { return this.query<Root>('SELECT * FROM web_tool_tasks WHERE id = ?', id).toArray()[0] ?? taskError('找不到工具任务。'); }
  model(runId: string): Model | undefined { return this.query<Model>('SELECT * FROM web_tool_models WHERE runId = ?', runId).toArray()[0]; }
  modelAt(rootId: string, round: number): Model | undefined { return this.query<Model>('SELECT * FROM web_tool_models WHERE rootId = ? AND round = ?', rootId, round).toArray()[0]; }
  enabled(rootId: string): WebToolName[] { return JSON.parse(this.root(rootId).enabled); }
  publicTask(rootId: string): PublicToolTask {
    const root = this.root(rootId);
    return { status: root.status, round: root.round, calls: this.query<{ runId: string; round: number }>('SELECT runId, round FROM web_tool_models WHERE rootId = ? ORDER BY round', rootId).toArray()
      .flatMap((model) => this.publicCalls(model.runId).map((call) => ({ round: model.round, ...call }))) };
  }
  erase(rootId: string) {
    const root = this.query<Root>('SELECT * FROM web_tool_tasks WHERE id = ?', rootId).toArray()[0];
    if (root?.status === 'active') taskError('请先停止工具任务。');
    this.query('DELETE FROM web_tool_notifications WHERE rootId = ?', rootId);
    this.query('DELETE FROM web_tool_calls WHERE rootId = ?', rootId);
    this.query('DELETE FROM web_tool_models WHERE rootId = ?', rootId);
    this.query('DELETE FROM web_tool_tasks WHERE id = ?', rootId);
  }
  private calls(runId: string) { return this.query<Call>('SELECT * FROM web_tool_calls WHERE runId = ? ORDER BY ordinal', runId).toArray(); }
  private current(root: Root): Model { return this.query<Model>('SELECT * FROM web_tool_models WHERE rootId = ? AND round = ?', root.id, root.round).toArray()[0] ?? taskError('工具轮次不存在。'); }
  private active(root: Root) {
    if (root.status !== 'active') taskError('工具任务已停止。');
    if (root.deadline <= this.now()) taskError('工具任务超过等待期限。');
  }
  state(id: string): ToolTaskState {
    const root = this.root(id), model = this.query<Model>('SELECT runId, messageId, phase FROM web_tool_models WHERE rootId = ? AND round = ?', id, root.round).one();
    return { id, status: root.status, round: root.round, deadline: root.deadline, modelRequests: root.modelRequests, toolRequests: root.toolRequests,
      runId: model.runId, messageId: model.messageId, phase: model.phase, calls: this.calls(model.runId).map((call) => call.callId), error: root.error };
  }
  create(input: StartToolTask, config: ProviderConfig): ToolTaskState {
    if (![input.id, input.runId, input.messageId].every((id) => v.is(uuid, id)) || !/^[0-9a-f]{64}$/.test(input.requestHash)) taskError('工具任务标识无效。');
    assertWebToolSupport(config.modelMetadata, input.enabled);
    const existing = this.query<Root>('SELECT * FROM web_tool_tasks WHERE id = ?', input.id).toArray()[0];
    if (existing) {
      const first = this.query<Model>('SELECT * FROM web_tool_models WHERE rootId = ? AND round = 0', input.id).one();
      if (existing.requestHash !== input.requestHash || existing.identity !== providerToolIdentity(config) || existing.enabled !== serialized(input.enabled)
        || first.runId !== input.runId || first.messageId !== input.messageId || existing.inputBudget !== input.inputBudget || existing.initialTokens !== input.initialTokens) taskError('此工具任务 ID 已用于另一项请求。');
      return this.state(input.id);
    }
    if (!Number.isSafeInteger(input.inputBudget) || input.inputBudget < 1 || input.inputBudget > 10_000_000
      || !Number.isSafeInteger(input.initialTokens) || input.initialTokens < 0 || input.initialTokens + TOOL_DEFINITION_TOKENS > input.inputBudget) taskError('上下文没有足够的工具调用预算。');
    if (this.query('SELECT id FROM web_tool_tasks WHERE status = ? LIMIT 1', 'active').toArray().length) taskError('这个对话已有工具任务。');
    if (this.query<{ count: number }>('SELECT COUNT(*) AS count FROM web_tool_tasks').one().count >= MAX_TOOL_TASKS) taskError('此对话的工具任务数量已达上限。');
    const now = this.now();
    this.query("INSERT INTO web_tool_tasks VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, 0, 0, 0, 0, NULL)", input.id, input.requestHash,
      providerToolIdentity(config), serialized(input.enabled), now, now + TOOL_TASK_TIMEOUT_MS, input.inputBudget, input.initialTokens);
    this.query("INSERT INTO web_tool_models VALUES (?, ?, 0, ?, 'queued', NULL, NULL, ?)", input.runId, input.id, input.messageId, input.initialTokens + TOOL_DEFINITION_TOKENS);
    return this.state(input.id);
  }
  claimModel(runId: string): boolean {
    const model = this.model(runId) ?? taskError('模型步骤不存在。'), root = this.root(model.rootId);
    this.active(root);
    if (model.phase !== 'queued') return false;
    if (model.round !== root.round || root.modelRequests >= MAX_TOOL_EXCHANGES + 1) taskError('模型步骤或请求预算无效。');
    this.query("UPDATE web_tool_models SET phase = 'running' WHERE runId = ?", runId);
    this.query('UPDATE web_tool_tasks SET modelRequests = modelRequests + 1 WHERE id = ?', root.id);
    return true;
  }
  saveTurn(runId: string, turn: ProviderToolTurn, config: ProviderConfig): boolean {
    const model = this.model(runId) ?? taskError('模型步骤不存在。'), root = this.root(model.rootId), payload = serialized(turn);
    const digest = createHash('sha256').update(payload).digest('hex');
    if (model.turnHash !== null) { if (model.turnHash === digest) return false; taskError('同一模型步骤返回了不同结果。'); }
    if (root.status !== 'active') return false;
    this.active(root);
    if (model.phase !== 'running' || model.round !== root.round || root.identity !== providerToolIdentity(config)) taskError('模型步骤未认领或供应商身份变化。');
    validateProviderToolTurn(turn, JSON.parse(root.enabled), config);
    let text = 0, reasoning = 0;
    for (const part of turn.content) { if (part.type === 'text') text += part.text.length; if (part.type === 'reasoning') reasoning += part.text.length; }
    if (root.textCharacters + text > 100_000 || root.reasoningCharacters + reasoning > 100_000) taskError('工具任务的正文或思考总量超过限制。');
    for (const call of turn.calls) if (this.query('SELECT callId FROM web_tool_calls WHERE rootId = ? AND callId = ?', root.id, call.id).toArray().length) taskError('工具任务重复使用了调用 ID。');
    this.query('UPDATE web_tool_models SET phase = ?, turn = ?, turnHash = ? WHERE runId = ?', turn.calls.length ? 'tools' : 'completed', payload, digest, runId);
    this.query('UPDATE web_tool_tasks SET textCharacters = textCharacters + ?, reasoningCharacters = reasoningCharacters + ? WHERE id = ?', text, reasoning, root.id);
    turn.calls.forEach((call, ordinal) => this.query("INSERT INTO web_tool_calls VALUES (?, ?, ?, ?, ?, 'queued', NULL)", root.id, runId, ordinal, call.id, serialized(call)));
    this.notify(root, model.round);
    if (!turn.calls.length) this.stop(root.id, 'completed');
    else if (model.round >= MAX_TOOL_EXCHANGES) this.stop(root.id, 'failed', '工具轮数已达上限，未执行后续调用。');
    return true;
  }
  claimTool(rootId: string, callId: string): boolean {
    const root = this.root(rootId); this.active(root);
    const call = this.query<Call>('SELECT * FROM web_tool_calls WHERE rootId = ? AND callId = ?', rootId, callId).toArray()[0] ?? taskError('工具调用不存在。');
    if (call.state !== 'queued') return false;
    const model = this.model(call.runId)!;
    if (model.phase !== 'tools' || model.round !== root.round || root.toolRequests >= 2 * MAX_TOOL_EXCHANGES) taskError('工具步骤或请求预算无效。');
    this.query("UPDATE web_tool_calls SET state = 'running' WHERE rootId = ? AND callId = ?", rootId, callId);
    this.query('UPDATE web_tool_tasks SET toolRequests = toolRequests + 1 WHERE id = ?', rootId);
    return true;
  }
  finishTool(rootId: string, callId: string, value: WebToolOutcome): boolean {
    const root = this.root(rootId), call = this.query<Call>('SELECT * FROM web_tool_calls WHERE rootId = ? AND callId = ?', rootId, callId).toArray()[0] ?? taskError('工具调用不存在。');
    const result = validateWebToolOutcome(value), original = JSON.parse(call.payload) as WebToolCall, payload = serialized(result);
    if (result.id !== callId || result.name !== original.name) taskError('工具结果与原调用不符。');
    if (root.status !== 'active' || root.deadline <= this.now()) return false;
    if (call.outcome !== null) { if (call.outcome === payload) return false; taskError('工具结果已保存，不能覆盖。'); }
    if (call.state !== 'running') taskError('工具调用尚未认领。');
    this.query('UPDATE web_tool_calls SET state = ?, outcome = ? WHERE rootId = ? AND callId = ?', result.status, payload, rootId, callId);
    return true;
  }
  exchanges(rootId: string, throughRound: number, config: ProviderConfig): ProviderToolExchange[] {
    const root = this.root(rootId); this.active(root);
    if (root.identity !== providerToolIdentity(config) || !Number.isInteger(throughRound) || throughRound < 0 || throughRound > MAX_TOOL_EXCHANGES) taskError('工具续接轮次或供应商无效。');
    const models = this.query<Model>('SELECT * FROM web_tool_models WHERE rootId = ? AND round < ? ORDER BY round', rootId, throughRound).toArray();
    if (models.length !== throughRound) taskError('工具续接缺少前一步。');
    const exchanges = models.map((model, round) => {
      if (model.round !== round || model.turn === null) taskError('工具续接资料不存在。');
      const turn = JSON.parse(model.turn!) as ProviderToolTurn;
      validateProviderToolTurn(turn, JSON.parse(root.enabled), config);
      const calls = this.calls(model.runId);
      if (turn.finishReason !== 'tool-calls' || calls.length !== turn.calls.length || calls.some((call) => call.outcome === null || !['completed', 'failed'].includes(call.state))) taskError('工具结果尚未完整保存。');
      return { turn, outcomes: calls.map((call) => validateWebToolOutcome(JSON.parse(call.outcome!))) };
    });
    providerToolPrompt(exchanges, JSON.parse(root.enabled), config);
    return exchanges;
  }
  queueModel(rootId: string, round: number, runId: string, messageId: string, config: ProviderConfig): boolean {
    const root = this.root(rootId);
    if (!v.is(uuid, runId) || !v.is(uuid, messageId) || !Number.isInteger(round) || round < 1 || round > MAX_TOOL_EXCHANGES) taskError('下一模型步骤标识无效。');
    const existing = this.query<Model>('SELECT * FROM web_tool_models WHERE rootId = ? AND round = ?', rootId, round).toArray()[0];
    if (existing) { if (existing.runId === runId && existing.messageId === messageId) return false; taskError('模型轮次已绑定其他步骤。'); }
    this.active(root);
    if (round !== root.round + 1 || this.current(root).phase !== 'tools') taskError('不能跳过或重新开始模型轮次。');
    const exchanges = this.exchanges(rootId, round, config);
    const planned = root.initialTokens + TOOL_DEFINITION_TOKENS + exchanges.reduce((sum, exchange) => sum + estimateTextTokens(serialized(exchange.turn.content)) + estimateTextTokens(serialized(exchange.outcomes)) + 32, 0);
    if (planned > root.inputBudget) taskError('工具结果超过模型上下文预算，未调用下一步。');
    this.query("UPDATE web_tool_models SET phase = 'completed' WHERE rootId = ? AND round = ?", rootId, root.round);
    this.query("INSERT INTO web_tool_models VALUES (?, ?, ?, ?, 'queued', NULL, NULL, ?)", runId, rootId, round, messageId, planned);
    this.query('UPDATE web_tool_tasks SET round = ? WHERE id = ?', round, rootId);
    return true;
  }
  publicCalls(runId: string): ToolCallView[] {
    return this.calls(runId).map((row) => ({ call: JSON.parse(row.payload), state: row.state,
      ...(row.outcome !== null ? { result: JSON.parse(row.outcome) } : {}) }));
  }
  stop(id: string, status: Terminal, error?: string): boolean {
    const root = this.root(id); if (root.status !== 'active') return false;
    if (status === 'completed' && this.current(root).phase !== 'completed') taskError('模型尚未返回最终回答。');
    this.query('UPDATE web_tool_tasks SET status = ?, error = ? WHERE id = ?', status, error ? errorText(error) : null, id);
    this.query("UPDATE web_tool_models SET phase = ? WHERE rootId = ? AND phase IN ('queued', 'running', 'tools')", status, id);
    for (const call of this.query<Call>("SELECT * FROM web_tool_calls WHERE rootId = ? AND state IN ('queued', 'running')", id).toArray()) {
      const original = JSON.parse(call.payload) as WebToolCall;
      this.query('UPDATE web_tool_calls SET state = ?, outcome = ? WHERE rootId = ? AND callId = ?', status === 'cancelled' ? 'cancelled' : 'failed',
        status === 'cancelled' ? null : serialized({ id: original.id, name: original.name, status: 'failed', error: errorText(error ?? '工具任务已停止。') }), id, call.callId);
    }
    // Private signed reasoning is needed only while this root is active.
    this.query('UPDATE web_tool_models SET turn = NULL WHERE rootId = ?', id);
    this.notify(root, root.round);
    return true;
  }
  recover() {
    this.expire();
    for (const model of this.query<Model>("SELECT web_tool_models.* FROM web_tool_models JOIN web_tool_tasks ON web_tool_tasks.id = rootId WHERE status = 'active' AND phase = 'running'").toArray()) {
      this.stop(model.rootId, 'failed', '后台模型调用被中断。为避免重复计费，请主动重新生成。');
    }
    for (const call of this.query<Call>("SELECT web_tool_calls.* FROM web_tool_calls JOIN web_tool_tasks ON web_tool_tasks.id = rootId WHERE status = 'active' AND state = 'running'").toArray()) {
      const original = JSON.parse(call.payload) as WebToolCall;
      this.finishTool(call.rootId, call.callId, { id: original.id, name: original.name, status: 'failed', error: '工具执行被中断，未自动重复请求。' });
    }
  }
  expire() {
    for (const root of this.query<Root>("SELECT * FROM web_tool_tasks WHERE status = 'active' AND deadline <= ?", this.now()).toArray()) this.stop(root.id, 'failed', '工具任务超过 10 分钟期限，未启动后续步骤。');
    this.query('DELETE FROM web_tool_notifications WHERE expires <= ?', this.now());
  }
  private notify(root: Root, round: number) {
    this.query('INSERT INTO web_tool_notifications VALUES (?, ?, ?, ?, 0) ON CONFLICT(rootId, round) DO NOTHING', root.id, round, this.now(), root.deadline + 60_000);
  }
  notifications(): ToolNotification[] {
    return this.query<ToolNotification & Record<string, SqlStorageValue>>('SELECT * FROM web_tool_notifications WHERE nextAt <= ? AND expires > ? ORDER BY nextAt LIMIT 4', this.now(), this.now()).toArray();
  }
  acknowledge(rootId: string, round: number) { this.query('DELETE FROM web_tool_notifications WHERE rootId = ? AND round = ?', rootId, round); }
  deferNotification(rootId: string, round: number) {
    const row = this.query<ToolNotification & Record<string, SqlStorageValue>>('SELECT * FROM web_tool_notifications WHERE rootId = ? AND round = ?', rootId, round).toArray()[0];
    if (row) this.query('UPDATE web_tool_notifications SET attempts = attempts + 1, nextAt = ? WHERE rootId = ? AND round = ?', this.now() + Math.min(30_000, 5000 * 2 ** Math.min(row.attempts, 3)), rootId, round);
  }
  nextAlarm(): number | null {
    const roots = this.query<{ next: number | null }>("SELECT MIN(deadline) AS next FROM web_tool_tasks WHERE status = 'active'").one().next;
    const notifications = this.query<{ next: number | null }>('SELECT MIN(MIN(nextAt, expires)) AS next FROM web_tool_notifications').one().next;
    const times = [roots, notifications].filter((value): value is number => value !== null);
    return times.length ? Math.min(...times) : null;
  }
}
