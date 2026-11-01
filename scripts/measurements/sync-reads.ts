// Synthetic local workerd experiments; no production bindings or credentials.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { createTestHarness } from 'wrangler';
import type { ReadLibrary, ReadConversation } from './support/sync-reads-worker';
import type { ToolResourceWindow } from './support/resources';

const { values } = parseArgs({ options: { output: { type: 'string' } } });
const startedAt = new Date().toISOString();
function sql(window: ToolResourceWindow | null) {
  assert.ok(window);
  return Object.values(window.sql).reduce(
    (sum, next) => ({
      statements: sum.statements + next.statements,
      rowsRead: sum.rowsRead + next.rowsRead,
      rowsWritten: sum.rowsWritten + next.rowsWritten,
    }),
    { statements: 0, rowsRead: 0, rowsWritten: 0 },
  );
}
async function pollingFocus() {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const fakeWindow = new EventTarget();
  const document = { visibilityState: 'visible', hasFocus: () => true };
  Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  const { QueryClient, QueryObserver, focusManager } = await import('@tanstack/react-query');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.mount();
  let calls = 0;
  let fail = false;
  const observer = new QueryObserver(client, {
    queryKey: ['synthetic-library'],
    queryFn: async () => {
      calls++;
      if (fail) throw new Error('Synthetic quota failure');
      return calls;
    },
    initialData: 0,
    refetchInterval: 40,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    const focusedStart = calls;
    await pause(240);
    const focused = calls - focusedStart;
    document.hasFocus = () => false;
    fakeWindow.dispatchEvent(new Event('blur'));
    const blurredStart = calls;
    await pause(240);
    const blurred = calls - blurredStart;
    document.visibilityState = 'hidden';
    fakeWindow.dispatchEvent(new Event('visibilitychange'));
    const hiddenStart = calls;
    await pause(240);
    const hidden = calls - hiddenStart;
    fail = true;
    document.visibilityState = 'visible';
    fakeWindow.dispatchEvent(new Event('visibilitychange'));
    const failedStart = calls;
    await pause(240);
    const failedVisible = calls - failedStart;
    assert.ok(focused > 0 && blurred > 0);
    assert.equal(hidden, 0);
    assert.ok(failedVisible > 1, 'Interval polling continues after failures even with retry:false');
    return {
      intervalMs: 40,
      phaseMs: 240,
      focused,
      blurred,
      hidden,
      failedVisible,
      simulatedDocument: true,
    };
  } finally {
    unsubscribe();
    client.unmount();
    client.clear();
    focusManager.setFocused(undefined);
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
}

const harness = createTestHarness({
  workers: [
    {
      config: {
        name: 'sync-reads-local',
        main: resolve('scripts/measurements/support/sync-reads-worker.ts'),
        compatibility_date: '2026-10-09',
        compatibility_flags: ['nodejs_compat'],
        durable_objects: {
          bindings: [
            { name: 'LIBRARY', class_name: 'ReadLibrary' },
            { name: 'CONVERSATIONS', class_name: 'ReadConversation' },
          ],
        },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['ReadLibrary', 'ReadConversation'] }],
      },
    },
  ],
});
let result: Record<string, unknown> | undefined;
try {
  await harness.listen();
  const env = (await harness.getWorker('sync-reads-local').getEnv()) as {
    LIBRARY: DurableObjectNamespace<ReadLibrary>;
    CONVERSATIONS: DurableObjectNamespace<ReadConversation>;
  };
  const libraries = [];
  for (const count of [0, 10, 225, 1000]) {
    let stub = env.LIBRARY.getByName(`library-${count}`);
    await stub.seed(count);
    const warm = await stub.snapshots(30);
    const before = await stub.counters();
    await stub.evict().catch(() => {});
    stub = env.LIBRARY.getByName(`library-${count}`);
    const cold = await stub.counters();
    assert.notEqual(
      cold?.instanceId,
      before?.instanceId,
      'Cold experiment must reconstruct the DO',
    );
    const afterCold = await stub.snapshots(1);
    assert.equal(afterCold.returned, count);
    const controlHandshakes = sql(await stub.controlHandshakes(30));
    const accessChecks = sql(await stub.accessChecks(30));
    await stub.prepareCandidates();
    const unchanged = await stub.unchangedChecks(30);
    const cached = await stub.persistedSnapshots(30);
    assert.equal(cached.returned, count);
    assert.equal(sql(unchanged).rowsRead, 30);
    assert.equal(sql(cached.counters).rowsRead, 30);
    const changed = count ? await stub.candidateChange() : null;
    if (changed) assert.ok(changed.changed && changed.revision === 2);
    libraries.push({
      conversations: count,
      warm: sql(warm.counters),
      calls: warm.calls,
      coldConstructor: sql(cold),
      coldSnapshot: sql(afterCold.counters),
      controlHandshakes,
      accessChecks,
      revisionChecks: sql(unchanged),
      persistedSnapshots: sql(cached.counters),
      changed: changed && sql(changed.counters),
    });
  }
  const conversations = [];
  for (const count of [0, 20, 200, 1000]) {
    let stub = env.CONVERSATIONS.getByName(`conversation-${count}`);
    await stub.seed(count);
    const before = await stub.counters();
    await stub.evict().catch(() => {});
    stub = env.CONVERSATIONS.getByName(`conversation-${count}`);
    const cold = await stub.counters();
    assert.notEqual(cold?.instanceId, before?.instanceId);
    const coldStatements = await stub.constructorStatements();
    const unindexedPlan = await stub.pendingQueryPlan();
    const session = await stub.controlMessages(60, 'session-check');
    const sync = await stub.controlMessages(60, 'sync-check');
    const handshakes = sql(await stub.handshakes(30));
    assert.equal(sql(session.counters).rowsRead, 0);
    assert.equal(sql(sync.counters).rowsRead, 60);
    const pendingIndexEquivalence = await stub.indexPendingMessages();
    assert.deepEqual(pendingIndexEquivalence.after, pendingIndexEquivalence.before);
    assert.equal(pendingIndexEquivalence.after.length, count ? 2 : 0);
    const indexedPlan = await stub.pendingQueryPlan();
    assert.ok(indexedPlan.some((line) => String(line).includes('USING INDEX sync_probe_pending')));
    const beforeIndexed = await stub.counters();
    await stub.evict().catch(() => {});
    stub = env.CONVERSATIONS.getByName(`conversation-${count}`);
    const indexedCold = await stub.counters();
    assert.notEqual(indexedCold?.instanceId, beforeIndexed?.instanceId);
    const pendingAlreadyIndexed = unindexedPlan.some((line) =>
      String(line).includes('USING INDEX messages_pending'),
    );
    if (pendingAlreadyIndexed) assert.ok(sql(cold).rowsRead <= 120);
    else if (count >= 200) assert.ok(sql(indexedCold).rowsRead < sql(cold).rowsRead);
    conversations.push({
      messages: count,
      pendingAlreadyIndexed,
      coldConstructor: sql(cold),
      coldStatements,
      pendingIndexEquivalence,
      unindexedPlan,
      indexedPlan,
      indexedColdConstructor: sql(indexedCold),
      session: sql(session.counters),
      sync: sql(sync.counters),
      handshakes,
    });
  }
  const polling = await pollingFocus();
  // RPC arrays can retain runtime-backed proxies. Materialize them before close;
  // only publish a complete report after the local runtime has shut down.
  result = JSON.parse(
    JSON.stringify({
      version: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      runtime: 'local-workerd',
      scope:
        'Synthetic rows in ephemeral local SQLite DOs. Native SQL cursor counters, not production billing or CPU. Forced eviction is not a platform hibernation timing measurement. Additional revision/cache/index candidates exist only in this fixture; pendingAlreadyIndexed identifies the application index. Upgrade counters use real internal DO handlers and native socket pairs, excluding Worker JWT validation, routing and network. Legacy control-message counters use a synthetic socket; network ping auto-response is not measured.',
      libraries,
      conversations,
      polling,
    }),
  ) as Record<string, unknown>;
} finally {
  await harness.close();
}
assert.ok(result);
result.complete = true;
if (values.output) await writeFile(resolve(values.output), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
