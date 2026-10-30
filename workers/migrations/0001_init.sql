-- Cloudflare D1 初始结构（与本地 SQLite / server/db.cjs 完全一致）
-- 应用：npx wrangler d1 migrations apply fund-watch --local（本地）/ --remote（线上）
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user',
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS watchlist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code       TEXT    NOT NULL,
  name       TEXT    NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL,
  UNIQUE(user_id, code)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist(user_id, sort_order);

CREATE TABLE IF NOT EXISTS positions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code       TEXT    NOT NULL,
  name       TEXT    NOT NULL DEFAULT '',
  amount     REAL    NOT NULL DEFAULT 0,
  profit     REAL    NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL,
  UNIQUE(user_id, code)
);
CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id, sort_order);

-- 行情缓存（净值为季度/每日披露数据，60s TTL 内复用，避免频繁打上游）
CREATE TABLE IF NOT EXISTS fund_quotes (
  code               TEXT PRIMARY KEY,
  name               TEXT    NOT NULL DEFAULT '',
  nav                REAL,
  nav_date           TEXT,
  day_change         REAL,
  acc_nav            REAL,
  est_change         REAL,
  est_time           TEXT,
  estimate_available INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT    NOT NULL
);

-- 每只持仓的每日快照（当日收益可回溯）
CREATE TABLE IF NOT EXISTS position_daily (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT    NOT NULL,
  code       TEXT    NOT NULL,
  name       TEXT    NOT NULL DEFAULT '',
  amount     REAL    NOT NULL DEFAULT 0,
  profit     REAL    NOT NULL DEFAULT 0,
  nav        REAL,
  day_change REAL,
  est_change REAL,
  day_profit REAL    NOT NULL DEFAULT 0,
  updated_at TEXT    NOT NULL,
  UNIQUE(user_id, date, code)
);
CREATE INDEX IF NOT EXISTS idx_position_daily_user_date ON position_daily(user_id, date);

-- 账户每日快照（收益曲线数据源）
CREATE TABLE IF NOT EXISTS account_daily (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date         TEXT    NOT NULL,
  total_amount REAL    NOT NULL DEFAULT 0,
  total_profit REAL    NOT NULL DEFAULT 0,
  day_profit   REAL    NOT NULL DEFAULT 0,
  position_cnt INTEGER NOT NULL DEFAULT 0,
  watch_cnt    INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT    NOT NULL,
  PRIMARY KEY (user_id, date)
);
