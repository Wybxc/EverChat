export const USAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_attempts (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL, startedAt INTEGER NOT NULL,
  providerId TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
  payload TEXT NOT NULL, messageId TEXT
);
CREATE INDEX IF NOT EXISTS usage_attempts_time ON usage_attempts(startedAt, id);
CREATE INDEX IF NOT EXISTS usage_attempts_provider ON usage_attempts(providerId, model, startedAt);
CREATE INDEX IF NOT EXISTS usage_attempts_message ON usage_attempts(messageId) WHERE messageId IS NOT NULL;
CREATE TABLE IF NOT EXISTS usage_prices (
  id TEXT PRIMARY KEY, providerId TEXT NOT NULL, model TEXT NOT NULL,
  effectiveFrom INTEGER NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_prices_model ON usage_prices(providerId, model, effectiveFrom);
CREATE TABLE IF NOT EXISTS usage_rollups (
  bucket TEXT PRIMARY KEY, startedAt INTEGER NOT NULL, providerId TEXT NOT NULL,
  model TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_rollups_time ON usage_rollups(startedAt);
`;
export const USAGE_OUTBOX_SCHEMA = `CREATE TABLE IF NOT EXISTS usage_outbox (
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, nextAt INTEGER, attempts INTEGER NOT NULL DEFAULT 0
)`;
