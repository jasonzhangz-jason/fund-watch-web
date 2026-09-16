// 账号 UI 端到端测试（Puppeteer）：注册 → 加自选 → 刷新保持登录 → 退出
// 运行：node scripts/smoke-auth-ui.cjs
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fundwatch-ui-'));
const DB = path.join(tmp, 'ui.db');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

const server = spawn(process.execPath, ['scripts/dev-server.mjs', '--no-qr'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), DB_PATH: DB }, stdio: 'ignore',
});

(async () => {
  // 等待服务器就绪
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(BASE, { waitUntil: 'load', timeout: 20000 });
  await new Promise((r) => setTimeout(r, 800));

  console.log('\n【未登录态】');
  const loginBtnText = await page.$eval('#login-btn', (el) => el.textContent).catch(() => '');
  check('顶部显示「登录 / 注册」', loginBtnText.includes('登录'));
  const hint1 = await page.$eval('#watch-hint', (el) => el.textContent);
  check('自选提示为本地存储', hint1.includes('本地'));

  console.log('\n【注册】');
  await page.click('#login-btn');
  await new Promise((r) => setTimeout(r, 300));
  check('弹窗已打开', await page.$eval('#auth-modal', (el) => el.classList.contains('show')));
  await page.click('#auth-switch');               // 切到注册
  await page.type('#auth-user', 'uitest');
  await page.type('#auth-pass', 'ui-secret-123');
  await page.click('#auth-submit');
  await new Promise((r) => setTimeout(r, 1500)), 
  check('弹窗已关闭', !(await page.$eval('#auth-modal', (el) => el.classList.contains('show'))));
  const uname = await page.$eval('#user-box', (el) => el.textContent);
  check('顶部显示用户名', uname.includes('uitest'), uname);
  const hint2 = await page.$eval('#watch-hint', (el) => el.textContent);
  check('自选提示切换为账号存储', hint2.includes('账号'));

  console.log('\n【加入自选（写入 SQLite）】');
  await page.click('.tab[data-tab=search]');
  await page.type('#search-input', '161725');
  await new Promise((r) => setTimeout(r, 1800));
  const hasResult = (await page.$$('.search-item')).length > 0;
  check('搜索到基金', hasResult);
  if (hasResult) {
    await page.click('.search-item .btn:not(.ghost)');
    await new Promise((r) => setTimeout(r, 1500));
  }
  await page.click('.tab[data-tab=watch]');
  await new Promise((r) => setTimeout(r, 2500));
  const watchTxt = await page.$eval('#watch-list', (el) => el.textContent);
  check('自选列表显示该基金', watchTxt.includes('161725'), watchTxt.slice(0, 80));

  // 服务端已落库
  const rowsInDb = await page.evaluate(async () => (await (await fetch('/api/watchlist')).json()).items);
  check('服务端返回 1 条自选', rowsInDb.length === 1, JSON.stringify(rowsInDb));

  console.log('\n【刷新页面：登录态与自选保持】');
  await page.reload({ waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 2500));
  const uname2 = await page.$eval('#user-box', (el) => el.textContent);
  check('刷新后仍为登录态', uname2.includes('uitest'), uname2);
  const watchTxt2 = await page.$eval('#watch-list', (el) => el.textContent);
  check('刷新后自选来自账号', watchTxt2.includes('161725'), watchTxt2.slice(0, 80));

  console.log('\n【退出登录】');
  await page.click('#logout-btn');
  await new Promise((r) => setTimeout(r, 1500));
  const afterLogout = await page.$eval('#user-box', (el) => el.textContent);
  check('退出后显示登录按钮', afterLogout.includes('登录'), afterLogout);
  const meAfter = await page.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user);
  check('服务端会话已失效', meAfter === null);

  check('页面无 JS 报错', errors.length === 0, errors.join(' | '));
  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);

  await browser.close();
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('测试异常:', e.message);
  server.kill();
  process.exit(1);
});
