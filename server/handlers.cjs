// 业务处理器（认证 + 自选）：本地服务器与 Vercel 函数共用同一套实现
// 统一出入参：handleX({ body, cookies, query }) -> { status, headers, body }
'use strict';
const auth = require('./auth.cjs');
const { getDb } = require('./db.cjs');

// 启动时确保内置管理员（root/root）已写入 SQLite
auth.ensureAdminSeed();

const ok = (body, headers = {}) => ({ status: 200, headers, body: { ok: true, ...body } });
const err = (status, error) => ({ status, headers: {}, body: { ok: false, error } });

function currentUser(cookies) {
  return auth.userFromSessionToken(cookies && cookies[auth.SESSION_COOKIE]);
}

// ---------------- 认证 ----------------
function register({ body, cookies = {} }) {
  const { username, password } = body || {};
  const invalid = auth.validateCredentials(username, password);
  if (invalid) return err(400, invalid);

  const created = auth.createUser(username, password);
  if (created.error) return err(409, created.error);

  const { token } = auth.createSession(created.id);
  return ok({ user: auth.publicUser(created) }, { 'Set-Cookie': auth.sessionCookie(token) });
}

function login({ body }) {
  const { username, password } = body || {};
  if (!username || !password) return err(400, '请输入用户名和密码');

  const user = auth.findUserByName(username);
  // 统一错误文案，避免暴露用户名是否存在
  if (!user || !auth.verifyPassword(password, user.salt, user.password_hash)) {
    return err(401, '用户名或密码不正确');
  }
  const { token } = auth.createSession(user.id);
  return ok({ user: auth.publicUser(user) }, { 'Set-Cookie': auth.sessionCookie(token) });
}

function logout({ cookies = {} }) {
  auth.destroySession(cookies[auth.SESSION_COOKIE]);
  return ok({ user: null }, { 'Set-Cookie': auth.clearCookie() });
}

function me({ cookies = {} }) {
  const user = currentUser(cookies);
  return ok({ user: auth.publicUser(user) });
}

// ---------------- 自选基金 ----------------
function listWatchlist({ cookies = {} }) {
  const user = currentUser(cookies);
  if (!user) return err(401, '请先登录');
  const rows = getDb()
    .prepare('SELECT code, name, created_at FROM watchlist WHERE user_id = ? ORDER BY id ASC')
    .all(user.id);
  return ok({ items: rows.map((r) => ({ code: r.code, name: r.name, createdAt: r.created_at })) });
}

function addWatchlist({ cookies = {}, body }) {
  const user = currentUser(cookies);
  if (!user) return err(401, '请先登录');
  const code = String((body && body.code) || '').trim();
  const name = String((body && body.name) || '').trim().slice(0, 60);
  const invalid = auth.validateFundCode(code);
  if (invalid) return err(400, invalid);

  getDb()
    .prepare(`INSERT INTO watchlist (user_id, code, name, created_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id, code) DO UPDATE SET name = excluded.name`)
    .run(user.id, code, name, new Date().toISOString());
  return ok({ code, name });
}

function removeWatchlist({ cookies = {}, query = {} }) {
  const user = currentUser(cookies);
  if (!user) return err(401, '请先登录');
  const code = String(query.code || '').trim();
  const invalid = auth.validateFundCode(code);
  if (invalid) return err(400, invalid);
  const info = getDb().prepare('DELETE FROM watchlist WHERE user_id = ? AND code = ?').run(user.id, code);
  return ok({ code, removed: Number(info.changes) });
}

/** 批量同步（例如把浏览器本地自选合并到账号） */
function syncWatchlist({ cookies = {}, body }) {
  const user = currentUser(cookies);
  if (!user) return err(401, '请先登录');
  const items = Array.isArray(body && body.items) ? body.items.slice(0, 200) : [];
  const stmt = getDb().prepare(
    `INSERT INTO watchlist (user_id, code, name, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, code) DO UPDATE SET name = excluded.name`
  );
  const now = new Date().toISOString();
  let n = 0;
  for (const it of items) {
    const code = String((it && it.code) || '').trim();
    if (!/^\d{6}$/.test(code)) continue;
    const name = String((it && it.name) || '').trim().slice(0, 60);
    stmt.run(user.id, code, name, now);
    n++;
  }
  return ok({ synced: n });
}

// ---------------- 后台管理（仅管理员） ----------------
/** 校验管理员身份，返回 { user } 或 { error } */
function requireAdmin(cookies) {
  const user = currentUser(cookies);
  if (!user) return { error: err(401, '请先登录') };
  if (!auth.isAdmin(user)) return { error: err(403, '需要管理员权限') };
  return { user };
}

function adminStats({ cookies = {} }) {
  const guard = requireAdmin(cookies);
  if (guard.error) return guard.error;
  const db = getDb();
  const n = (sql, ...args) => Number(Object.values(db.prepare(sql).get(...args))[0] || 0);
  return ok({
    stats: {
      users: n('SELECT COUNT(*) AS n FROM users'),
      admins: n("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
      watchlistItems: n('SELECT COUNT(*) AS n FROM watchlist'),
      usersWithWatchlist: n('SELECT COUNT(DISTINCT user_id) AS n FROM watchlist'),
      activeSessions: n('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?', new Date().toISOString()),
    },
  });
}

function adminUsers({ cookies = {}, query = {} }) {
  const guard = requireAdmin(cookies);
  if (guard.error) return guard.error;
  const q = String(query.q || '').trim();
  const size = Math.min(Math.max(parseInt(query.size || '50', 10) || 50, 1), 200);
  const page = Math.max(parseInt(query.page || '1', 10) || 1, 1);
  const like = `%${q}%`;

  const where = q ? 'WHERE u.username LIKE ?' : '';
  const args = q ? [like] : [];
  const total = Number(getDb().prepare(`SELECT COUNT(*) AS n FROM users u ${where}`).get(...args).n);

  const rows = getDb().prepare(`
    SELECT u.id, u.username, u.role, u.created_at,
           (SELECT COUNT(*) FROM watchlist w WHERE w.user_id = u.id) AS fund_count,
           (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS active_sessions
    FROM users u ${where}
    ORDER BY u.id ASC
    LIMIT ? OFFSET ?
  `).all(new Date().toISOString(), ...args, size, (page - 1) * size);

  return ok({
    total, page, size,
    items: rows.map((r) => ({
      id: r.id, username: r.username, role: r.role, createdAt: r.created_at,
      fundCount: r.fund_count, activeSessions: r.active_sessions,
    })),
  });
}

/** 单个用户详情 + 其自选基金明细 */
function adminUserDetail({ cookies = {}, query = {} }) {
  const guard = requireAdmin(cookies);
  if (guard.error) return guard.error;
  const target = auth.findUserById(query.id);
  if (!target) return err(404, '用户不存在');
  const items = getDb()
    .prepare('SELECT code, name, created_at FROM watchlist WHERE user_id = ? ORDER BY id ASC')
    .all(target.id)
    .map((r) => ({ code: r.code, name: r.name, createdAt: r.created_at }));
  return ok({ user: auth.publicUser(target), funds: items });
}

/** 删除用户（级联删除其自选与会话）；不允许删除管理员或自己 */
function adminDeleteUser({ cookies = {}, query = {} }) {
  const guard = requireAdmin(cookies);
  if (guard.error) return guard.error;
  const target = auth.findUserById(query.id);
  if (!target) return err(404, '用户不存在');
  if (auth.isAdmin(target)) return err(400, '不能删除管理员账号');
  if (target.id === guard.user.id) return err(400, '不能删除当前登录账号');
  getDb().prepare('DELETE FROM users WHERE id = ?').run(target.id);
  return ok({ deleted: target.id, username: target.username });
}

/** 重置用户密码（管理员操作） */
function adminResetPassword({ cookies = {}, query = {}, body }) {
  const guard = requireAdmin(cookies);
  if (guard.error) return guard.error;
  const target = auth.findUserById(query.id);
  if (!target) return err(404, '用户不存在');
  const password = String((body && body.password) || '');
  const invalid = auth.validateCredentials(target.username, password);
  if (invalid) return err(400, invalid);
  auth.changePassword(target.id, password);
  return ok({ id: target.id, username: target.username, reset: true });
}

module.exports = {
  register, login, logout, me,
  listWatchlist, addWatchlist, removeWatchlist, syncWatchlist,
  adminStats, adminUsers, adminUserDetail, adminDeleteUser, adminResetPassword,
};
