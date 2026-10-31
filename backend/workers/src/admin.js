/**
 * 管理端（Cloudflare Workers 版）
 *   与 Node 端 server/handlers.cjs 的 admin* 保持同样的响应结构，
 *   指标明细复用 shared/metrics.cjs（两端同一份 SQL 定义）。
 *   数据导出：现算全库 NDJSON → gzip → 直接下载（**不使用 R2 / 不落任何存储**）。
 */
import { all, one, run, count, err, ok, nowIso } from './db.js';
import { hashPassword } from './auth.js';
import metricsModule from '../../shared/metrics.cjs';

const METRIC_DEFS = (metricsModule && metricsModule.METRIC_DEFS) || {};

export async function requireAdmin(db, user) {
  if (!user) return { error: err(401, '请先登录') };
  if (user.role !== 'admin') return { error: err(403, '需要管理员权限') };
  return { user };
}

export async function adminStats(db) {
  const now = nowIso();
  const latest = await one(db, 'SELECT MAX(date) AS d FROM account_daily');
  return ok({
    stats: {
      users: await count(db, 'SELECT COUNT(*) AS n FROM users'),
      admins: await count(db, "SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
      activeSessions: await count(db, 'SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?', now),
      watchlistItems: await count(db, 'SELECT COUNT(*) AS n FROM watchlist'),
      usersWithWatchlist: await count(db, 'SELECT COUNT(DISTINCT user_id) AS n FROM watchlist'),
      positionsItems: await count(db, 'SELECT COUNT(*) AS n FROM positions'),
      usersWithPositions: await count(db, 'SELECT COUNT(DISTINCT user_id) AS n FROM positions'),
      quotesCached: await count(db, 'SELECT COUNT(*) AS n FROM fund_quotes'),
      snapshotDays: await count(db, 'SELECT COUNT(DISTINCT date) AS n FROM account_daily'),
      latestSnapshot: (latest && latest.d) || null,
      positionDailyRows: await count(db, 'SELECT COUNT(*) AS n FROM position_daily'),
      runtime: 'cloudflare-workers',
      database: 'cloudflare-d1',
    },
  });
}

export async function adminUsers(db, query = {}) {
  const q = String(query.q || '').trim();
  const size = Math.min(Math.max(parseInt(query.size || '50', 10) || 50, 1), 200);
  const page = Math.max(parseInt(query.page || '1', 10) || 1, 1);
  const where = q ? 'WHERE u.username LIKE ?' : '';
  const args = q ? [`%${q}%`] : [];
  const now = nowIso();

  const total = await count(db, `SELECT COUNT(*) AS n FROM users u ${where}`, ...args);
  const rows = await all(
    db,
    `SELECT u.id, u.username, u.role, u.created_at,
            (SELECT COUNT(*) FROM watchlist w WHERE w.user_id = u.id) AS fund_count,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS active_sessions
     FROM users u ${where}
     ORDER BY u.id ASC
     LIMIT ? OFFSET ?`,
    now,
    ...args,
    size,
    (page - 1) * size,
  );

  return ok({
    total,
    page,
    size,
    items: rows.map((r) => ({
      id: r.id,
      username: r.username,
      role: r.role,
      createdAt: r.created_at,
      fundCount: r.fund_count,
      activeSessions: r.active_sessions,
    })),
  });
}

export async function adminUserDetail(db, id) {
  const target = await one(db, 'SELECT * FROM users WHERE id = ?', Number(id));
  if (!target) return err(404, '用户不存在');
  const items = await all(db, 'SELECT code, name, created_at FROM watchlist WHERE user_id = ? ORDER BY id ASC', target.id);
  return ok({
    user: { id: target.id, username: target.username, role: target.role, created_at: target.created_at },
    funds: items.map((r) => ({ code: r.code, name: r.name, createdAt: r.created_at })),
  });
}

export async function adminDeleteUser(db, id, currentUserId) {
  const target = await one(db, 'SELECT * FROM users WHERE id = ?', Number(id));
  if (!target) return err(404, '用户不存在');
  if (target.role === 'admin') return err(400, '不能删除管理员账号');
  if (target.id === Number(currentUserId)) return err(400, '不能删除当前登录账号');
  // D1 已开启外键级联：sessions / watchlist / positions / position_daily / account_daily 一并删除
  await run(db, 'DELETE FROM users WHERE id = ?', target.id);
  return ok({ deleted: target.id, username: target.username });
}

export async function adminResetPassword(db, id, newPassword, iterations) {
  const target = await one(db, 'SELECT * FROM users WHERE id = ?', Number(id));
  if (!target) return err(404, '用户不存在');
  const pwd = String(newPassword || '');
  if (pwd.length < 6 || pwd.length > 72) return err(400, '密码长度需为 6-72 位');
  const { hash, salt } = await hashPassword(pwd, iterations);
  await run(db, 'UPDATE users SET password_hash = ?, salt = ? WHERE id = ?', hash, salt, target.id);
  await run(db, 'DELETE FROM sessions WHERE user_id = ?', target.id); // 旧会话立即失效
  return ok({ id: target.id, username: target.username, reset: true });
}

export async function adminMetricDetail(db, key) {
  const def = METRIC_DEFS[String(key || '')];
  if (!def) return err(404, '未知的指标');
  const args = def.args ? def.args() : [];
  const countArgs = def.countArgs ? def.countArgs() : args;
  const total = def.countSql ? await count(db, def.countSql, ...countArgs) : 0;
  const items = await all(db, def.sql, ...args);
  return ok({
    key,
    title: def.title,
    note: def.note,
    columns: def.columns,
    items,
    total: def.countSql ? total : items.length,
    truncated: def.countSql ? total > items.length : false,
  });
}

/* ==================== 数据导出（不依赖任何对象存储） ====================
 * 设计取舍：**不使用 R2**（也不落任何文件）。
 * 备份 = 管理端点击「导出数据」→ Worker 现算全库 NDJSON → gzip → 浏览器直接下载，
 * 由管理员自行保存到本地/网盘/版本库之外的位置。
 */
const TABLES = ['users', 'sessions', 'watchlist', 'positions', 'fund_quotes', 'position_daily', 'account_daily'];
const MAX_ROWS_PER_TABLE = 20000;

/** 把 D1 全库导出成 NDJSON 文本 */
export async function dumpDatabase(db) {
  const lines = [];
  const summary = {};
  for (const table of TABLES) {
    const rows = await all(db, `SELECT * FROM ${table} LIMIT ${MAX_ROWS_PER_TABLE}`);
    summary[table] = rows.length;
    for (const row of rows) lines.push(JSON.stringify({ table, row }));
  }
  return { text: `${lines.join('\n')}\n`, summary };
}

/** 全库导出为 gzip NDJSON 的下载响应（流式压缩，不占存储） */
export async function exportResponse(db) {
  const { text, summary } = await dumpDatabase(db);
  const gz = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `fund-watch-${stamp}.ndjson.gz`;
  return new Response(gz, {
    status: 200,
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Encoding': 'gzip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Dump-Tables': String(Object.keys(summary).length),
      'X-Dump-Rows': String(Object.values(summary).reduce((a, b) => a + b, 0)),
    },
  });
}
