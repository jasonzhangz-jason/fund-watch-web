// 端到端冒烟测试：http://localhost:8787（dev-server.mjs）
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('http://localhost:8787', { waitUntil: 'load', timeout: 30000 });
  await new Promise(r => setTimeout(r, 600));

  // 1. 搜索页
  await page.click('.tab[data-tab=search]');
  await page.type('#search-input', '161725');
  await new Promise(r => setTimeout(r, 1500));
  const searchItems = await page.$$eval('.search-item', els => els.length);
  console.log('search items:', searchItems);

  // 2. 加入自选
  await page.click('.search-item .btn:not(.ghost)');
  await new Promise(r => setTimeout(r, 600));
  let favs = await page.evaluate(() => JSON.parse(localStorage.getItem('fundWatch:favs') || '[]'));
  console.log('favs after add:', JSON.stringify(favs));

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
