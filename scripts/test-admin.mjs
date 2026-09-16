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

  r = await admin.req('DELETE', `/api/admin/users/${alice.id}`);
  check('删除普通用户成功', r.status === 200 && r.body.username === 'alice', JSON.stringify(r.body));
  r = await admin.req('GET', '/api/admin/stats');
  check('删除后用户数 2、自选 1 条', r.body.stats.users === 2 && r.body.stats.watchlistItems === 1, JSON.stringify(r.body.stats));
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
