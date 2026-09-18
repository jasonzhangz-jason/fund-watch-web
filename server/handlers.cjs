// 业务处理器（认证 + 自选）：本地服务器与 Vercel 函数共用同一套实现
// 统一出入参：handleX({ body, cookies, query }) -> { status, headers, body }
'use strict';
const auth = require('./auth.cjs');
const { getDb, checkpoint } = require('./db.cjs');
const portfolio = require('./portfolio.cjs');
const market = require('./market.cjs');

// 启动时确保内置管理员（root/root）已写入 SQLite
auth.ensureAdminSeed();

/**
 * 写操作后立即把 WAL 合并回主库文件。
 * 这样即使进程被强杀（Windows 下 SIGTERM 即强制终止）或只保留单个 .db 文件，
 * 已提交的数据也完整地存在于主库中——重启不覆盖、不丢失。
 */
const commit = () => { try { checkpoint(); } catch { /* 忽略 */ } };

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
  commit();
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
  commit();
  return ok({ user: auth.publicUser(user) }, { 'Set-Cookie': auth.sessionCookie(token) });
}

function logout({ cookies = {} }) {
  auth.destroySession(cookies[auth.SESSION_COOKIE]);
  commit();
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
    .prepare('SELECT code, name, sort_order, created_at FROM watchlist WHERE user_id = ? ORDER BY sort_order ASC, id ASC')
    .all(user.id);
  return ok({ items: rows.map((r) => ({ code: r.code, name: r.name, sort: r.sort_order, createdAt: r.created_at })) });
}

function addWatchlist({ cookies = {}, body }) {
  const user = currentUser(cookies);
  if (!user) return err(401, '请先登录');
  const code = String((body && body.code) || '').trim();
  const name = String((body && body.name) || '').trim().slice(0, 60);
  const invalid = auth.validateFundCode(code);
  if (invalid) return err(400, invalid);

  const db = getDb();
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM watchlist WHERE user_id = ?').get(user.id);
  db.prepare(
    `INSERT INTO watchlist (user_id, code, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, code) DO UPDATE SET name = excluded.name`,
  ).run(user.id, code, name, Number(max.m) + 1, new Date().toISOString());
  commit();
  return ok({ code, name });
}

function removeWatchlist({ cookies = {}, query = {} }) {
  const user = currentUser(cookies);
  if (!user) return err(401, '请先登录');
  const code = String(query.code || '').trim();
  const invalid = auth.validateFundCode(code);
  if (invalid) return err(400, invalid);
  const info = getDb().prepare('DELETE FROM watchlist WHERE user_id = ? AND code = ?').run(user.id, code);
  commit();
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
  commit();
  return ok({ synced: n });
}

// ---------------- 持仓（账号级，服务端持久化） ----------------
/** 持仓列表（按 sort_order 排序） */
function listPositions({ cookies = {} }) {
  const user = currentUser(cookies);
  if (!user) return err(401, '请先登录');
  const rows = getDb()
    .prepare('SELECT code, name, amount, profit FROM positions WHERE user_id = ? ORDER BY sort_order ASC, id ASC')
    .all(user.id);
  return ok({ items: rows.map((r) => ({ code: r.code, name: r.name, amount: r.amount, profit: r.profit })) });
}

/** 新增或更新一条持仓（按 code upsert） */
function savePosition({ cookies = {}, body }) {
  const user = currentUser(cookies);
  if (!user) return err(401, '请先登录');
  const code = String((body && body.code) || '').trim();
  const invalid = auth.validateFundCode(code);
  if (invalid) return err(400, invalid);

  const name = String((body && body.name) || '').trim().slice(0, 60);
  const amount = Number(body && body.amount);
  const profit = Number(body && body.profit);
  if (!Number.isFinite(amount) || amount < 0) return err(400, '持有金额需为不小于 0 的数字');
  if (!Number.isFinite(profit)) return err(400, '持有收益需为数字');

  const db = getDb();
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM positions WHERE user_id = ?').get(user.id);
  db.prepare(
    `INSERT INTO positions (user_id, code, name, amount, profit, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, code) DO UPDATE SET name = excluded.name, amount = excluded.amount, profit = excluded.profit`,
  ).run(user.id, code, name, amount, profit, Number(max.m) + 1, new Date().toISOString());
  commit();
  return ok({ code, name, amount, profit });
}

/** 删除一条或多条持仓（支持 ?codes=a,b 或 body.codes / body.code） */
function removePositions({ cookies = {}, body, query = {} }) {
  const user = currentUser(cookies);
  if (!user) return err(401, '请先登录');
  const raw =
    query.codes ||
    (body && (Array.isArray(body.codes) ? body.codes.join(',') : body.codes)) ||
    (body && body.code) ||
    '';
  const codes = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d{6}$/.test(s));
  if (!codes.length) return err(400, '缺少要删除的基金代码');

  const stmt = getDb().prepare('DELETE FROM positions WHERE user_id = ? AND code = ?');
  let removed = 0;
  for (const c of codes) removed += Number(stmt.run(user.id, c).changes);
  commit();
  return ok({ removed, codes });
}

/** 排序：置顶 / 上移 / 下移（重排后整体写回 sort_order） */
function reorderPosition({ cookies = {}, body }) {
  const user = currentUser(cookies);
  if (!user) return err(401, '请先登录');
  const code = String((body && body.code) || '').trim();
  const dir = String((body && body.dir) || '');
  if (!/^\d{6}$/.test(code) || !['top', 'up', 'down'].includes(dir)) return err(400, '参数无效');

  const db = getDb();
  const rows = db
    .prepare('SELECT code FROM positions WHERE user_id = ? ORDER BY sort_order ASC, id ASC')
    .all(user.id)
    .map((r) => r.code);
  const idx = rows.indexOf(code);
  if (idx < 0) return err(404, '持仓不存在');

  rows.splice(idx, 1);
  if (dir === 'top') rows.unshift(code);
  else if (dir === 'up') rows.splice(Math.max(0, idx - 1), 0, code);
  else rows.splice(Math.min(rows.length, idx + 1), 0, code);

  const upd = db.prepare('UPDATE positions SET sort_order = ? WHERE user_id = ? AND code = ?');
  rows.forEach((c, i) => upd.run(i, user.id, c));
  commit();
  return ok({ order: rows });
}

// ---------------- 账本聚合（账户资产 / 当日收益） ----------------
/** 账户账本：账户资产、持有收益、当日收益、持仓明细（服务端计算并落库快照） */
async function getPortfolio({ cookies = {}, query = {} }) {
  const user = currentUser(cookies);
  if (!user) return err(401, '请先登录');
  const force = query.refresh === '1' || query.refresh === 'true';
  const data = await portfolio.buildPortfolio(user.id, { force });
  return ok({ portfolio: data });
}

/** 账户资产/收益历史（收益曲线数据源） */
function portfolioHistory({ cookies = {}, query = {} }) {
  const user = currentUser(cookies);
  if (!user) return err(401, '请先登录');
  return ok({ items: portfolio.getHistory(user.id, query.days), snapshot: portfolio.getSnapshot(user.id) });
}

/** 持仓每日明细快照（?date=YYYY-MM-DD 或 ?days=N） */
function portfolioDaily({ cookies = {}, query = {} }) {
  const user = currentUser(cookies);
  if (!user) return err(401, '请先登录');
  return ok({ items: portfolio.getPositionDaily(user.id, { date: query.date, days: query.days }) });
}

/** 批量行情（走 fund_quotes 缓存，?refresh=1 强制刷新） */
async function getQuotes({ cookies = {}, query = {} }) {
  const user = currentUser(cookies);
  if (!user) return err(401, '请先登录');
  const codes = String(query.codes || '')
    .split(',')
    .map((s) => s.trim())
    .filter((c) => /^\d{6}$/.test(c))
    .slice(0, 200);
  if (!codes.length) return err(400, '缺少 codes 参数（逗号分隔的 6 位基金代码）');
  const map = await market.getQuotes(codes, { force: query.refresh === '1' });
  return ok({ items: codes.map((c) => map.get(c)).filter(Boolean) });
}

/** 自选排序：置顶 / 上移 / 下移 */
function reorderWatchlist({ cookies = {}, body }) {
  const user = currentUser(cookies);
  if (!user) return err(401, '请先登录');
  const code = String((body && body.code) || '').trim();
  const dir = String((body && body.dir) || '');
  if (!/^\d{6}$/.test(code) || !['top', 'up', 'down'].includes(dir)) return err(400, '参数无效');

  const db = getDb();
  const rows = db
    .prepare('SELECT code FROM watchlist WHERE user_id = ? ORDER BY sort_order ASC, id ASC')
    .all(user.id)
    .map((r) => r.code);
  const idx = rows.indexOf(code);
  if (idx < 0) return err(404, '自选不存在');

  rows.splice(idx, 1);
  if (dir === 'top') rows.unshift(code);
  else if (dir === 'up') rows.splice(Math.max(0, idx - 1), 0, code);
  else rows.splice(Math.min(rows.length, idx + 1), 0, code);

  const upd = db.prepare('UPDATE watchlist SET sort_order = ? WHERE user_id = ? AND code = ?');
  rows.forEach((c, i) => upd.run(i, user.id, c));
  commit();
  return ok({ order: rows });
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
  const count = (sql, ...args) => {
    const row = db.prepare(sql).get(...args);
    return Number(row ? Object.values(row)[0] : 0) || 0;
  };
  const latest = db.prepare('SELECT MAX(date) AS d FROM account_daily').get();

  return ok({
    stats: {
      /* 账号侧 */
      users: count('SELECT COUNT(*) AS n FROM users'),
      admins: count("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
      activeSessions: count('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?', new Date().toISOString()),
      /* 自选侧 */
      watchlistItems: count('SELECT COUNT(*) AS n FROM watchlist'),
      usersWithWatchlist: count('SELECT COUNT(DISTINCT user_id) AS n FROM watchlist'),
      /* 账本侧 */
      positionsItems: count('SELECT COUNT(*) AS n FROM positions'),
      usersWithPositions: count('SELECT COUNT(DISTINCT user_id) AS n FROM positions'),
      /* 数据侧 */
      quotesCached: count('SELECT COUNT(*) AS n FROM fund_quotes'),
      snapshotDays: count('SELECT COUNT(DISTINCT date) AS n FROM account_daily'),
      latestSnapshot: (latest && latest.d) || null,
      positionDailyRows: count('SELECT COUNT(*) AS n FROM position_daily'),
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
  commit();
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
  commit();
  return ok({ id: target.id, username: target.username, reset: true });
}

/* ==================== 运营指标明细（点击指标卡下钻） ==================== */
/**
 * 每个指标对应的明细查询：columns 定义列（前端按此渲染表格），
 * sql 返回明细行（统一别名成前端字段名），countSql 用于总数（与 stats 对应字段一致）。
 */
const METRIC_DEFS = {
  users: {
    title: '注册用户',
    note: '全部账号',
    columns: [
      { key: 'id', label: 'ID', align: 'right' },
      { key: 'username', label: '用户名' },
      { key: 'role', label: '角色' },
      { key: 'createdAt', label: '注册时间' },
    ],
    sql: "SELECT id, username, CASE role WHEN 'admin' THEN '管理员' ELSE '普通用户' END AS role, created_at AS createdAt FROM users ORDER BY id ASC LIMIT 200",
    countSql: 'SELECT COUNT(*) AS n FROM users',
  },
  admins: {
    title: '管理员',
    note: 'role = admin 的账号',
    columns: [
      { key: 'id', label: 'ID', align: 'right' },
      { key: 'username', label: '用户名' },
      { key: 'createdAt', label: '注册时间' },
    ],
    sql: "SELECT id, username, created_at AS createdAt FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 200",
    countSql: "SELECT COUNT(*) AS n FROM users WHERE role = 'admin'",
  },
  activeSessions: {
    title: '活跃会话',
    note: '未过期的登录会话',
    columns: [
      { key: 'username', label: '用户名' },
      { key: 'createdAt', label: '建立时间' },
      { key: 'expiresAt', label: '过期时间' },
      { key: 'remainDays', label: '剩余', align: 'right' },
    ],
    sql: `SELECT u.username AS username, s.created_at AS createdAt, s.expires_at AS expiresAt,
                 CAST(julianday(s.expires_at) - julianday('now') AS INTEGER) AS remainDays
          FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.expires_at > ? ORDER BY s.created_at DESC LIMIT 200`,
    args: () => [new Date().toISOString()],
    countSql: 'SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?',
    countArgs: () => [new Date().toISOString()],
  },
  watchlistItems: {
    title: '自选条数',
    note: 'watchlist 全部记录',
    columns: [
      { key: 'username', label: '用户名' },
      { key: 'code', label: '代码' },
      { key: 'name', label: '基金名称' },
      { key: 'createdAt', label: '加入时间' },
    ],
    sql: `SELECT u.username AS username, w.code AS code, w.name AS name, w.created_at AS createdAt
          FROM watchlist w JOIN users u ON u.id = w.user_id
          ORDER BY w.id DESC LIMIT 200`,
    countSql: 'SELECT COUNT(*) AS n FROM watchlist',
  },
  usersWithWatchlist: {
    title: '有自选用户',
    note: '按用户聚合的自选数量',
    columns: [
      { key: 'username', label: '用户名' },
      { key: 'count', label: '自选条数', align: 'right' },
      { key: 'lastAt', label: '最近加入' },
    ],
    sql: `SELECT u.username AS username, COUNT(*) AS count, MAX(w.created_at) AS lastAt
          FROM watchlist w JOIN users u ON u.id = w.user_id
          GROUP BY w.user_id ORDER BY count DESC LIMIT 200`,
    countSql: 'SELECT COUNT(DISTINCT user_id) AS n FROM watchlist',
  },
  positionsItems: {
    title: '持仓条数',
    note: 'positions 全部记录',
    columns: [
      { key: 'username', label: '用户名' },
      { key: 'code', label: '代码' },
      { key: 'name', label: '基金名称' },
      { key: 'amount', label: '持有金额', align: 'right' },
      { key: 'profit', label: '持有收益', align: 'right' },
      { key: 'createdAt', label: '记录时间' },
    ],
    sql: `SELECT u.username AS username, p.code AS code, p.name AS name, p.amount AS amount,
                 p.profit AS profit, p.created_at AS createdAt
          FROM positions p JOIN users u ON u.id = p.user_id
          ORDER BY p.amount DESC LIMIT 200`,
    countSql: 'SELECT COUNT(*) AS n FROM positions',
  },
  usersWithPositions: {
    title: '有持仓用户',
    note: '按用户聚合的持仓与资产',
    columns: [
      { key: 'username', label: '用户名' },
      { key: 'count', label: '持仓只数', align: 'right' },
      { key: 'amount', label: '持有金额', align: 'right' },
      { key: 'profit', label: '持有收益', align: 'right' },
    ],
    sql: `SELECT u.username AS username, COUNT(*) AS count, SUM(p.amount) AS amount, SUM(p.profit) AS profit
          FROM positions p JOIN users u ON u.id = p.user_id
          GROUP BY p.user_id ORDER BY amount DESC LIMIT 200`,
    countSql: 'SELECT COUNT(DISTINCT user_id) AS n FROM positions',
  },
  quotesCached: {
    title: '行情缓存',
    note: 'fund_quotes 缓存的基金行情',
    columns: [
      { key: 'code', label: '代码' },
      { key: 'name', label: '基金名称' },
      { key: 'nav', label: '单位净值', align: 'right' },
      { key: 'navDate', label: '净值日期' },
      { key: 'dayChange', label: '当日涨幅%', align: 'right' },
      { key: 'estChange', label: '盘中估值%', align: 'right' },
      { key: 'updatedAt', label: '抓取时间' },
    ],
    sql: `SELECT code, name, nav, nav_date AS navDate, day_change AS dayChange,
                 est_change AS estChange, updated_at AS updatedAt
          FROM fund_quotes ORDER BY updated_at DESC LIMIT 200`,
    countSql: 'SELECT COUNT(*) AS n FROM fund_quotes',
  },
  snapshotDays: {
    title: '快照天数',
    note: 'account_daily 按交易日聚合',
    columns: [
      { key: 'date', label: '交易日' },
      { key: 'users', label: '用户数', align: 'right' },
      { key: 'amount', label: '账户资产合计', align: 'right' },
      { key: 'dayProfit', label: '当日总收益合计', align: 'right' },
    ],
    sql: `SELECT date, COUNT(*) AS users, SUM(total_amount) AS amount, SUM(day_profit) AS dayProfit
          FROM account_daily GROUP BY date ORDER BY date DESC LIMIT 200`,
    countSql: 'SELECT COUNT(DISTINCT date) AS n FROM account_daily',
  },
  positionDailyRows: {
    title: '每日明细行',
    note: 'position_daily 每只持仓的每日快照',
    columns: [
      { key: 'date', label: '交易日' },
      { key: 'username', label: '用户名' },
      { key: 'code', label: '代码' },
      { key: 'name', label: '基金名称' },
      { key: 'dayChange', label: '当日涨幅%', align: 'right' },
      { key: 'dayProfit', label: '当日收益', align: 'right' },
    ],
    sql: `SELECT d.date AS date, u.username AS username, d.code AS code, d.name AS name,
                 d.day_change AS dayChange, d.day_profit AS dayProfit
          FROM position_daily d JOIN users u ON u.id = d.user_id
          ORDER BY d.date DESC, d.day_profit DESC LIMIT 200`,
    countSql: 'SELECT COUNT(*) AS n FROM position_daily',
  },
};

/** 指标明细（仅管理员）：返回列定义 + 明细行，用于运营数据下钻 */
function adminMetricDetail({ cookies = {}, query = {} }) {
  const guard = requireAdmin(cookies);
  if (guard.error) return guard.error;
  const key = String(query.key || '');
  const def = METRIC_DEFS[key];
  if (!def) return err(404, '未知的指标');
  const db = getDb();
  const args = def.args ? def.args() : [];
  const countArgs = def.countArgs ? def.countArgs() : args;
  const total = def.countSql ? Number(db.prepare(def.countSql).get(...countArgs).n) : 0;
  const items = db.prepare(def.sql).all(...args);
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

module.exports = {
  register, login, logout, me,
  listWatchlist, addWatchlist, removeWatchlist, syncWatchlist, reorderWatchlist,
  listPositions, savePosition, removePositions, reorderPosition,
  getPortfolio, portfolioHistory, portfolioDaily, getQuotes,
  adminStats, adminUsers, adminUserDetail, adminDeleteUser, adminResetPassword, adminMetricDetail,
};
