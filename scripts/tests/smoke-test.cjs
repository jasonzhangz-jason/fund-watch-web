// 端到端冒烟测试：http://localhost:8787（dev-server.mjs）
// 注意：自选数据存账号（SQLite），测试会先取得一个登录会话
const puppeteer = require('puppeteer');

const BASE = 'http://localhost:8787';
const TEST_USER = { username: 'e2e_smoke', password: 'e2e123456' };

/** 取得（或创建）测试账号的会话 token */
async function getSessionToken() {
  const post = (url, body) => fetch(BASE + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let r = await post('/api/auth/login', TEST_USER);
  if (r.status === 401) r = await post('/api/auth/register', TEST_USER);
  if (!r.ok) throw new Error('测试账号登录失败: HTTP ' + r.status);
  return r.headers.get('set-cookie').split(';')[0].split('=')[1];
}

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // 注入登录会话（自选需要登录）
  const token = await getSessionToken();
  await page.setCookie({ name: 'fw_session', value: token, url: BASE, httpOnly: true, sameSite: 'Lax' });

  await page.goto(BASE, { waitUntil: 'load', timeout: 30000 });
  await new Promise(r => setTimeout(r, 800));

  // 0. 登录态
  const userBox = await page.$eval('#user-box', el => el.textContent.trim());
  console.log('logged in as:', userBox.replace(/\s+/g, ' '));

  // 1. 搜索页
  await page.click('.tab[data-tab=search]');
  await page.type('#search-input', '161725');
  await new Promise(r => setTimeout(r, 1500));
  const searchItems = await page.$$eval('.search-item', els => els.length);
  console.log('search items:', searchItems);

  // 2. 加入自选（写入账号 / SQLite）
  const addBtn = await page.$('.search-item .btn:not(.ghost)');
  if (addBtn) {
    await addBtn.click();
    await new Promise(r => setTimeout(r, 1200));
  } else {
    console.log('already in watchlist');
  }
  const favs = await page.evaluate(async () => (await (await fetch('/api/watchlist')).json()).items.map(i => i.code));
  console.log('watchlist on server:', JSON.stringify(favs));
  const hasLocal = await page.evaluate(() => Object.keys(localStorage).filter(k => k.includes('fundWatch')));
  console.log('localStorage fundWatch keys:', JSON.stringify(hasLocal));
  if (!favs.includes('161725')) errors.push('自选未写入账号');

  // 3. 自选页估值（含降级）
  await page.click('.tab[data-tab=watch]');
  await new Promise(r => setTimeout(r, 3000));
  const watchText = await page.$eval('#watch-list', el => el.textContent.slice(0, 160)).catch(() => '');
  console.log('watch list:', watchText.replace(/\s+/g, ' '));

  // 4. 详情页
  await page.click('.tab[data-tab=detail]');
  await page.type('#detail-input', '161725');
  await page.click('#detail-btn');
  await new Promise(r => setTimeout(r, 6000));
  const detailHead = await page.$eval('#detail-content', el => el.textContent.slice(0, 100)).catch(() => '');
  console.log('detail:', detailHead.replace(/\s+/g, ' '));
  const hasCanvas = await page.$('#nav-chart') !== null;
  const navTableRows = await page.$$eval('#nav-table tbody tr', rows => rows.length).catch(() => 0);
  console.log('canvas:', hasCanvas, 'nav table rows:', navTableRows);

  console.log('JS errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1); });
