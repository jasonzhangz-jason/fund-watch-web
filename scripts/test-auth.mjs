// 账号与自选端到端测试（含 SQLite 重启持久化验证）
// 运行：node scripts/test-auth.mjs
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(path.join(tmpdir(), 'fundwatch-test-'));
const DB = path.join(tmp, 'test.db');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

function startServer() {
  const p = spawn(process.execPath, ['scripts/dev-server.mjs', '--no-qr'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB },
    stdio: 'ignore',
  });
  return p;
}

async function waitReady(timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务器启动超时');
}

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.cookie) headers.Cookie = this.cookie;
    const r = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const setCookie = r.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0];
      if (/=;|Max-Age=0/.test(setCookie)) this.cookie = '';
      else this.cookie = pair;
    }
    let j = null;
    try { j = await r.json(); } catch { /* 空响应 */ }
    return { status: r.status, body: j };
  }
}

let server = startServer();
try {
  await waitReady();
  const c = new Client();

  console.log('\n【注册 / 登录】');
  let r = await c.req('POST', '/api/auth/register', { username: 'ab', password: '123' });
  check('用户名过短被拒 (400)', r.status === 400, JSON.stringify(r.body));
  r = await c.req('POST', '/api/auth/register', { username: 'tester', password: '123' });
  check('密码过短被拒 (400)', r.status === 400, JSON.stringify(r.body));

  r = await c.req('POST', '/api/auth/register', { username: 'tester', password: 'secret123' });
  check('注册成功 (200)', r.status === 200 && r.body.user?.username === 'tester', JSON.stringify(r.body));
  check('注册后带回会话 Cookie', !!c.cookie);

  r = await c.req('GET', '/api/auth/me');
  check('me 返回当前用户', r.status === 200 && r.body.user?.username === 'tester');

  const c2 = new Client();
  r = await c2.req('POST', '/api/auth/register', { username: 'tester', password: 'other123' });
  check('重复用户名被拒 (409)', r.status === 409, JSON.stringify(r.body));

  console.log('\n【自选基金（账号级）】');
  r = await c.req('POST', '/api/watchlist', { code: '161725', name: '招商中证白酒指数(LOF)A' });
  check('新增自选 (200)', r.status === 200, JSON.stringify(r.body));
  r = await c.req('POST', '/api/watchlist', { code: 'abc123' });
  check('非法代码被拒 (400)', r.status === 400, JSON.stringify(r.body));
  r = await c.req('POST', '/api/watchlist', { mode: 'sync', items: [{ code: '000001', name: '华夏成长' }, { code: '110022', name: '易方达消费行业' }] });
  check('批量同步 (200)', r.status === 200 && r.body.synced === 2, JSON.stringify(r.body));
  r = await c.req('GET', '/api/watchlist');
  check('列表返回 3 条', r.status === 200 && r.body.items.length === 3, JSON.stringify(r.body));
  r = await c.req('DELETE', '/api/watchlist/110022');
  check('删除自选 (200)', r.status === 200 && r.body.removed === 1, JSON.stringify(r.body));
  r = await c.req('GET', '/api/watchlist');
  check('删除后剩 2 条', r.body.items.length === 2);

  console.log('\n【未登录访问控制】');
  const anon = new Client();
  r = await anon.req('GET', '/api/watchlist');
  check('未登录读自选被拒 (401)', r.status === 401, JSON.stringify(r.body));
  r = await anon.req('POST', '/api/watchlist', { code: '161725' });
  check('未登录写自选被拒 (401)', r.status === 401);

  console.log('\n【登出 / 错误密码】');
  r = await c.req('POST', '/api/auth/logout');
  check('登出成功 (200)', r.status === 200 && r.body.user === null);
  r = await c.req('GET', '/api/watchlist');
  check('登出后读自选被拒 (401)', r.status === 401);
  r = await c.req('POST', '/api/auth/login', { username: 'tester', password: 'wrongpass' });
  check('错误密码被拒 (401)', r.status === 401, JSON.stringify(r.body));

  console.log('\n【重启后持久化（SQLite 落盘）】');
  server.kill();
  await new Promise((r2) => setTimeout(r2, 800));
  server = startServer();
  await waitReady();
  const c3 = new Client();
  r = await c3.req('POST', '/api/auth/login', { username: 'tester', password: 'secret123' });
  check('重启后仍可登录', r.status === 200 && r.body.user?.username === 'tester', JSON.stringify(r.body));
  r = await c3.req('GET', '/api/watchlist');
  check('重启后自选数据仍在 (2 条)', r.status === 200 && r.body.items.length === 2, JSON.stringify(r.body));
  check('自选内容正确', r.body.items.map((i) => i.code).sort().join(',') === '000001,161725', JSON.stringify(r.body.items));

  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
} catch (e) {
  console.error('测试异常:', e.message);
  fail++;
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

process.exit(fail === 0 ? 0 : 1);
