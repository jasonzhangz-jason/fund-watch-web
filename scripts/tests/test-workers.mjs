/**
 * Cloudflare Workers 后端的本机可执行测试
 *   node scripts/test-workers.mjs
 *
 * 思路：把 Worker 当成普通 ES 模块直接调用 worker.fetch(request, env, ctx)，
 *   - env.DB 用 **node:sqlite** 实现的 D1 适配器（同 SQL 方言，能真跑 SQL）
 *   - env 只含 D1 绑定（**不使用 R2**：导出走现算下载）
 *   - 密码走 WebCrypto（Node 24 全局可用）
 * 因此不需要 Cloudflare 账号即可验证：路由、会话 Cookie、D1 读写、级联删除、PBKDF2、
 * CORS、数据导出、指标明细一致性等真实行为。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
/** Windows 下动态 import 必须用 file:// URL */
const workerUrl = new URL('../../backend/workers/src/index.js', import.meta.url).href;
const worker = (await import(workerUrl)).default;

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

/* ============================ 假 D1（node:sqlite 实现） ============================ */
const tmp = mkdtempSync(path.join(tmpdir(), 'workers-'));
const file = path.join(tmp, 'd1.db');
const sqlite = new DatabaseSync(file);
sqlite.exec('PRAGMA foreign_keys = ON;');

function makeD1(db) {
  const toObj = (row) => (row ? { ...row } : row);
  const bindArgs = (args) => args.map((v) => (v === undefined ? null : v));
  const stmt = (sql, bound = []) => ({
    bind: (...args) => stmt(sql, bindArgs(args)),
    first: async () => toObj(db.prepare(sql).get(...bound)),
    all: async () => ({ results: db.prepare(sql).all(...bound).map(toObj) }),
    run: async () => {
      const info = db.prepare(sql).run(...bound);
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => stmt(sql),
    async batch(list) {
      const out = [];
      for (const s of list) out.push(await s.run());
      return out;
    },
    exec: async (sql) => db.exec(sql),
  };
}


/* ============================ 环境与请求工具 ============================ */
const DB = makeD1(sqlite);
const env = {
  DB,
  ADMIN_USERNAME: 'root',
  ADMIN_PASSWORD: 'root',
  PBKDF2_ITERATIONS: '2000', // 测试用低迭代，生产默认 10w
  CORS_ORIGINS: '',
};
const BASE = 'https://api.example.com';

let cookie = '';
async function call(method, p, body, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie && !opts.noCookie) headers.Cookie = cookie;
  if (opts.origin) headers.Origin = opts.origin;
  const res = await worker.fetch(
    new Request(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
    {},
  );
  const setCookie = res.headers.get('Set-Cookie');
  if (setCookie) {
    const first = setCookie.split(';')[0];
    cookie = opts.keepCookie ? cookie : first;
  }
  let json = null;
  const ct = res.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) json = await res.json();
  // 二进制响应（如 gzip 备份）不能读正文，否则 body 被消费掉
  return { status: res.status, headers: res.headers, json, setCookie, res };
}

try {
  /* ---------------- 结构：migration SQL 可应用 ---------------- */
  console.log('\n【1】D1 迁移与健康检查');
  const migration = readFileSync(path.join(ROOT, 'backend/workers/migrations/0001_init.sql'), 'utf8');
  sqlite.exec(migration);
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  check('迁移创建了 7 张表', tables.length === 7, tables.join(','));
  check(
    '表名与 Node 端一致',
    ['account_daily', 'fund_quotes', 'position_daily', 'positions', 'sessions', 'users', 'watchlist'].every((t) => tables.includes(t)),
    tables.join(','),
  );

  const health = await call('GET', '/api/health');
  check('/api/health 返回 200', health.status === 200);
  check('标明运行时为 cloudflare-workers', health.json.runtime === 'cloudflare-workers', JSON.stringify(health.json));
  check('标明数据库为 cloudflare-d1', health.json.database === 'cloudflare-d1');
  check('不再声明对象存储（R2 已移除）', !('storage' in health.json), JSON.stringify(health.json));

  /* ---------------- CORS ---------------- */
  console.log('\n【2】CORS（跨域 + 凭据）');
  const pre = await call('OPTIONS', '/api/auth/login', undefined, { origin: 'https://fund.example.com' });
  check('预检返回 204', pre.status === 204, String(pre.status));
  check('回显 Origin', pre.headers.get('Access-Control-Allow-Origin') === 'https://fund.example.com', String(pre.headers.get('Access-Control-Allow-Origin')));
  check('允许凭据', pre.headers.get('Access-Control-Allow-Credentials') === 'true');
  const withOrigin = await call('GET', '/api/health', undefined, { origin: 'https://fund.example.com' });
  check('普通响应也带 CORS 头', withOrigin.headers.get('Access-Control-Allow-Origin') === 'https://fund.example.com');

  /* ---------------- 内置管理员 ---------------- */
  console.log('\n【3】内置管理员与 PBKDF2 密码');
  const rootLogin = await call('POST', '/api/auth/login', { username: 'root', password: 'root' });
  check('内置管理员可用 root/root 登录', rootLogin.status === 200 && rootLogin.json.user.role === 'admin', JSON.stringify(rootLogin.json));
  check('会话 Cookie 为 HttpOnly', /HttpOnly/.test(rootLogin.setCookie || ''), rootLogin.setCookie);
  check('HTTPS 下 Cookie 带 Secure', /Secure/.test(rootLogin.setCookie || ''), rootLogin.setCookie);
  check('默认 SameSite=Lax（同域部署）', /SameSite=Lax/.test(rootLogin.setCookie || ''), rootLogin.setCookie);

  // 分域部署开关：COOKIE_SAMESITE=None 时必须是 None + Secure
  env.COOKIE_SAMESITE = 'None';
  const crossSite = await call('POST', '/api/auth/login', { username: 'root', password: 'root' });
  check('COOKIE_SAMESITE=None 生效', /SameSite=None/.test(crossSite.setCookie || ''), crossSite.setCookie);
  check('SameSite=None 同时带 Secure', /SameSite=None.*Secure/.test(crossSite.setCookie || ''), crossSite.setCookie);
  // http 下 None 会被浏览器丢弃 → 自动回落 Lax
  const httpReq = await worker.fetch(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'root' }),
    }),
    env,
    {},
  );
  check(
    'http 下 SameSite=None 自动回落 Lax（避免被浏览器丢弃）',
    /SameSite=Lax/.test(httpReq.headers.get('Set-Cookie') || ''),
    httpReq.headers.get('Set-Cookie'),
  );
  delete env.COOKIE_SAMESITE;

  const rootRow = sqlite.prepare("SELECT * FROM users WHERE username='root'").get();
  check('密码哈希为 pbkdf2 格式', String(rootRow.password_hash).startsWith('pbkdf2$sha256$'), String(rootRow.password_hash).slice(0, 30));

  // 双运行时互认：Node 端 auth.cjs 能校验 Worker 生成的哈希
  const nodeAuth = require(path.join(ROOT, 'backend/server/auth.cjs'));
  check('Node 端可校验 Worker 生成的 PBKDF2 哈希（互认）', nodeAuth.verifyPassword('root', rootRow.salt, rootRow.password_hash) === true);
  check('Node 端对错误密码返回 false', nodeAuth.verifyPassword('wrong', rootRow.salt, rootRow.password_hash) === false);

  /* ---------------- 注册 / 登录 / 会话 ---------------- */
  console.log('\n【4】注册、登录、会话');
  const reg = await call('POST', '/api/auth/register', { username: 'alice', password: 'alice12345' });
  check('注册成功并下发会话', reg.status === 200 && Boolean(reg.setCookie), JSON.stringify(reg.json));
  const me = await call('GET', '/api/auth/me');
  check('/api/auth/me 返回当前用户', me.json.user && me.json.user.username === 'alice', JSON.stringify(me.json));
  check('响应不包含密码哈希/盐', !JSON.stringify(me.json).includes('password_hash') && !JSON.stringify(me.json).includes('salt'));

  const badLogin = await call('POST', '/api/auth/login', { username: 'alice', password: 'nope' }, { keepCookie: true });
  check('错误密码返回 401', badLogin.status === 401, String(badLogin.status));
  const shortPwd = await call('POST', '/api/auth/register', { username: 'bob', password: '123' }, { keepCookie: true });
  check('弱密码被拒绝 (400)', shortPwd.status === 400, JSON.stringify(shortPwd.json));
  const dup = await call('POST', '/api/auth/register', { username: 'alice', password: 'alice12345' }, { keepCookie: true });
  check('重复用户名返回 409', dup.status === 409, String(dup.status));

  // 重新以 alice 登录，继续后续用例
  await call('POST', '/api/auth/login', { username: 'alice', password: 'alice12345' });

  /* ---------------- 自选 ---------------- */
  console.log('\n【5】自选（D1 读写 + 排序）');
  const add1 = await call('POST', '/api/watchlist', { code: '161725', name: '招商中证白酒指数(LOF)A' });
  check('添加自选', add1.status === 200, JSON.stringify(add1.json));
  await call('POST', '/api/watchlist', { code: '006274', name: '圆信永丰医药健康A' });
  const list1 = await call('GET', '/api/watchlist');
  check('自选列表返回 2 条', list1.json.items.length === 2, JSON.stringify(list1.json.items));
  check('按 sort_order 升序返回', list1.json.items[0].code === '161725', JSON.stringify(list1.json.items.map((i) => i.code)));
  const reorder = await call('POST', '/api/watchlist/reorder', { code: '006274', dir: 'top' });
  check('置顶后顺序变化', reorder.json.order[0] === '006274', JSON.stringify(reorder.json.order));
  const delWatch = await call('DELETE', '/api/watchlist/161725');
  check('删除自选 removed=1', delWatch.json.removed === 1, JSON.stringify(delWatch.json));
  const badCode = await call('POST', '/api/watchlist', { code: '123', name: 'x' });
  check('非法基金代码被拒 (400)', badCode.status === 400, String(badCode.status));

  /* ---------------- 持仓 + 账本 ---------------- */
  console.log('\n【6】持仓与账本聚合（D1 落库）');
  const savePos = await call('POST', '/api/positions', { code: '161725', name: '招商中证白酒指数(LOF)A', amount: 10000, profit: 500 });
  check('保存持仓', savePos.status === 200, JSON.stringify(savePos.json));
  await call('POST', '/api/positions', { code: '006274', name: '圆信永丰医药健康A', amount: 4000, profit: -200 });
  const posList = await call('GET', '/api/positions');
  check('持仓列表 2 条', posList.json.items.length === 2, JSON.stringify(posList.json.items));
  const badAmount = await call('POST', '/api/positions', { code: '163406', name: 'x', amount: -5, profit: 0 });
  check('负数金额被拒 (400)', badAmount.status === 400, String(badAmount.status));

  const pf = await call('GET', '/api/portfolio');
  const p = pf.json.portfolio;
  check('账本账户资产 = 14000', Math.abs(p.totalAmount - 14000) < 0.01, String(p.totalAmount));
  check('持仓明细 2 条且含 rate 字段', p.items.length === 2 && p.items.some((i) => 'rate' in i), JSON.stringify(p.items.map((i) => i.rate)));
  check(
    '持仓收益率 = 收益/本金',
    Math.abs(p.items.find((i) => i.code === '161725').rate - (500 / (10000 - 500)) * 100) < 0.01,
    String(p.items.find((i) => i.code === '161725').rate),
  );
  const accDaily = sqlite.prepare('SELECT * FROM account_daily WHERE user_id = (SELECT id FROM users WHERE username=?)').all('alice');
  check('已写入 account_daily 快照', accDaily.length === 1 && Math.abs(accDaily[0].total_amount - 14000) < 0.01, JSON.stringify(accDaily));
  const posDaily = sqlite.prepare('SELECT * FROM position_daily WHERE user_id = (SELECT id FROM users WHERE username=?)').all('alice');
  check('已写入 position_daily 快照（2 行）', posDaily.length === 2, String(posDaily.length));

  const hist = await call('GET', '/api/portfolio/history?days=7');
  check('历史接口返回快照', hist.json.items.length === 1 && Boolean(hist.json.snapshot), JSON.stringify(hist.json.items));
  const daily = await call('GET', '/api/portfolio/daily?days=1');
  check('每日明细接口返回当日持仓', daily.json.items.length === 2, String(daily.json.items.length));

  /* ---------------- 行情缓存 ---------------- */
  console.log('\n【7】行情缓存（D1 fund_quotes）');
  const q1 = await call('GET', '/api/quotes?codes=161725');
  check('/api/quotes 返回行情', q1.status === 200 && q1.json.items.length === 1, JSON.stringify(q1.json).slice(0, 120));
  const cachedRows = sqlite.prepare('SELECT COUNT(*) AS n FROM fund_quotes').get();
  check('行情已写入 D1 缓存', Number(cachedRows.n) >= 1, String(cachedRows.n));

  /* ---------------- 穿透 / 相关性 ---------------- */
  console.log('\n【8】持仓穿透与相关性分析');
  const lt = await call('GET', '/api/portfolio/lookthrough');
  check('穿透接口 200', lt.status === 200 && Boolean(lt.json.lookthrough), JSON.stringify(lt.json).slice(0, 120));
  const ltv = lt.json.lookthrough;
  check('穿透含覆盖率与个股', typeof ltv.coverage === 'number' && Array.isArray(ltv.items), JSON.stringify({ cov: ltv.coverage, n: ltv.items.length }));
  if (ltv.items.length) {
    const top = ltv.items[0];
    check('个股含涉及基金明细', Array.isArray(top.funds) && top.funds.length > 0, JSON.stringify(top).slice(0, 140));
    check(
      '个股金额 = Σ 各基金贡献',
      Math.abs(top.amount - top.funds.reduce((s, f) => s + f.amount, 0)) < 0.02,
      `${top.amount}`,
    );
  }
  const corr = await call('GET', '/api/portfolio/correlation?days=30');
  check('相关性接口 200', corr.status === 200 && Boolean(corr.json.correlation), JSON.stringify(corr.json).slice(0, 120));
  const cv = corr.json.correlation;
  check('相关性矩阵为 2×2 且对角线为 1', cv.matrix.length === 2 && cv.matrix[0][0] === 1 && cv.matrix[1][1] === 1, JSON.stringify(cv.matrix));
  check('矩阵对称', cv.matrix.length === 2 && cv.matrix[0][1] === cv.matrix[1][0]);
  check('给出共同交易日区间', Boolean(cv.startDate) && cv.pointCount > 3, `${cv.startDate} (${cv.pointCount} 点)`);

  /* ---------------- 管理端 ---------------- */
  console.log('\n【9】管理端（统计 / 用户 / 指标 / 密码重置 / 级联删除）');
  await call('POST', '/api/auth/login', { username: 'root', password: 'root' });
  const stats = await call('GET', '/api/admin/stats');
  check('运营统计 200', stats.status === 200 && stats.json.stats.users >= 2, JSON.stringify(stats.json.stats));
  check('统计含 Cloudflare 运行时标识', stats.json.stats.runtime === 'cloudflare-workers');
  const users = await call('GET', '/api/admin/users');
  check('用户列表返回 2 人', users.json.total === 2, JSON.stringify(users.json.items.map((i) => i.username)));
  const aliceRow = users.json.items.find((i) => i.username === 'alice');
  check('alice 自选数为数字', typeof aliceRow.fundCount === 'number', JSON.stringify(aliceRow));

  // 指标明细一致性
  const keys = ['users', 'admins', 'activeSessions', 'watchlistItems', 'usersWithWatchlist', 'positionsItems', 'usersWithPositions', 'quotesCached', 'snapshotDays', 'positionDailyRows'];
  const mismatch = [];
  for (const k of keys) {
    const r = await call('GET', `/api/admin/metrics/${k}`);
    if (!r.json || !r.json.ok) mismatch.push(`${k}: 请求失败`);
    else if (r.json.total !== stats.json.stats[k]) mismatch.push(`${k}: ${r.json.total} vs ${stats.json.stats[k]}`);
  }
  check('10 个指标明细总数与统计一致', mismatch.length === 0, mismatch.join('; '));
  check('未知指标返回 404', (await call('GET', '/api/admin/metrics/nope')).status === 404);

  // 密码重置：旧密码失效、新密码可登录、旧会话失效
  const reset = await call('POST', `/api/admin/users/${aliceRow.id}`, { action: 'resetPassword', password: 'newpass123' });
  check('重置密码成功', reset.status === 200 && reset.json.reset === true, JSON.stringify(reset.json));
  const oldPwd = await call('POST', '/api/auth/login', { username: 'alice', password: 'alice12345' }, { keepCookie: true });
  check('旧密码失效 (401)', oldPwd.status === 401, String(oldPwd.status));
  const newPwd = await call('POST', '/api/auth/login', { username: 'alice', password: 'newpass123' }, { keepCookie: true });
  check('新密码可登录', newPwd.status === 200, String(newPwd.status));
  const sessionsLeft = sqlite.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = (SELECT id FROM users WHERE username='alice')").get();
  check('重置后仅保留新会话', Number(sessionsLeft.n) === 1, String(sessionsLeft.n));

  // 数据导出（不用 R2：现算再下载）
  console.log('\n【10】数据导出（现算 NDJSON.gz 直接下载，无对象存储）');
  // 先以 root 身份
  await call('POST', '/api/auth/login', { username: 'root', password: 'root' });
  const dump = await call('GET', '/api/admin/backup');
  check('导出返回 200 gzip 流', dump.status === 200 && dump.headers.get('Content-Encoding') === 'gzip');
  check(
    '响应头给出下载文件名',
    /attachment; filename="fund-watch-.+\.ndjson\.gz"/.test(dump.headers.get('Content-Disposition') || ''),
    dump.headers.get('Content-Disposition'),
  );
  const ndjson = await new Response(dump.res.body.pipeThrough(new DecompressionStream('gzip'))).text();
  const lines = ndjson.trim().split('\n');
  check('解压后可解析为 NDJSON', lines.length > 0 && lines.every((l) => JSON.parse(l).table), `${lines.length} 行`);
  const dumped = lines.map((l) => JSON.parse(l));
  const dumpedUsers = dumped.filter((o) => o.table === 'users');
  check('导出包含用户表数据', dumpedUsers.length >= 2, String(dumpedUsers.length));
  check('导出覆盖全部 7 张表', new Set(dumped.map((o) => o.table)).size === 7, [...new Set(dumped.map((o) => o.table))].join(','));
  const rowsHeader = Number(dump.headers.get('X-Dump-Rows'));
  check('响应头行数与实际一致', rowsHeader === dumped.length, `${rowsHeader} vs ${dumped.length}`);
  check('导出不写任何持久存储（无 R2 绑定）', env.BACKUPS === undefined);
  check('旧的备份列表接口已移除 (404)', (await call('GET', '/api/admin/backups')).status === 404);
  check('旧的按 key 下载接口已移除 (404)', (await call('GET', '/api/admin/backup/backups-x')).status === 404);

  // 级联删除
  console.log('\n【11】级联删除（D1 外键）');
  const del = await call('DELETE', `/api/admin/users/${aliceRow.id}`);
  check('删除用户成功', del.status === 200 && del.json.username === 'alice', JSON.stringify(del.json));
  const cnt = (sql) => Number(sqlite.prepare(sql).get().n);
  check('自选已级联删除', cnt("SELECT COUNT(*) AS n FROM watchlist WHERE user_id = " + aliceRow.id) === 0);
  check('持仓已级联删除', cnt("SELECT COUNT(*) AS n FROM positions WHERE user_id = " + aliceRow.id) === 0);
  check('会话已级联删除', cnt("SELECT COUNT(*) AS n FROM sessions WHERE user_id = " + aliceRow.id) === 0);
  check('每日快照已级联删除', cnt("SELECT COUNT(*) AS n FROM position_daily WHERE user_id = " + aliceRow.id) === 0);
  check('账户快照已级联删除', cnt("SELECT COUNT(*) AS n FROM account_daily WHERE user_id = " + aliceRow.id) === 0);
  const rootRow2 = (await call('GET', '/api/admin/users')).json.items.find((i) => i.username === 'root');
  check('拒绝删除管理员 (400)', (await call('DELETE', `/api/admin/users/${rootRow2.id}`)).status === 400);

  // 权限
  console.log('\n【12】权限与错误处理');
  await call('POST', '/api/auth/register', { username: 'carol', password: 'carol12345' }, { keepCookie: true });
  const carolLogin = await call('POST', '/api/auth/login', { username: 'carol', password: 'carol12345' });
  check('普通用户登录成功', carolLogin.status === 200);
  check('普通用户访问统计被拒 (403)', (await call('GET', '/api/admin/stats')).status === 403);
  check('普通用户访问数据导出被拒 (403)', (await call('GET', '/api/admin/backup')).status === 403);
  const noCookie = await call('GET', '/api/portfolio', undefined, { noCookie: true, headers: { Cookie: '' } });
  check('未登录访问账本被拒 (401)', noCookie.status === 401, String(noCookie.status));
  check('未知路径返回 404', (await call('GET', '/api/nope')).status === 404);
  question: {
    const logout = await call('POST', '/api/auth/logout');
    check('登出清空 Cookie', /fw_session=;/.test(logout.setCookie || ''), logout.setCookie);
  }

  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
} catch (e) {
  console.error('测试异常:', e.message, e.stack?.split('\n')[1] || '');
  fail++;
} finally {
  try {
    sqlite.close();
  } catch {
    /* 忽略 */
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}
process.exit(fail === 0 ? 0 : 1);
