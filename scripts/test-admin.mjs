// 后台管理端到端测试：内置 root/root、权限控制、用户与自选查看、删除/重置密码
// 运行：node scripts/test-admin.mjs
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(path.join(tmpdir(), 'fundwatch-admin-'));
const DB = path.join(tmp, 'admin.db');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

const server = spawn(process.execPath, ['scripts/dev-server.mjs', '--no-qr'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), DB_PATH: DB }, stdio: 'ignore',
});

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.cookie) headers.Cookie = this.cookie;
    const r = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = /Max-Age=0/.test(sc) ? '' : sc.split(';')[0];
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  }
}

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log('\n【内置管理员 root/root】');
  const admin = new Client();
  let r = await admin.req('POST', '/api/auth/login', { username: 'root', password: 'root' });
  check('root/root 可直接登录', r.status === 200 && r.body.user?.username === 'root', JSON.stringify(r.body));
  check('登录返回 role=admin', r.body.user?.role === 'admin', JSON.stringify(r.body.user));
  r = await admin.req('GET', '/api/auth/me');
  check('me 显示管理员身份', r.body.user?.role === 'admin');
  r = await admin.req('POST', '/api/auth/login', { username: 'root', password: 'wrong' });
  check('root 错误密码被拒', r.status === 401);

  console.log('\n【普通用户无后台权限】');
  const u1 = new Client();
  r = await u1.req('POST', '/api/auth/register', { username: 'alice', password: 'alice12345' });
  check('注册普通用户 alice', r.status === 200 && r.body.user?.role === 'user');
  r = await u1.req('GET', '/api/admin/stats');
  check('普通用户访问后台统计被拒 (403)', r.status === 403, JSON.stringify(r.body));
  r = await u1.req('GET', '/api/admin/users');
  check('普通用户访问用户列表被拒 (403)', r.status === 403);
  const anon = new Client();
  r = await anon.req('GET', '/api/admin/users');
  check('未登录访问用户列表被拒 (401)', r.status === 401);

  console.log('\n【用户添加自选 → 后台可见】');
  await u1.req('POST', '/api/watchlist', { code: '161725', name: '招商中证白酒指数(LOF)A' });
  await u1.req('POST', '/api/watchlist', { code: '000001', name: '华夏成长混合' });
  const u2 = new Client();
  await u2.req('POST', '/api/auth/register', { username: 'bob', password: 'bob123456' });
  await u2.req('POST', '/api/watchlist', { code: '110022', name: '易方达消费行业' });

  r = await admin.req('GET', '/api/admin/stats');
  const st = r.body.stats;
  check('统计：用户数 3（root+alice+bob）', st.users === 3, JSON.stringify(st));
  check('统计：管理员 1', st.admins === 1, JSON.stringify(st));
  check('统计：自选总条数 3', st.watchlistItems === 3, JSON.stringify(st));
  check('统计：有自选的用户 2', st.usersWithWatchlist === 2, JSON.stringify(st));
  check('统计：持仓条数为数字（运营数据）', typeof st.positionsItems === 'number', JSON.stringify(st));
  check('统计：行情缓存条数为数字', typeof st.quotesCached === 'number', JSON.stringify(st));
  check('统计：快照天数 + 最新快照日期字段存在', typeof st.snapshotDays === 'number' && 'latestSnapshot' in st, JSON.stringify(st));
  check('统计：每日明细行数为数字', typeof st.positionDailyRows === 'number', JSON.stringify(st));
  check('统计：活跃会话为数字', typeof st.activeSessions === 'number', JSON.stringify(st));

  r = await admin.req('GET', '/api/admin/users');
  check('用户列表返回 3 条', r.status === 200 && r.body.total === 3, JSON.stringify(r.body));
  const alice = r.body.items.find((x) => x.username === 'alice');
  check('alice 自选数 = 2', alice && alice.fundCount === 2, JSON.stringify(alice));
  check('alice 无管理角色', alice?.role === 'user');
  check('列表不含密码字段', !JSON.stringify(r.body).includes('password_hash') && !JSON.stringify(r.body).includes('salt'));

  r = await admin.req('GET', `/api/admin/users/${alice.id}`);
  check('查看 alice 自选明细（2 条）', r.status === 200 && r.body.funds.length === 2, JSON.stringify(r.body));
  check('自选内容正确', r.body.funds.map((f) => f.code).join(',') === '161725,000001', JSON.stringify(r.body.funds));

  r = await admin.req('GET', '/api/admin/users?q=bob');
  check('按用户名搜索生效', r.body.total === 1 && r.body.items[0].username === 'bob', JSON.stringify(r.body));

  console.log('\n【后台操作：重置密码 / 删除用户】');
  r = await admin.req('POST', `/api/admin/users/${alice.id}`, { action: 'resetPassword', password: 'newpass123' });
  check('重置 alice 密码成功', r.status === 200 && r.body.reset === true, JSON.stringify(r.body));
  const aliceOld = new Client();
  r = await aliceOld.req('POST', '/api/auth/login', { username: 'alice', password: 'alice12345' });
  check('旧密码已失效 (401)', r.status === 401);
  r = await aliceOld.req('POST', '/api/auth/login', { username: 'alice', password: 'newpass123' });
  check('新密码可登录', r.status === 200);
  r = await u1.req('GET', '/api/watchlist');
  check('重置后旧会话失效（alice 原会话拿到 401）', r.status === 401, JSON.stringify(r.body));

  const rootRow = (await admin.req('GET', '/api/admin/users')).body.items.find((x) => x.username === 'root');
  r = await admin.req('DELETE', `/api/admin/users/${rootRow.id}`);
  check('拒绝删除管理员账号 (400)', r.status === 400, JSON.stringify(r.body));

  /* ---------- 级联删除前的准备：让 alice 产生持仓与每日快照 ---------- */
  console.log('\n【级联删除用户：会话 / 自选 / 持仓 / 每日快照一并清理】');
  // 注意：u1（alice 原会话）在重置密码时已被作废，这里必须用新会话写入
  const aliceSession = new Client();
  r = await aliceSession.req('POST', '/api/auth/login', { username: 'alice', password: 'newpass123' });
  check('alice 用新密码重新登录成功', r.status === 200, JSON.stringify(r.body));

  r = await aliceSession.req('POST', '/api/positions', { code: '161725', name: '招商中证白酒指数(LOF)A', amount: 10000, profit: 120 });
  check('alice 写入持仓 1', r.status === 200, JSON.stringify(r.body));
  r = await aliceSession.req('POST', '/api/positions', { code: '000001', name: '华夏成长混合', amount: 5000, profit: -60 });
  check('alice 写入持仓 2', r.status === 200, JSON.stringify(r.body));
  r = await aliceSession.req('GET', '/api/portfolio'); // 触发 position_daily / account_daily 落库
  check('alice 账本聚合成功（触发每日快照）', r.status === 200 && r.body.portfolio?.items?.length === 2, JSON.stringify(r.body).slice(0, 120));

  const before = (await admin.req('GET', '/api/admin/stats')).body.stats;
  check('删除前：alice 持仓已计入运营统计', before.positionsItems >= 2 && before.usersWithPositions >= 1, JSON.stringify(before));
  check('删除前：已写入每日快照', before.positionDailyRows >= 2 && before.snapshotDays >= 1, JSON.stringify(before));
  check('删除前：alice 会话有效（可读自选）', (await aliceSession.req('GET', '/api/watchlist')).status === 200);

  /* ---------- 运营指标明细下钻（点击指标卡查看构成） ---------- */
  console.log('\n【运营指标明细下钻】');
  r = await admin.req('GET', '/api/admin/metrics/users');
  check('明细：注册用户 3 条', r.status === 200 && r.body.total === 3 && r.body.items.length === 3, JSON.stringify(r.body).slice(0, 100));
  check('明细：返回列定义', Array.isArray(r.body.columns) && r.body.columns.length >= 3, JSON.stringify(r.body.columns));
  r = await admin.req('GET', '/api/admin/metrics/admins');
  check('明细：管理员仅 root', r.body.total === 1 && r.body.items[0].username === 'root', JSON.stringify(r.body.items));
  r = await admin.req('GET', '/api/admin/metrics/watchlistItems');
  check('明细：自选 3 条', r.body.total === 3 && r.body.items.length === 3, JSON.stringify(r.body.items).slice(0, 100));
  r = await admin.req('GET', '/api/admin/metrics/usersWithWatchlist');
  check('明细：有自选用户 2 且带条数', r.body.total === 2 && typeof r.body.items[0].count === 'number', JSON.stringify(r.body.items));
  r = await admin.req('GET', '/api/admin/metrics/positionsItems');
  check('明细：持仓 2 条且含金额/收益', r.body.items.length === 2 && typeof r.body.items[0].amount === 'number' && typeof r.body.items[0].profit === 'number', JSON.stringify(r.body.items));
  r = await admin.req('GET', '/api/admin/metrics/usersWithPositions');
  check('明细：有持仓用户 1 且带金额合计', r.body.total === 1 && r.body.items[0].amount === 15000, JSON.stringify(r.body.items));
  r = await admin.req('GET', '/api/admin/metrics/positionDailyRows');
  check('明细：每日明细行 ≥2 且含交易日', r.body.items.length >= 2 && Boolean(r.body.items[0].date), JSON.stringify(r.body.items).slice(0, 120));
  r = await admin.req('GET', '/api/admin/metrics/snapshotDays');
  check('明细：快照按交易日聚合', r.body.items.length >= 1 && typeof r.body.items[0].users === 'number', JSON.stringify(r.body.items));
  r = await admin.req('GET', '/api/admin/metrics/activeSessions');
  check('明细：活跃会话数与统计一致', r.body.total === before.activeSessions, `${r.body.total} vs ${before.activeSessions}`);

  // 一致性：10 个指标的明细总数必须与 /api/admin/stats 对应字段完全一致
  const statsNow = (await admin.req('GET', '/api/admin/stats')).body.stats;
  const metricKeys = ['users', 'admins', 'activeSessions', 'watchlistItems', 'usersWithWatchlist', 'positionsItems', 'usersWithPositions', 'quotesCached', 'snapshotDays', 'positionDailyRows'];
  const mismatch = [];
  for (const k of metricKeys) {
    const rr = await admin.req('GET', `/api/admin/metrics/${k}`);
    if (!rr.body.ok || rr.body.total !== statsNow[k]) mismatch.push(`${k}: ${rr.body.total} vs ${statsNow[k]}`);
  }
  check('10 个指标明细总数与运营统计完全一致', mismatch.length === 0, mismatch.join('; '));
  check('未知指标返回 404', (await admin.req('GET', '/api/admin/metrics/unknownKey')).status === 404);
  check('普通用户访问指标明细被拒 (403)', (await u2.req('GET', '/api/admin/metrics/users')).status === 403);

  r = await admin.req('DELETE', `/api/admin/users/${alice.id}`);
  check('删除普通用户成功', r.status === 200 && r.body.username === 'alice', JSON.stringify(r.body));

  const after = (await admin.req('GET', '/api/admin/stats')).body.stats;
  check('删除后用户数 2、自选 1 条', after.users === 2 && after.watchlistItems === 1, JSON.stringify(after));
  check('级联：持仓已清理', after.positionsItems === 0 && after.usersWithPositions === 0, JSON.stringify(after));
  check('级联：每日明细快照已清理', after.positionDailyRows === 0, JSON.stringify(after));
  check('级联：账户快照已清理', after.snapshotDays === 0 && after.latestSnapshot === null, JSON.stringify(after));
  check('级联：alice 的全部会话已删除', after.activeSessions < before.activeSessions, `before=${before.activeSessions} after=${after.activeSessions}`);
  check('级联：原会话 Cookie 立即失效 (401)', (await aliceSession.req('GET', '/api/watchlist')).status === 401);
  check('级联：alice 已无法登录', (await aliceSession.req('POST', '/api/auth/login', { username: 'alice', password: 'newpass123' })).status === 401);
  check('级联：用户详情 404', (await admin.req('GET', `/api/admin/users/${alice.id}`)).status === 404);
  check('级联：再次删除返回 404', (await admin.req('DELETE', `/api/admin/users/${alice.id}`)).status === 404);

  r = await admin.req('GET', '/api/admin/users');
  check('删除后列表无 alice', !r.body.items.some((x) => x.username === 'alice'));

  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
} catch (e) {
  console.error('测试异常:', e.message);
  fail++;
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

process.exit(fail === 0 ? 0 : 1);
