// SQLite 数据层（Node 内置 node:sqlite，无需任何 npm 依赖）
// 表：users（用户）/ sessions（登录会话）/ watchlist（自选基金）
//
// 持久化保障（重启不丢数据）：
//  1) 路径优先「项目内 data/ 目录」，且**实际探测可写性**——不再因为 VERCEL 环境变量就静默落到 /tmp
//  2) 打开连接时执行 WAL checkpoint(TRUNCATE)，把历史 WAL 合并回主库文件，
//     这样即使只剩一个 .db 文件（WAL/SHM 边车丢失）也不会丢数据
//  3) 提供 closeDb()：进程优雅退出时 checkpoint 并关闭，WAL 边车被自动清理
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

let db = null;
let dbPath = null;
let persistent = false;

const PROJECT_ROOT = path.resolve(__dirname, '..');

/** 探测目录是否可写（真实写入一个临时文件） */
function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析数据库文件路径（优先级）：
 *  1. 环境变量 DB_PATH（显式指定，生产环境应指向持久化卷）
 *  2. 项目内 <root>/data/fundwatch.db（本地开发默认，持久）
 *     —— 只有在该目录**不可写**时才回退临时目录，并打印醒目警告
 */
function resolveDbPath() {
  if (process.env.DB_PATH) return { file: path.resolve(process.env.DB_PATH), persistent: true, reason: 'DB_PATH' };

  const local = path.join(PROJECT_ROOT, 'data', 'fundwatch.db');
  if (isWritableDir(path.dirname(local))) return { file: local, persistent: true, reason: '项目 data/ 目录' };

  // 项目目录只读（如 Vercel 生产环境未配置 DB_PATH）→ 只能临时存储
  const tmp = path.join(os.tmpdir(), 'fundwatch.db');
  return { file: tmp, persistent: false, reason: '项目目录不可写（临时回退）' };
}

function getDb() {
  if (db) return db;
  const resolved = resolveDbPath();
  dbPath = resolved.file;
  persistent = resolved.persistent;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA wal_autocheckpoint = 32;');   // WAL 超过 ~128KB 自动合并回主库
  migrate(db);

  // 关键：把历史 WAL 合并回主库文件，确保单个 .db 文件即包含全部数据
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* 忽略 */ }

  if (!persistent) {
    console.warn(
      `[db] ⚠️ 当前使用临时数据库 ${dbPath}（${resolved.reason}），**服务重启后数据会丢失**。\n` +
      '      请设置 DB_PATH 指向持久化目录，例如：DB_PATH=/var/lib/fundwatch/fundwatch.db'
    );
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

    -- 行情缓存：净值 / 当日涨幅 / 盘中估值（避免频繁请求上游，并为每日快照提供数据）
    CREATE TABLE IF NOT EXISTS fund_quotes (
      code               TEXT PRIMARY KEY,
      name               TEXT    NOT NULL DEFAULT '',
      nav                REAL,            -- 单位净值
      nav_date           TEXT,            -- 净值日期 YYYY-MM-DD
      day_change         REAL,            -- 当日涨幅 %（最新净值 jzzzl）
      acc_nav            REAL,            -- 累计净值
      est_change         REAL,            -- 盘中估算涨幅 %
      est_time           TEXT,            -- 估值时间
      estimate_available INTEGER NOT NULL DEFAULT 0,
      updated_at         TEXT    NOT NULL
    );

    -- 持仓每日快照：当日收益、当日涨幅、净值（可回溯"当日收益"的来源）
    CREATE TABLE IF NOT EXISTS position_daily (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date       TEXT    NOT NULL,        -- 交易日 YYYY-MM-DD
      code       TEXT    NOT NULL,
      name       TEXT    NOT NULL DEFAULT '',
      amount     REAL    NOT NULL DEFAULT 0,   -- 当日持有金额
      profit     REAL    NOT NULL DEFAULT 0,   -- 持有收益
      nav        REAL,                         -- 当日单位净值
      day_change REAL,                         -- 当日涨幅 %
      est_change REAL,                         -- 盘中估算涨幅 %
      day_profit REAL    NOT NULL DEFAULT 0,   -- 当日收益（金额）
      updated_at TEXT    NOT NULL,
      UNIQUE(user_id, date, code)
    );
    CREATE INDEX IF NOT EXISTS idx_position_daily_user_date ON position_daily(user_id, date);

    -- 账户每日快照：账户资产 / 持有收益 / 当日总收益（收益曲线的数据源）
    CREATE TABLE IF NOT EXISTS account_daily (
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date         TEXT    NOT NULL,
      total_amount REAL    NOT NULL DEFAULT 0,  -- 账户资产（持仓金额合计）
      total_profit REAL    NOT NULL DEFAULT 0,  -- 持有收益合计
      day_profit   REAL    NOT NULL DEFAULT 0,  -- 当日总收益
      position_cnt INTEGER NOT NULL DEFAULT 0,
      watch_cnt    INTEGER NOT NULL DEFAULT 0,
      updated_at   TEXT    NOT NULL,
      PRIMARY KEY (user_id, date)
    );
  `);

  // 兼容旧库
  const cols = d.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('role')) {
    d.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }
  const wcols = d.prepare('PRAGMA table_info(watchlist)').all().map((c) => c.name);
  if (!wcols.includes('sort_order')) {
    d.exec('ALTER TABLE watchlist ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  }
}

/** 清理过期会话（每次写入前顺带调用，成本极低） */
function purgeExpiredSessions() {
  getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

function getDbPath() {
  if (!dbPath) getDb();
  return dbPath;
}

/** 当前数据库是否位于持久化位置 */
function isPersistent() {
  if (dbPath === null) getDb();
  return persistent;
}

/** 库内数据量概览（用于健康检查 / 运维自检） */
function dbInfo() {
  const d = getDb();
  const n = (sql, ...args) => Number(Object.values(d.prepare(sql).get(...args))[0] || 0);
  const fileSize = (() => { try { return fs.statSync(dbPath).size; } catch { return 0; } })();
  const walPath = `${dbPath}-wal`;
  const walSize = (() => { try { return fs.statSync(walPath).size; } catch { return 0; } })();
  return {
    path: dbPath,
    persistent,
    fileSize,
    walSize,
    users: n('SELECT COUNT(*) AS n FROM users'),
    admins: n("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
    watchlistItems: n('SELECT COUNT(*) AS n FROM watchlist'),
    activeSessions: n('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?', new Date().toISOString()),
  };
}

/** 把 WAL 合并回主库（单文件即可完整备份/迁移） */
function checkpoint() {
  if (!db) return;
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* 忽略 */ }
}

/** 生成一致性快照备份（SQLite VACUUM INTO，等价于在线备份） */
function backupTo(target) {
  const d = getDb();
  const dest = path.resolve(target);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  d.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  return dest;
}

/** 优雅关闭：checkpoint 后 close，WAL/SHM 边车会被清理，数据全部落入 .db */
function closeDb() {
  if (!db) return;
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* 忽略 */ }
  try { db.close(); } catch { /* 忽略 */ }
  db = null;
}

module.exports = {
  getDb, getDbPath, isPersistent, purgeExpiredSessions,
  dbInfo, checkpoint, backupTo, closeDb,
};
