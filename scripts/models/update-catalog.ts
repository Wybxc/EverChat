import { readFile, writeFile } from 'node:fs/promises';
import { parseModelCatalog } from '../../shared/models/catalog';

const input = process.argv[2];
const raw: unknown = input
  ? JSON.parse(await readFile(input, 'utf8'))
  : await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(30_000) }).then(
      (response) => {
        if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`);
        return response.json();
      },
    );
const catalog = parseModelCatalog(raw);
const count = Object.values(catalog).reduce(
  (total, models) => total + Object.keys(models).length,
  0,
);
if (!count) throw new Error('模型目录为空，未更新快照。');
await writeFile(
  new URL('../../shared/models/generated/catalog.ts', import.meta.url),
  `import type { ModelCatalog } from '../catalog';\n// Generated from https://models.dev/api.json on ${new Date().toISOString().slice(0, 10)}.\n// Public metadata only; update with pnpm update:model-catalog.\nexport const MODEL_CATALOG_SNAPSHOT: ModelCatalog = ${JSON.stringify(catalog, null, 2)};\n`,
);
console.log(`已更新 ${count} 个模型的能力快照。`);
