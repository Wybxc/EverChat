import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogPrice, parsePriceCatalog } from '../../../shared/usage/catalog';
import { estimateCost } from '../../../shared/usage/pricing';

test('directory defaults match exact endpoint and model, retain free and unknown rates, and reject unsafe numbers', () => {
  const catalog = parsePriceCatalog({
    deepseek: {
      api: 'https://api.deepseek.com',
      models: {
        model: { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
        free: { cost: { input: 0, output: 0 } },
        unknown: { cost: {} },
        invalid: { cost: { input: -1, output: Infinity, cache_read: 1e-9 } },
        image: { cost: { input: 1 }, modalities: { output: ['image'] } },
      },
    },
    gateway: {
      api: 'https://gateway.test/v1',
      models: { model: { cost: { input: 2, output: 8 } } },
    },
    anthropic: {
      models: { claude: { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } },
    },
  });
  const price = catalogPrice('instance', 'model', 'https://api.deepseek.com/v1/', catalog)!;
  assert.equal(price.input, '0.15');
  assert.equal(price.currency, 'USD');
  assert.equal(price.cacheRead, '0.003');
  assert.equal(price.cacheWrite, null);
  assert.equal(price.providerId, 'instance');
  assert.equal(catalogPrice('instance', 'model-extra', 'https://api.deepseek.com', catalog), null);
  assert.equal(catalogPrice('instance', 'model', 'https://other.test/v1', catalog), null);
  assert.equal(
    catalogPrice('instance', 'model', 'https://api.deepseek.com.attacker.test', catalog),
    null,
  );
  assert.equal(catalogPrice('instance', 'model', 'https://gateway.test/v1', catalog)?.input, '2');
  assert.equal(catalogPrice('other', 'free', 'https://api.deepseek.com', catalog)?.output, '0');
  for (const model of ['invalid', 'unknown', 'image', '__proto__'])
    assert.equal(catalogPrice('instance', model, 'https://api.deepseek.com', catalog), null);
  assert.equal(
    catalogPrice('instance', 'claude', 'https://api.anthropic.com/v1', catalog)?.cacheWrite,
    '3.75',
  );
});

test('bundled DeepSeek defaults produce a priced estimate without changing manually configured or historical rates', () => {
  const price = catalogPrice('deepseek', 'deepseek-flash', 'https://api.deepseek.com/')!;
  assert.ok(price);
  assert.equal(price.source.startsWith('models.dev'), true);
  const usage = { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 100 };
  assert.equal(estimateCost(usage, true, price, 'chat').state, 'priced');
  assert.notEqual(estimateCost(usage, true, price, 'chat').amount, '0');
});

test('separate reasoning rates split output subsets rather than charging reasoning twice', () => {
  const price = catalogPrice('deepseek', 'deepseek-flash', 'https://api.deepseek.com/')!;
  const rates = { ...price, input: '1', output: '2', reasoning: '4', cacheRead: null };
  assert.equal(
    estimateCost({ inputTokens: 0, outputTokens: 100, reasoningTokens: 25 }, true, rates, 'chat')
      .amount,
    '250000000',
  );
  assert.equal(
    estimateCost({ inputTokens: 0, outputTokens: 100 }, true, rates, 'chat').state,
    'partial',
  );
});
