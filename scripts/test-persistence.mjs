// 持久化专项测试：验证「重启不覆盖、数据不依赖 WAL 边车文件」
// 运行：node scripts/test-persistence.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8789;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fundwatch-persist-'));
const DB = path.join(tmp, 'data', 'fundwatch.db');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

const start = (dbPath = DB) => spawn(process.execPath, ['scripts/dev-server.mjs', '--no-qr'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath }, stdio: 'ignore',
});

async function ready() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch {}
    await wait(250);
  }
  throw new Error('服务器启动超时');
}
const post = (url, body, cookie) => fetch(BASE + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
});

const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

let server;
try {
  console.log('\n【1】首次启动写入数据');
  server = start();
  await ready();
  let r = await post('/api/auth/register', { username: 'persist_user', password: 'persist123' });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  await post('/api/watchlist', { code: '161725', name: '招商中证白酒指数(LOF)A' }, cookie);
  await post('/api/watchlist', { code: '000001', name: '华夏成长混合' }, cookie);
  r = await fetch(`${BASE}/api/health`);
  const health1 = await r.json();
  // 内置 root 管理员 + persist_user = 2 个用户
  check('写入后健康检查显示 2 用户（含内置 root）/ 2 自选',
    health1.db.users === 2 && health1.db.watchlistItems === 2, JSON.stringify(health1.db));
  check('健康检查报告持久化位置', health1.db.persistent === true, JSON.stringify(health1.db));
  check('写操作后 WAL 已被主动合并（≤64KB）', health1.db.walSize <= 65536, `WAL ${health1.db.walSize} 字节`);
  check('主库文件已含数据（> 8KB）', health1.db.fileSize > 8192, `${health1.db.fileSize} 字节`);

  console.log('\n【2】退出进程（Windows 下 SIGTERM 为强制终止，不依赖退出钩子）');
  server.kill('SIGTERM');
  await wait(1800);
  const dbSizeAfterShutdown = size(DB);
  check('主库文件仍然包含全部数据（> 8KB）', dbSizeAfterShutdown > 8192, `${dbSizeAfterShutdown} 字节`);

  console.log('\n【3】重启后数据仍在');
  server = start();
  await ready();
  r = await post('/api/auth/login', { username: 'persist_user', password: 'persist123' });
  check('重启后可登录', r.status === 200, 'HTTP ' + r.status);
  const c2 = r.headers.get('set-cookie').split(';')[0];
  let list = await (await fetch(`${BASE}/api/watchlist`, { headers: { Cookie: c2 } })).json();
  check('重启后自选仍是 2 条', list.items.length === 2, JSON.stringify(list.items));
  server.kill('SIGTERM');
  await wait(1200);

  console.log('\n【4】只保留单个 .db 文件（模拟 WAL/SHM 边车丢失或只拷贝主库）');
  const soloDir = path.join(tmp, 'solo');
  fs.mkdirSync(soloDir, { recursive: true });
  const soloDb = path.join(soloDir, 'fundwatch.db');
  fs.copyFileSync(DB, soloDb);               // 只拷贝主库，不拷贝 -wal/-shm
  check('拷贝目录中只有 .db（无 WAL 边车）', fs.readdirSync(soloDir).length === 1, fs.readdirSync(soloDir).join(','));
  server = start(soloDb);
  await ready();
  r = await post('/api/auth/login', { username: 'persist_user', password: 'persist123' });
  check('单文件库仍可登录（数据在主库内）', r.status === 200, 'HTTP ' + r.status);
  const c3 = r.headers.get('set-cookie').split(';')[0];
  list = await (await fetch(`${BASE}/api/watchlist`, { headers: { Cookie: c3 } })).json();
  check('单文件库自选完整（2 条）', list.items.length === 2, JSON.stringify(list.items));

  console.log('\n【5】强杀进程（模拟崩溃）后仍可恢复');
  server.kill('SIGKILL');
  await wait(1500);
  server = start(soloDb);
  await ready();
  r = await post('/api/auth/login', { username: 'persist_user', password: 'persist123' });
  check('崩溃重启后账号仍在', r.status === 200, 'HTTP ' + r.status);

  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
} catch (e) {
  console.error('测试异常:', e.message);
  fail++;
} finally {
  try { server?.kill('SIGKILL'); } catch {}
  await wait(400);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
process.exit(fail === 0 ? 0 : 1);
