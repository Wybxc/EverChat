import { expect,test,type APIRequestContext } from '@playwright/test';
import type { StartToolTask } from '../../../worker/web-tools/task-journal';
import type { ToolJournalControl } from '../../support/runtime/tool-task-journal';

const headers = { Origin: 'http://127.0.0.1:5174' };
async function setup(request: APIRequestContext) {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const conversationId = crypto.randomUUID();
  expect((await request.post('/api/conversations', { headers, data: { id: conversationId, title: 'Tool journal lifecycle' } })).status()).toBe(201);
  const input: StartToolTask = { id: crypto.randomUUID(), runId: crypto.randomUUID(), messageId: crypto.randomUUID(), requestHash: 'a'.repeat(64),
    enabled: ['web_search', 'read_webpage'], inputBudget: 1_000_000, initialTokens: 1000 };
  const action = (data: ToolJournalControl) => request.post(`/api/__test/conversations/${conversationId}/tool-journal`, { headers, data });
  const control = async (data: ToolJournalControl) => {
    const response = await action(data); expect(response.ok(), await response.text()).toBe(true); return response.json();
  };
  const read = () => control({ action: 'status', id: input.id });
  const saved = async (large = false) => {
    await control({ action: 'start', input }); await control({ action: 'model', id: input.id, runId: input.runId });
    return control({ action: 'turn', id: input.id, runId: input.runId, large });
  };
  const finish = async (callId: string) => { await control({ action: 'tool', id: input.id, callId }); await control({ action: 'result', id: input.id, callId }); };
  const reset = async () => { const response = await action({ action: 'reset', id: input.id }); expect(response.status()).toBe(503); };
  const cleanup = async () => { expect((await request.delete(`/api/conversations/${conversationId}`, { headers })).ok()).toBe(true); };
  return { input, conversationId, action, control, read, saved, finish, reset, cleanup };
}

test('native DO transactions roll back task registration and deduplicate concurrent model claims', async ({ request }) => {
  const f = await setup(request);
  try {
    expect(await f.control({ action: 'start', input: f.input, rollback: true })).toEqual({ rolledBack: true, roots: 0 });
    await f.control({ action: 'start', input: f.input });
    const claims = await Promise.all([0, 1].map(() => f.control({ action: 'model', id: f.input.id, runId: f.input.runId })));
    expect(claims.map((value) => value.changed).sort()).toEqual([false, true]);
    expect((await f.read()).state).toMatchObject({ phase: 'running', modelRequests: 1 });
    await f.reset();
    expect((await f.read()).state).toMatchObject({ status: 'failed', modelRequests: 1, error: expect.stringContaining('主动重新生成') });
    expect((await f.action({ action: 'model', id: f.input.id, runId: f.input.runId })).status()).toBe(400);
  } finally { await f.cleanup(); }
});

test('native DO reset preserves a large private turn without exposing it in orchestration state or public snapshots', async ({ request }) => {
  const f = await setup(request);
  try {
    const saved = await f.saved(true);
    expect(saved.privateBytes).toBeGreaterThan(600_000); expect(saved.privatePayloads).toBe(1);
    const publicState = JSON.stringify({ state: saved.state, calls: saved.calls });
    expect(publicState.length).toBeLessThan(3000); expect(publicState).not.toContain('signature'); expect(publicState).not.toContain('private-journal');
    await f.reset();
    expect(await f.read()).toEqual({ ...saved, changed: null });
    const snapshot = await request.get(`/api/conversations/${f.conversationId}`).then((response) => response.json());
    expect(snapshot.messages).toEqual([]); expect(JSON.stringify(snapshot)).not.toContain('signature');
    await f.control({ action: 'stop', id: f.input.id });
    expect(await f.read()).toMatchObject({ privateBytes: 0, privatePayloads: 0, state: { status: 'cancelled' } });
  } finally { await f.cleanup(); }
});

test('native tool recovery retains results, does not repeat an uncertain request, and can queue the next model atomically', async ({ request }) => {
  const f = await setup(request);
  try {
    await f.saved(); await f.finish('call_0'); await f.control({ action: 'tool', id: f.input.id, callId: 'call_1' });
    await f.reset(); const recovered = await f.read();
    expect(recovered.state).toMatchObject({ status: 'active', phase: 'tools', toolRequests: 2 });
    expect(recovered.calls.map((item: { state: string }) => item.state)).toEqual(['completed', 'failed']);
    expect((await f.control({ action: 'tool', id: f.input.id, callId: 'call_1' })).changed).toBe(false);
    const next = { action: 'next', id: f.input.id, runId: crypto.randomUUID(), messageId: crypto.randomUUID() } as const;
    expect(await f.control({ ...next, rollback: true })).toEqual({ rolledBack: true, roots: 1 });
    expect((await f.read()).state.round).toBe(0);
    expect((await f.control(next)).changed).toBe(true); expect((await f.control(next)).changed).toBe(false);
    await f.reset(); expect((await f.read()).state).toMatchObject({ round: 1, phase: 'queued', modelRequests: 1, toolRequests: 2 });
    await f.control({ action: 'model', id: f.input.id, runId: next.runId });
    await f.control({ action: 'turn', id: f.input.id, runId: next.runId, final: true });
    await f.reset();
    expect((await f.control({ action: 'turn', id: f.input.id, runId: next.runId, final: true })).changed).toBe(false);
    expect(await f.read()).toMatchObject({ privatePayloads: 0, privateBytes: 0, state: { status: 'completed', modelRequests: 2 } });
    await f.control({ action: 'ack', id: f.input.id }); expect((await f.read()).nextAlarm).toBe(null);
  } finally { await f.cleanup(); }
});

for (const action of ['stop', 'expire'] as const) test(`native ${action} survives reset and refuses late results or further model requests`, async ({ request }) => {
  const f = await setup(request);
  try {
    await f.saved(); await f.control({ action: 'tool', id: f.input.id, callId: 'call_0' }); await f.control({ action, id: f.input.id });
    await f.reset();
    expect((await f.control({ action: 'result', id: f.input.id, callId: 'call_0' })).changed).toBe(false);
    expect(await f.read()).toMatchObject({ privatePayloads: 0, state: { status: action === 'stop' ? 'cancelled' : 'failed', toolRequests: 1, modelRequests: 1 } });
    expect((await f.action({ action: 'next', id: f.input.id, runId: crypto.randomUUID(), messageId: crypto.randomUUID() })).status()).toBe(400);
  } finally { await f.cleanup(); }
});
