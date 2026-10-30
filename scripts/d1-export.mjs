/**
 * 把本地 SQLite 数据导出为 **D1 可直接执行的 SQL 文件**
 *   node scripts/d1-export.mjs [--out=d1-data.sql]
 *
 * 用途：把已有部署（本地 data/fundwatch.db）的数据搬到 Cloudflare D1：
 *   npx wrangler d1 execute fund-watch --remote --file=./d1-data.sql
 *
 * 重要限制（会打印警告）：
 *   旧版密码是 **scrypt** 哈希，Workers 的 WebCrypto 无法验证 → 这些账号在 Cloudflare 上无法登录，
 *   需重置密码（管理端重置会写入 PBKDF2 格式）。脚本会统计受影响的账号数。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = (args.find((a) => a.startsWith('--out=')) || '').split('=').slice(1).join('=');
const OUT = path.resolve(ROOT, outArg || 'd1-data.sql');
const DB = path.resolve(process.env.DB_PATH || path.join(ROOT, 'data', 'fundwatch.db'));

if (!existsSync(DB)) {
  console.error(`✗ 找不到本地数据库：${DB}\n  可用 DB_PATH 指定路径`);
  process.exit(1);
}

const db = new DatabaseSync(DB, { readOnly: true });
const TABLES = ['users', 'sessions', 'watchlist', 'positions', 'fund_quotes', 'position_daily', 'account_daily'];

/** SQLite 值 → SQL 字面量 */
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

const lines = [];
lines.push('-- 由 scripts/d1-export.mjs 生成：本地 SQLite → Cloudflare D1');
lines.push(`-- 源库：${DB}`);
lines.push(`-- 生成时间：${new Date().toISOString()}`);
lines.push('-- 用法：npx wrangler d1 execute fund-watch --remote --file=./d1-data.sql');
lines.push('PRAGMA defer_foreign_keys = true;');

const summary = {};
for (const table of TABLES) {
  let rows = [];
  try {
    rows = db.prepare(`SELECT * FROM ${table}`).all();
  } catch (e) {
    console.warn(`  ! 跳过 ${table}：${e.message}`);
    continue;
  }
  summary[table] = rows.length;
  if (!rows.length) continue;
  lines.push('');
  lines.push(`-- ${table}：${rows.length} 行`);
  for (const row of rows) {
    const cols = Object.keys(row);
    lines.push(
      `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => sqlLiteral(row[c])).join(', ')});`,
    );
  }
}

db.close();
writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8');

/* ---------- 统计 scrypt 账号（需要重置密码） ---------- */
const reread = new DatabaseSync(DB, { readOnly: true });
let scryptCount = 0;
let pbkdf2Count = 0;
try {
  const users = reread.prepare('SELECT password_hash FROM users').all();
  for (const u of users) {
    if (String(u.password_hash || '').startsWith('pbkdf2$')) pbkdf2Count += 1;
    else scryptCount += 1;
  }
} catch {
  /* 忽略 */
}
reread.close();

console.log(`\n✅ 已生成 ${path.relative(ROOT, OUT)}`);
for (const [t, n] of Object.entries(summary)) console.log(`   ${t}: ${n} 行`);
console.log('\n下一步：');
console.log('  npx wrangler d1 execute fund-watch --remote --file=./d1-data.sql');
if (scryptCount > 0) {
  console.log(
    `\n⚠️ 有 ${scryptCount} 个账号使用旧版 scrypt 密码哈希，Cloudflare Workers 无法验证。` +
      `\n   迁移后请用管理端「重置密码」为这些账号设置新密码（会写入 PBKDF2 格式）。` +
      `\n   已有 PBKDF2 账号：${pbkdf2Count} 个（可直接登录）。`,
  );
} else {
  console.log(`\n✅ 全部 ${pbkdf2Count} 个账号已是 PBKDF2 哈希，迁移后可直接登录。`);
}
