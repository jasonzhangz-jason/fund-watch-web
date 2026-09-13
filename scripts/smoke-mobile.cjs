// 移动端自适应 + 详情代理验证：iPhone 视口，并主动阻断对东方财富域名的直连（模拟手机网络受限）
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  // 🔒 模拟手机网络受限：阻断浏览器对 fund.eastmoney.com / fundgz 的直连
  await page.setRequestInterception(true);
  let blocked = 0;
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('fund.eastmoney.com') || u.includes('fundgz.1234567.com.cn')) { blocked++; req.abort(); return; }
    req.continue();
  });

  await page.goto('http://localhost:8787', { waitUntil: 'load', timeout: 30000 });
  await new Promise(r => setTimeout(r, 600));

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  console.log('横向溢出:', overflow ? 'YES ✗' : '无 ✓');

  // 详情页（此时直连被阻断，必须走 /api/detail 代理）
  await page.click('.tab[data-tab=detail]');
  await page.type('#detail-input', '161725');
  await page.click('#detail-btn');
  await new Promise(r => setTimeout(r, 5000));

  const detail = await page.$eval('#detail-content', el => el.textContent.replace(/\s+/g, ' ').slice(0, 130)).catch(() => '');
  const hasCanvas = await page.$('#nav-chart') !== null;
  const canvasW = hasCanvas ? await page.$eval('#nav-chart', c => c.width) : 0;
  const rows = await page.$$eval('#nav-table tbody tr', r => r.length).catch(() => 0);
  const metricCount = await page.$$eval('.metric', els => els.length).catch(() => 0);

  console.log('被阻断的直连请求数:', blocked);
  console.log('详情内容:', detail);
  console.log('净值图 canvas:', hasCanvas, '| 宽:', canvasW, '| 净值表行数:', rows, '| 阶段收益指标数:', metricCount);
  console.log('JS errors:', errors.length ? errors : 'none');

  const ok = detail.includes('招商') && hasCanvas && rows > 0 && errors.length === 0;
  console.log(ok ? '\n✅ 手机网络受限场景下详情页正常（走服务端代理）' : '\n❌ 验证失败');
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('MOBILE SMOKE FAIL:', e.message); process.exit(1); });
