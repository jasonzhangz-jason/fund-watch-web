/**
 * 基金助手 · Cloudflare Worker（后端 API）
 *
 * 路由与 Node/Vercel 版完全一致（api/*.js），前端无需改代码即可切换部署目标：
 *   /api/health                    健康检查
 *   /api/auth/*                    注册 / 登录 / 登出 / 当前用户（HttpOnly Cookie 会话）
 *   /api/watchlist*                自选增删查 + 排序
 *   /api/positions*                持仓增删改查 + 排序
 *   /api/portfolio*                账本聚合 / 历史 / 每日明细 / 持仓穿透 / 相关性分析
 *   /api/quotes                    批量行情（D1 缓存 60s）
 *   /api/search /api/nav /api/estimate /api/detail /api/holdings   公开行情代理
 *   /api/admin/*                   运营统计、用户管理、指标明细、**数据导出（下载）**
 *
 * 数据：Cloudflare D1（异步）；密码：WebCrypto PBKDF2-SHA256；不使用对象存储（无 R2）
 */
import { one, all, run, err, ok, nowIso } from './db.js';
import {
  SESSION_COOKIE,
  SESSION_DAYS,
  hashPassword,
  verifyPassword,
  iterationsOf,
  randomToken,
  sha256Hex,
  validateCredentials,
  validateFundCode,
  publicUser,
  parseCookies,
  sessionCookie,
  clearCookie,
} from './auth.js';
import { getQuotes, estimateOf, navListOf, getHoldings } from './upstream.js';
import { buildPortfolio, getHistory, getPositionDaily, getSnapshot, buildLookthrough, buildCorrelation } from './portfolio.js';
import {
  requireAdmin,
  adminStats,
  adminUsers,
  adminUserDetail,
  adminDeleteUser,
  adminResetPassword,
  adminMetricDetail,
  exportResponse,
} from './admin.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const SEARCH_URL = 'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx';

/* ============================ CORS ============================ */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowList = String((env && env.CORS_ORIGINS) || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowed = origin && (allowList.length === 0 || allowList.includes(origin));
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowed) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

const jsonResponse = (result, extra = {}) =>
  new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(result.headers || {}), ...extra },
  });

/* ============================ 会话 ============================ */
async function currentUser(env, cookies) {
  const token = cookies[SESSION_COOKIE];
  if (!token || String(token).length !== 64) return null;
  const hash = await sha256Hex(token);
  return one(
    env.DB,
    `SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    hash,
    nowIso(),
  );
}

async function createSession(env, userId) {
  await run(env.DB, 'DELETE FROM sessions WHERE expires_at <= ?', nowIso());
  const token = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400_000);
  await run(
    env.DB,
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    await sha256Hex(token),
    userId,
    now.toISOString(),
    expires.toISOString(),
  );
  return token;
}

async function destroySession(env, cookieToken) {
  if (!cookieToken) return;
  await run(env.DB, 'DELETE FROM sessions WHERE token_hash = ?', await sha256Hex(cookieToken));
}

/* ============================ 内置管理员（懒初始化） ============================ */
let seeded = false;
async function ensureAdminSeed(env) {
  if (seeded) return;
  seeded = true;
  const username = env.ADMIN_USERNAME || 'root';
  const password = env.ADMIN_PASSWORD || 'root';
  const existing = await one(env.DB, 'SELECT * FROM users WHERE username = ?', username);
  if (!existing) {
    const { hash, salt } = await hashPassword(password, iterationsOf(env));
    await run(
      env.DB,
      'INSERT INTO users (username, password_hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?)',
      username,
      hash,
      salt,
      'admin',
      nowIso(),
    );
  } else if (existing.role !== 'admin') {
    await run(env.DB, "UPDATE users SET role = 'admin' WHERE id = ?", existing.id);
  }
}

/* ============================ 账号路由 ============================ */
async function authRoute(request, env, action, body, cookies) {
  const iterations = iterationsOf(env);
  const secure = new URL(request.url).protocol === 'https:';

  if (action === 'register' && request.method === 'POST') {
    const { username, password } = body || {};
    const invalid = validateCredentials(username, password);
    if (invalid) return err(400, invalid);
    const exists = await one(env.DB, 'SELECT id FROM users WHERE username = ?', username);
    if (exists) return err(409, '该用户名已被注册');
    const { hash, salt } = await hashPassword(password, iterations);
    const now = nowIso();
    const ins = await run(
      env.DB,
      'INSERT INTO users (username, password_hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?)',
      username,
      hash,
      salt,
      'user',
      now,
    );
    const token = await createSession(env, ins.lastRowId);
    return ok(
      { user: { id: ins.lastRowId, username, role: 'user', created_at: now } },
      { 'Set-Cookie': sessionCookie(token, secure) },
    );
  }

  if (action === 'login' && request.method === 'POST') {
    const { username, password } = body || {};
    if (!username || !password) return err(400, '请输入用户名和密码');
    const user = await one(env.DB, 'SELECT * FROM users WHERE username = ?', String(username));
    const passOk = user ? await verifyPassword(password, user.salt, user.password_hash, iterations) : false;
    if (!user || !passOk) return err(401, '用户名或密码不正确');
    const token = await createSession(env, user.id);
    return ok({ user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token, secure) });
  }

  if (action === 'logout' && request.method === 'POST') {
    await destroySession(env, cookies[SESSION_COOKIE]);
    return ok({ user: null }, { 'Set-Cookie': clearCookie(secure) });
  }

  if (action === 'me' && request.method === 'GET') {
    const user = await currentUser(env, cookies);
    return ok({ user: publicUser(user) });
  }
  return err(404, '未知的认证接口');
}

/* ============================ 自选 / 持仓 ============================ */
async function watchlistRoute(request, env, url, body, user) {
  if (!user) return err(401, '请先登录');
  const seg = url.pathname.replace('/api/watchlist', '');

  if (seg === '' && request.method === 'GET') {
    const rows = await all(
      env.DB,
      'SELECT code, name, sort_order, created_at FROM watchlist WHERE user_id = ? ORDER BY sort_order ASC, id ASC',
      user.id,
    );
    return ok({ items: rows.map((r) => ({ code: r.code, name: r.name, sort: r.sort_order, createdAt: r.created_at })) });
  }

  if (seg === '' && request.method === 'POST') {
    // 批量同步（body.items）或单条新增（body.code）
    const now = nowIso();
    if (Array.isArray(body && body.items)) {
      const items = body.items.slice(0, 200);
      let n = 0;
      for (const it of items) {
        const code = String((it && it.code) || '').trim();
        if (!/^\d{6}$/.test(code)) continue;
        const name = String((it && it.name) || '').trim().slice(0, 60);
        await run(
          env.DB,
          `INSERT INTO watchlist (user_id, code, name, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, code) DO UPDATE SET name = excluded.name`,
          user.id,
          code,
          name,
          now,
        );
        n += 1;
      }
      return ok({ synced: n });
    }
    const code = String((body && body.code) || '').trim();
    const invalid = validateFundCode(code);
    if (invalid) return err(400, invalid);
    const name = String((body && body.name) || '').trim().slice(0, 60);
    const max = await one(env.DB, 'SELECT COALESCE(MAX(sort_order), 0) AS m FROM watchlist WHERE user_id = ?', user.id);
    await run(
      env.DB,
      `INSERT INTO watchlist (user_id, code, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, code) DO UPDATE SET name = excluded.name`,
      user.id,
      code,
      name,
      Number((max && max.m) || 0) + 1,
      now,
    );
    return ok({ code, name });
  }

  if (seg === '/reorder' && request.method === 'POST') {
    const code = String((body && body.code) || '').trim();
    const dir = String((body && body.dir) || '');
    if (!/^\d{6}$/.test(code) || !['top', 'up', 'down'].includes(dir)) return err(400, '参数无效');
    const rows = (
      await all(env.DB, 'SELECT code FROM watchlist WHERE user_id = ? ORDER BY sort_order ASC, id ASC', user.id)
    ).map((r) => r.code);
    const idx = rows.indexOf(code);
    if (idx < 0) return err(404, '自选不存在');
    rows.splice(idx, 1);
    if (dir === 'top') rows.unshift(code);
    else if (dir === 'up') rows.splice(Math.max(0, idx - 1), 0, code);
    else rows.splice(Math.min(rows.length, idx + 1), 0, code);
    for (let i = 0; i < rows.length; i += 1) {
      await run(env.DB, 'UPDATE watchlist SET sort_order = ? WHERE user_id = ? AND code = ?', i, user.id, rows[i]);
    }
    return ok({ order: rows });
  }

  const m = seg.match(/^\/(\d{6})$/);
  if (m && request.method === 'DELETE') {
    const res = await run(env.DB, 'DELETE FROM watchlist WHERE user_id = ? AND code = ?', user.id, m[1]);
    return ok({ code: m[1], removed: res.changes });
  }
  return err(404, '未知的自选接口');
}

async function positionsRoute(request, env, url, body, user) {
  if (!user) return err(401, '请先登录');
  const seg = url.pathname.replace('/api/positions', '');

  if (seg === '' && request.method === 'GET') {
    const rows = await all(
      env.DB,
      'SELECT code, name, amount, profit FROM positions WHERE user_id = ? ORDER BY sort_order ASC, id ASC',
      user.id,
    );
    return ok({ items: rows.map((r) => ({ code: r.code, name: r.name, amount: r.amount, profit: r.profit })) });
  }

  if (seg === '' && request.method === 'POST') {
    const code = String((body && body.code) || '').trim();
    const invalid = validateFundCode(code);
    if (invalid) return err(400, invalid);
    const name = String((body && body.name) || '').trim().slice(0, 60);
    const amount = Number(body && body.amount);
    const profit = Number(body && body.profit);
    if (!Number.isFinite(amount) || amount < 0) return err(400, '持有金额需为不小于 0 的数字');
    if (!Number.isFinite(profit)) return err(400, '持有收益需为数字');
    const max = await one(env.DB, 'SELECT COALESCE(MAX(sort_order), 0) AS m FROM positions WHERE user_id = ?', user.id);
    await run(
      env.DB,
      `INSERT INTO positions (user_id, code, name, amount, profit, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, code) DO UPDATE SET
         name = excluded.name, amount = excluded.amount, profit = excluded.profit`,
      user.id,
      code,
      name,
      amount,
      profit,
      Number((max && max.m) || 0) + 1,
      nowIso(),
    );
    return ok({ code, name, amount, profit });
  }

  if (seg === '' && request.method === 'DELETE') {
    const raw =
      url.searchParams.get('codes') ||
      (body && (Array.isArray(body.codes) ? body.codes.join(',') : body.codes)) ||
      (body && body.code) ||
      '';
    const codes = String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d{6}$/.test(s));
    if (!codes.length) return err(400, '缺少要删除的基金代码');
    let removed = 0;
    for (const c of codes) {
      const res = await run(env.DB, 'DELETE FROM positions WHERE user_id = ? AND code = ?', user.id, c);
      removed += res.changes;
    }
    return ok({ removed, codes });
  }

  if (seg === '/reorder' && request.method === 'POST') {
    const code = String((body && body.code) || '').trim();
    const dir = String((body && body.dir) || '');
    if (!/^\d{6}$/.test(code) || !['top', 'up', 'down'].includes(dir)) return err(400, '参数无效');
    const rows = (
      await all(env.DB, 'SELECT code FROM positions WHERE user_id = ? ORDER BY sort_order ASC, id ASC', user.id)
    ).map((r) => r.code);
    const idx = rows.indexOf(code);
    if (idx < 0) return err(404, '持仓不存在');
    rows.splice(idx, 1);
    if (dir === 'top') rows.unshift(code);
    else if (dir === 'up') rows.splice(Math.max(0, idx - 1), 0, code);
    else rows.splice(Math.min(rows.length, idx + 1), 0, code);
    for (let i = 0; i < rows.length; i += 1) {
      await run(env.DB, 'UPDATE positions SET sort_order = ? WHERE user_id = ? AND code = ?', i, user.id, rows[i]);
    }
    return ok({ order: rows });
  }
  return err(404, '未知的持仓接口');
}

/* ============================ 账本与衍生分析 ============================ */
async function portfolioRoute(request, env, url, user) {
  if (!user) return err(401, '请先登录');
  const seg = url.pathname.replace('/api/portfolio', '');

  if (seg === '' && request.method === 'GET') {
    const force = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
    return ok({ portfolio: await buildPortfolio(env.DB, user.id, { force }) });
  }
  if (seg === '/history' && request.method === 'GET') {
    const days = url.searchParams.get('days');
    return ok({
      items: await getHistory(env.DB, user.id, days),
      snapshot: await getSnapshot(env.DB, user.id),
    });
  }
  if (seg === '/daily' && request.method === 'GET') {
    return ok({
      items: await getPositionDaily(env.DB, user.id, {
        date: url.searchParams.get('date'),
        days: url.searchParams.get('days'),
      }),
    });
  }
  if (seg === '/lookthrough' && request.method === 'GET') {
    const force = url.searchParams.get('refresh') === '1';
    return ok({ lookthrough: await buildLookthrough(env.DB, user.id, { force }) });
  }
  if (seg === '/correlation' && request.method === 'GET') {
    const force = url.searchParams.get('refresh') === '1';
    return ok({
      correlation: await buildCorrelation(env.DB, user.id, { window: url.searchParams.get('days'), force }),
    });
  }
  return err(404, '未知的账本接口');
}

/* ============================ 公开行情代理 ============================ */
function mapSearchDatas(datas) {
  return (datas || []).map((d) => ({
    code: d.CODE,
    name: d.NAME,
    shortName: d.SHORTNAME || d.NAME,
    pinyin: d.JP || '',
    category: d.CATEGORYDESC || '',
    categoryId: d.CATEGORY,
    fundType: (d.FundBaseInfo && d.FundBaseInfo.FTYPE) || '',
    marketFlag: d.MARKET || '',
  }));
}

async function searchProxy(url) {
  const key = String(url.searchParams.get('key') || '').trim();
  if (!key) return err(400, '缺少 key 参数');
  const r = await fetch(`${SEARCH_URL}?m=1&key=${encodeURIComponent(key)}`, {
    headers: { 'User-Agent': UA, Referer: 'https://fund.eastmoney.com/', Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) return err(502, `upstream http ${r.status}`);
  const data = await r.json();
  if (data.ErrCode !== 0) return err(502, `上游错误: ${data.ErrMsg || data.ErrCode}`);
  const items = mapSearchDatas(data.Datas);
  return ok({ key, total: items.length, items });
}

function pick(js, key) {
  const m = js.match(new RegExp(`var\\s+${key}\\s*=\\s*"([^"]*)"`));
  if (m) return m[1];
  const n = js.match(new RegExp(`var\\s+${key}\\s*=\\s*([^;]+);`));
  return n ? n[1].trim() : undefined;
}

function pickArray(js, key) {
  const m = js.match(new RegExp(`var\\s+${key}\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;`));
  if (!m) return [];
  try {
    return JSON.parse(m[1]);
  } catch {
    return [];
  }
}

async function detailProxy(url) {
  const code = String(url.searchParams.get('code') || '').trim();
  if (!/^\d{6}$/.test(code)) return err(400, '基金代码须为6位数字');
  const r = await fetch(`https://fund.eastmoney.com/pingzhongdata/${code}.js?rt=${Date.now()}`, {
    headers: { 'User-Agent': UA, Referer: `https://fund.eastmoney.com/${code}.html` },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) return err(502, `upstream http ${r.status}`);
  const js = await r.text();
  const name = pick(js, 'fS_name') || code;
  const trendRaw = pickArray(js, 'Data_netWorthTrend');
  if (!trendRaw.length) return ok({ code, name, found: false, trend: [] });
  const num = (v) => (v === undefined || v === '' ? null : Number(v));
  const trend = trendRaw.slice(-240).map((p) => ({
    date: new Date(p.x).toISOString().slice(0, 10),
    nav: p.y,
    equityReturn: p.equityReturn,
  }));
  return ok({
    code,
    name,
    found: true,
    rate: pick(js, 'fund_Rate'),
    sourceRate: pick(js, 'fund_sourceRate'),
    minsg: pick(js, 'fund_minsg'),
    metrics: {
      m1: num(pick(js, 'syl_1y')),
      m6: num(pick(js, 'syl_6y')),
      y1: num(pick(js, 'syl_1n')),
      y3: num(pick(js, 'syl_3y')),
    },
    latestNav: trendRaw[trendRaw.length - 1].y,
    latestDate: new Date(trendRaw[trendRaw.length - 1].x).toISOString().slice(0, 10),
    trend,
  });
}

async function marketRoute(request, env, url) {
  const p = url.pathname;
  const codesOf = (raw) =>
    String(raw || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d{6}$/.test(s));

  if (p === '/api/search') return searchProxy(url);

  if (p === '/api/estimate') {
    const codes = codesOf(url.searchParams.get('codes') || url.searchParams.get('code'));
    if (!codes.length) return err(400, '缺少 codes 参数（逗号分隔的6位基金代码）');
    const EMPTY = (code) => ({ available: false, code, name: '', gsz: '', gszzl: '', gztime: '', dwjz: '', jzrq: '' });
    const items = await Promise.all(codes.map((c) => estimateOf(c).catch(() => EMPTY(c))));
    return ok({ items });
  }

  if (p === '/api/nav') {
    const code = String(url.searchParams.get('code') || '').trim();
    if (!/^\d{6}$/.test(code)) return err(400, '基金代码须为6位数字');
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const size = Math.min(parseInt(url.searchParams.get('size') || '20', 10), 100);
    const { total, items } = await navListOf(code, page, size);
    return ok({ code, total, page, size, items });
  }

  if (p === '/api/detail') return detailProxy(url);

  if (p === '/api/holdings') {
    const code = String(url.searchParams.get('code') || '').trim();
    if (!/^\d{6}$/.test(code)) return err(400, '基金代码须为6位数字');
    const force = url.searchParams.get('refresh') === '1';
    const r = await getHoldings(code, { force });
    if (r.error) return err(502, r.error);
    return ok({ code: r.code, date: r.date, quarter: r.quarter, items: r.items });
  }

  return err(404, '未知的行情接口');
}

/* ============================ 主入口 ============================ */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (!path.startsWith('/api/')) {
      return jsonResponse(err(404, `未知路径：${path}（静态页面由 Cloudflare Pages 提供）`), cors);
    }

    try {
      await ensureAdminSeed(env);

      const cookies = parseCookies(request.headers.get('Cookie') || '');
      let body = {};
      if (request.method === 'POST' || request.method === 'DELETE') {
        body = await request.json().catch(() => ({}));
      }

      /* ---- 健康检查（公开） ---- */
      if (path === '/api/health') {
        const dbInfo = {
          users: await one(env.DB, 'SELECT COUNT(*) AS n FROM users').then((r) => Number((r && r.n) || 0)),
          admins: await one(env.DB, "SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").then((r) => Number((r && r.n) || 0)),
        };
        return jsonResponse(
          ok({
            service: 'fund-watch-web',
            runtime: 'cloudflare-workers',
            database: 'cloudflare-d1',
            time: nowIso(),
            db: dbInfo,
          }),
          { ...cors, 'Cache-Control': 'no-store' },
        );
      }

      /* ---- 认证 ---- */
      const authMatch = path.match(/^\/api\/auth\/(\w+)$/);
      if (authMatch) return jsonResponse(await authRoute(request, env, authMatch[1], body, cookies), cors);

      /* ---- 需要会话的接口 ---- */
      const user = await currentUser(env, cookies);

      if (path === '/api/watchlist' || path.startsWith('/api/watchlist/')) {
        return jsonResponse(await watchlistRoute(request, env, url, body, user), cors);
      }
      if (path === '/api/positions' || path.startsWith('/api/positions/')) {
        return jsonResponse(await positionsRoute(request, env, url, body, user), cors);
      }
      if (path === '/api/portfolio' || path.startsWith('/api/portfolio/')) {
        return jsonResponse(await portfolioRoute(request, env, url, user), cors);
      }
      if (path === '/api/quotes' && request.method === 'GET') {
        if (!user) return jsonResponse(err(401, '请先登录'), cors);
        const codes = String(url.searchParams.get('codes') || '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => /^\d{6}$/.test(s));
        const force = url.searchParams.get('refresh') === '1';
        const map = await getQuotes(env.DB, codes, { force });
        return jsonResponse(ok({ items: [...map.values()] }), cors);
      }

      /* ---- 管理端 ---- */
      if (path.startsWith('/api/admin/')) {
        const guard = await requireAdmin(env.DB, user);
        if (guard.error) return jsonResponse(guard.error, cors);

        if (path === '/api/admin/stats' && request.method === 'GET') return jsonResponse(await adminStats(env.DB), cors);
        if (path === '/api/admin/users' && request.method === 'GET') {
          return jsonResponse(await adminUsers(env.DB, Object.fromEntries(url.searchParams)), cors);
        }
        const metricMatch = path.match(/^\/api\/admin\/metrics\/([A-Za-z]+)$/);
        if (metricMatch && request.method === 'GET') {
          return jsonResponse(await adminMetricDetail(env.DB, metricMatch[1]), cors);
        }
        const userMatch = path.match(/^\/api\/admin\/users\/(\d+)$/);
        if (userMatch) {
          const id = userMatch[1];
          if (request.method === 'GET') return jsonResponse(await adminUserDetail(env.DB, id), cors);
          if (request.method === 'DELETE') return jsonResponse(await adminDeleteUser(env.DB, id, user.id), cors);
          if (request.method === 'POST' && body && body.action === 'resetPassword') {
            return jsonResponse(await adminResetPassword(env.DB, id, body.password, iterationsOf(env)), cors);
          }
        }

        /* ---- 数据导出（现算再下载，不落任何存储；跨域时暴露下载文件名） ---- */
        if (path === '/api/admin/backup' && request.method === 'GET') {
          const res = await exportResponse(env.DB);
          for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
          res.headers.set('Access-Control-Expose-Headers', 'Content-Disposition, X-Dump-Tables, X-Dump-Rows');
          return res;
        }
        return jsonResponse(err(404, '未知的管理接口'), cors);
      }

      /* ---- 公开行情 ---- */
      if (['/api/search', '/api/estimate', '/api/nav', '/api/detail', '/api/holdings'].includes(path)) {
        return jsonResponse(await marketRoute(request, env, url), cors);
      }

      return jsonResponse(err(404, `未知接口：${path}`), cors);
    } catch (e) {
      return jsonResponse(err(500, `服务器错误：${e && e.message ? e.message : 'unknown'}`), cors);
    }
  },
};
