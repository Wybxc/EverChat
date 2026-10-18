import * as v from 'valibot';
import {
  DEFAULT_WEB_TOOL_DAILY_LIMIT,
  webToolServiceInputSchema,
  type WebToolServiceConfig,
  type WebToolServiceSettings,
} from '../../shared/web-tools/service';
import type { SqlQuery } from '../generation/metrics';

type Configuration = {
  provider: WebToolServiceConfig['provider'];
  apiKey: string;
  dailyLimit: number;
} & Record<string, SqlStorageValue>;
export const WEB_TOOL_QUOTA_ERROR = '联网工具已达到每日请求上限，未启动后续步骤。';

// All mutations run in the owning Library transaction. The bounded UTC ledger
// charges before external I/O and retains uncertain/failed attempts.
export class WebToolSettings {
  constructor(
    private readonly query: SqlQuery,
    private readonly now = Date.now,
  ) {
    query(
      'CREATE TABLE IF NOT EXISTS web_tool_service (id INTEGER PRIMARY KEY CHECK (id = 1), apiKey TEXT NOT NULL, dailyLimit INTEGER NOT NULL)',
    );
    query(
      'CREATE TABLE IF NOT EXISTS web_tool_credentials (provider TEXT PRIMARY KEY, apiKey TEXT NOT NULL)',
    );
    if (
      !query<{ name: string }>('PRAGMA table_info(web_tool_service)')
        .toArray()
        .some((column) => column.name === 'provider')
    ) {
      query("ALTER TABLE web_tool_service ADD COLUMN provider TEXT NOT NULL DEFAULT 'tavily'");
      query(
        "INSERT OR IGNORE INTO web_tool_credentials SELECT 'tavily', apiKey FROM web_tool_service WHERE id = 1",
      );
      query("UPDATE web_tool_service SET apiKey = ''");
    }
    query('CREATE TABLE IF NOT EXISTS web_tool_requests (id TEXT PRIMARY KEY, day TEXT NOT NULL)');
    query('CREATE INDEX IF NOT EXISTS web_tool_requests_day ON web_tool_requests(day)');
  }
  private configuration(): Configuration {
    const active = this.query<{ provider: WebToolServiceConfig['provider']; dailyLimit: number }>(
      'SELECT provider, dailyLimit FROM web_tool_service WHERE id = 1',
    ).toArray()[0] ?? { provider: 'tavily' as const, dailyLimit: DEFAULT_WEB_TOOL_DAILY_LIMIT };
    return { ...active, apiKey: this.key(active.provider) };
  }
  private day(offset = 0) {
    return new Date(this.now() + offset).toISOString().slice(0, 10);
  }
  settings(): WebToolServiceSettings {
    const config = this.configuration();
    return {
      provider: config.provider,
      hasApiKey: Boolean(config.apiKey),
      dailyLimit: config.dailyLimit,
      usedToday: this.query<{ count: number }>(
        'SELECT COUNT(*) AS count FROM web_tool_requests WHERE day = ?',
        this.day(),
      ).one().count,
    };
  }
  config(): WebToolServiceConfig | undefined {
    const config = this.configuration();
    return config.apiKey ? config : undefined;
  }
  key(provider?: WebToolServiceConfig['provider']) {
    const active =
      provider ??
      this.query<{ provider: WebToolServiceConfig['provider'] }>(
        'SELECT provider FROM web_tool_service WHERE id = 1',
      ).toArray()[0]?.provider ??
      'tavily';
    return (
      this.query<{ apiKey: string }>(
        'SELECT apiKey FROM web_tool_credentials WHERE provider = ?',
        active,
      ).toArray()[0]?.apiKey ?? ''
    );
  }
  save(value: unknown) {
    const parsed = v.safeParse(webToolServiceInputSchema, value);
    if (!parsed.success) throw new Error('联网工具设置无效。');
    const input = parsed.output,
      apiKey = input.apiKey ?? this.key(input.provider);
    this.query(
      "INSERT INTO web_tool_service (id, apiKey, dailyLimit, provider) VALUES (1, '', ?, ?) ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, dailyLimit = excluded.dailyLimit",
      input.dailyLimit,
      input.provider,
    );
    this.query(
      'INSERT INTO web_tool_credentials VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET apiKey = excluded.apiKey',
      input.provider,
      apiKey,
    );
    return this.settings();
  }
  claim(id: string, acceptedLimit: number): { allowed: true } | { error: string } {
    if (
      !/^[a-f0-9]{64}$/.test(id) ||
      !Number.isInteger(acceptedLimit) ||
      acceptedLimit < 1 ||
      acceptedLimit > 1000
    )
      throw new Error('无效的工具请求预算。');
    const day = this.day();
    this.query('DELETE FROM web_tool_requests WHERE day < ?', this.day(-86_400_000));
    if (this.query('SELECT id FROM web_tool_requests WHERE id = ?', id).toArray().length)
      return { allowed: true };
    const count = this.settings().usedToday;
    if (count >= Math.min(acceptedLimit, this.configuration().dailyLimit))
      return { error: WEB_TOOL_QUOTA_ERROR };
    this.query('INSERT INTO web_tool_requests VALUES (?, ?)', id, day);
    return { allowed: true };
  }
}
