// SQLite 数据层（Node 内置 node:sqlite，无需任何 npm 依赖）
// 表：users（用户）/ sessions（登录会话）/ watchlist（自选基金）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

let db = null;

/** 解析数据库文件路径：
 *  - DB_PATH 环境变量优先
 *  - Vercel 等只读文件系统环境 → /tmp（注意：数据是临时的，重启/换实例即丢失）
 *  - 本地开发 → <项目根>/data/fundwatch.db（持久化）
 */
function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  if (process.env.VERCEL) return '/tmp/fundwatch.db';
  const root = path.resolve(__dirname, '..');
  return path.join(root, 'data', 'fundwatch.db');
}

function getDb() {
  if (db) return db;
  const file = resolveDbPath();
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  if (process.env.VERCEL && !process.env.DB_PATH) {
    console.warn('[db] 警告：运行在 Vercel 上，SQLite 使用 /tmp（临时存储，实例重启后数据丢失）。' +
      '生产环境请设置 DB_PATH 指向持久化卷，或改用托管 SQLite（如 Turso）。');
  }
  return db;
}

function migrate(d) {
  d.exec(`
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
      created_at TEXT    NOT NULL,
      UNIQUE(user_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist(user_id);
  `);

  // 兼容旧库：补充 role 列（已存在的用户默认 user）
  const cols = d.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('role')) {
    d.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }
}

/** 清理过期会话（每次写入前顺带调用，成本极低） */
function purgeExpiredSessions() {
  getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

function getDbPath() {
  return resolveDbPath();
}

module.exports = { getDb, getDbPath, purgeExpiredSessions };
