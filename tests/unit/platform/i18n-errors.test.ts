import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import { AppError, problem, readErrorIssue } from '../../../shared/errors/descriptor';
import { generationSchema } from '../../../shared/streaming/generation';
import { validateWebToolOutcome } from '../../../shared/tools/tasks';
import { Autosave } from '../../../src/platform/autosave';
import { api } from '../../../src/platform/api';
import {
  errorMessage,
  issueMessage,
  renderUiMessage,
  uiMessage,
  UiError,
} from '../../../src/platform/i18n/messages';
import { pageI18n } from '../../../src/platform/i18n/react';

test('error descriptors reject unknown codes, extra fields, unsafe or missing parameters', () => {
  const issue = problem('CONTEXT_BUDGET_EXCEEDED', { estimatedTokens: 42000, budgetTokens: 32000 });
  assert.deepEqual(readErrorIssue(issue), issue);
  for (const invalid of [
    { code: 'UPSTREAM_INVENTED_KEY' },
    { code: 'REQUEST_FAILED', params: { apiKey: 123 } },
    { code: 'REQUEST_FAILED', secret: 'private' },
    { code: 'CONTEXT_BUDGET_EXCEEDED' },
    { code: 'OUTPUT_BUDGET_EXCEEDED', params: { limit: 'sk-secret' } },
    { code: 'OUTPUT_BUDGET_EXCEEDED', params: { limit: Infinity } },
    { code: 'OUTPUT_BUDGET_EXCEEDED', params: { limit: -1 } },
  ])
    assert.equal(readErrorIssue(invalid), undefined);
});

test('an asynchronous save retains semantic errors across language changes, including nested messages', async () => {
  const original = pageI18n.language;
  const issue = problem('CONTEXT_BUDGET_EXCEEDED', { estimatedTokens: 42000, budgetTokens: 32000 });
  const save = new Autosave(
    { value: 1 },
    async () => {
      throw new AppError(issue, 'diagnostic 原文');
    },
    () => {},
    (_saved, draft) => draft,
    60000,
  );
  try {
    await pageI18n.changeLanguage('en');
    save.update({ value: 2 });
    await assert.rejects(save.flush(), AppError);
    const savedError = save.getSnapshot().error;
    assert.match(renderUiMessage(savedError), /Input needs about 42,000 tokens/);
    await pageI18n.changeLanguage('zh-CN');
    assert.match(renderUiMessage(savedError), /超过上下文预算 32,000/);
    const nested = uiMessage('app', 'sendFailedDetail', { error: issueMessage(issue) });
    // Load a feature namespace only when the feature is used.
    await import('../../../src/app/locales');
    assert.match(renderUiMessage(nested), /超过上下文预算/);
    assert.deepEqual(errorMessage(new UiError(nested)), nested);
    assert.equal(
      renderUiMessage(errorMessage(new Error('sk-private-upstream'))).includes('sk-private'),
      false,
    );
  } finally {
    save.dispose();
    await pageI18n.changeLanguage(original);
  }
});

test('API envelopes validate semantic issues and preserve diagnostics without using them as translation keys', async () => {
  const previous = globalThis.fetch;
  const original = pageI18n.language;
  const issue = problem('PROVIDER_HTTP_ERROR', { status: 429 });
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: 'diagnostic 原文', code: 'PROVIDER_ERROR', issue }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    let caught: unknown;
    try {
      await api('/session');
    } catch (error) {
      caught = error;
    }
    await pageI18n.changeLanguage('en');
    assert.match(renderUiMessage(errorMessage(caught)), /HTTP 429/);
    await pageI18n.changeLanguage('zh-CN');
    assert.match(renderUiMessage(errorMessage(caught)), /模型供应商返回 HTTP 429/);
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: 'PRIVATE raw diagnostic',
          issue: { code: 'PROVIDER_HTTP_ERROR', params: { status: 'secret' } },
        }),
        { status: 502 },
      );
    await assert.rejects(
      api('/session'),
      (error) => !renderUiMessage(errorMessage(error)).includes('PRIVATE'),
    );
  } finally {
    globalThis.fetch = previous;
    await pageI18n.changeLanguage(original);
  }
});

test('saved generation and tool failures carry validated locale-independent issues', () => {
  const issue = problem('PROVIDER_UNAUTHORIZED');
  const generation = { usage: { inputTokens: 2 }, usageIsFinal: false, issue };
  assert.deepEqual(v.parse(generationSchema, JSON.parse(JSON.stringify(generation))).issue, issue);
  const outcome = {
    id: 'call-1',
    name: 'web_search',
    status: 'failed',
    error: 'sanitized diagnostic 原文',
    issue: problem('TOOL_TIMEOUT'),
  };
  const saved = validateWebToolOutcome(outcome);
  assert.equal(saved.status, 'failed');
  assert.ok(saved.status === 'failed');
  assert.deepEqual(saved.issue, outcome.issue);
  assert.equal(
    v.safeParse(generationSchema, { ...generation, issue: { code: 'PRIVATE_KEY' } }).success,
    false,
  );
});

function descriptorTypes() {
  // @ts-expect-error A parameterized code requires its allowlisted parameters.
  problem('OUTPUT_BUDGET_EXCEEDED');
  // @ts-expect-error Arbitrary sensitive parameters are not permitted.
  problem('PROVIDER_HTTP_ERROR', { apiKey: 'secret' });
}
void descriptorTypes;
