// 后台管理 UI 测试（Puppeteer）：root 登录 → 后台入口 → 用户列表 → 查看自选；普通用户无入口
// 运行：node scripts/smoke-admin-ui.cjs
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fundwatch-adminui-'));
const DB = path.join(tmp, 'adminui.db');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

const server = spawn(process.execPath, ['scripts/dev-server.mjs', '--no-qr'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), DB_PATH: DB }, stdio: 'ignore',
});

async function seedUser() {
  const r = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'charlie', password: 'charlie123' }),
  });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  await fetch(`${BASE}/api/watchlist`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code: '161725', name: '招商中证白酒指数(LOF)A' }),
  });
}

(async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  await seedUser();

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  console.log('\n【普通用户：无后台入口】');
  await page.goto(BASE, { waitUntil: 'load', timeout: 20000 });
  await new Promise((r) => setTimeout(r, 800));
  await page.click('#login-btn');
  await page.type('#auth-user', 'charlie');
  await page.type('#auth-pass', 'charlie123');
  await page.click('#auth-submit');
  await page.waitForFunction(() => document.querySelector('#user-box').textContent.includes('charlie'), { timeout: 15000 });
  const adminTabHidden = await page.$eval('#tab-btn-admin', (el) => getComputedStyle(el).display === 'none');
  check('普通用户看不到「后台」入口', adminTabHidden);
  await page.click('#logout-btn');
  await page.waitForSelector('#login-btn', { timeout: 15000 });   // 等登出彻底完成

  console.log('\n【管理员 root/root 登录】');
  await page.click('#login-btn');
  await page.type('#auth-user', 'root');
  await page.type('#auth-pass', 'root');
  await page.click('#auth-submit');
  await page.waitForFunction(() => document.querySelector('#user-box').textContent.includes('root'), { timeout: 15000 });
  const uname = await page.$eval('#user-box', (el) => el.textContent);
  check('顶部显示 root + 管理员标记', uname.includes('root') && uname.includes('管理员'), uname);
  const adminVisible = await page.$eval('#tab-btn-admin', (el) => getComputedStyle(el).display !== 'none');
  check('管理员可见「后台」入口', adminVisible);

  console.log('\n【后台面板数据】');
  await page.click('#tab-btn-admin');
  await new Promise((r) => setTimeout(r, 2000));
  const stats = await page.$$eval('.stat', (els) => els.map((e) => e.textContent));
  check('统计卡片渲染（5 个）', stats.length === 5, JSON.stringify(stats));
  check('统计含注册用户 2', stats.some((s) => s.includes('注册用户') && s.includes('2')), JSON.stringify(stats));
  const rows = await page.$$eval('.admin-table tbody tr', (els) => els.length);
  check('用户表有 2 行', rows === 2, String(rows));
  const tableTxt = await page.$eval('#admin-users', (el) => el.textContent);
  check('列表含 charlie', tableTxt.includes('charlie'));
  check('charlie 自选数显示 1', /charlie[\s\S]{0,80}?1/.test(tableTxt));

  console.log('\n【查看某用户自选基金】');
  await page.click('button[data-act="funds"][data-name="charlie"]');
  await new Promise((r) => setTimeout(r, 1500));
  const fundsTitle = await page.$eval('#admin-funds-title', (el) => el.textContent);
  check('明细标题指向 charlie', fundsTitle.includes('charlie'), fundsTitle);
  const fundsTxt = await page.$eval('#admin-funds', (el) => el.textContent);
  check('自选明细显示 161725', fundsTxt.includes('161725'), fundsTxt.slice(0, 100));
  check('自选明细显示基金名称', fundsTxt.includes('招商中证白酒'), fundsTxt.slice(0, 100));
  const chips = await page.$$eval('.fund-chip', (els) => els.length);
  check('基金卡片 1 个', chips === 1, String(chips));

  console.log('\n【搜索过滤】');
  await page.type('#admin-search', 'zzz-not-exist');
  await page.click('#admin-search-btn');
  await new Promise((r) => setTimeout(r, 1500));
  const emptyTxt = await page.$eval('#admin-users', (el) => el.textContent);
  check('搜索无结果提示', emptyTxt.includes('没有匹配'), emptyTxt.slice(0, 60));

  check('页面无 JS 报错', errors.length === 0, errors.join(' | '));
  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);

  await browser.close();
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e.message); server.kill(); process.exit(1); });
