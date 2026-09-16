// 多设备自适应测试：PC / 平板 / iPhone / Android / 小屏 / 横屏 + 旋转重绘
// 运行：node scripts/smoke-responsive.cjs（需先启动 npm run dev 或由脚本自启）
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fundwatch-resp-'));
const DB = path.join(tmp, 'resp.db');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

// 设备矩阵：名称 / 视口 / 是否移动端 / 是否触屏
const DEVICES = [
  { name: 'PC 1920×1080', viewport: { width: 1920, height: 1080 }, mobile: false, touch: false },
  { name: '笔记本 1366×768', viewport: { width: 1366, height: 768 }, mobile: false, touch: false },
  { name: 'iPad 竖屏 820×1180', viewport: { width: 820, height: 1180 }, mobile: true, touch: true },
  { name: 'iPhone 14 390×844', viewport: { width: 390, height: 844 }, mobile: true, touch: true },
  { name: 'iPhone SE 375×667', viewport: { width: 375, height: 667 }, mobile: true, touch: true },
  { name: 'Android 412×915', viewport: { width: 412, height: 915 }, mobile: true, touch: true },
  { name: '小屏安卓 360×640', viewport: { width: 360, height: 640 }, mobile: true, touch: true },
  { name: 'iPhone 横屏 844×390', viewport: { width: 844, height: 390 }, mobile: true, touch: true },
];

const isMobile = (d) => d.viewport.width <= 640;

const server = spawn(process.execPath, ['scripts/dev-server.mjs', '--no-qr'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), DB_PATH: DB }, stdio: 'ignore',
});

const TEST_USER = { username: 'e2e_resp', password: 'e2e123456' };
/** 取得（或创建）测试账号的会话 token —— 自选数据存账号（SQLite） */
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
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  // 注入登录会话（自选需要登录）
  const token = await getSessionToken();
  await page.setCookie({ name: 'fw_session', value: token, url: BASE, httpOnly: true, sameSite: 'Lax' });

  for (const dev of DEVICES) {
    console.log(`\n【${dev.name}】`);
    await page.setViewport({
      width: dev.viewport.width, height: dev.viewport.height,
      isMobile: dev.mobile, hasTouch: dev.touch, deviceScaleFactor: dev.mobile ? 2 : 1,
    });
    await page.goto(BASE, { waitUntil: 'load', timeout: 20000 });
    await new Promise((r) => setTimeout(r, 700));

    // 1. 无横向溢出（核心指标）
    const ov = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    }));
    check('无横向溢出', ov.sw <= ov.cw + 1, `scrollWidth=${ov.sw} clientWidth=${ov.cw}`);

    // 2. 头部导航可见且可点
    const tab = await page.$eval('.tab[data-tab=watch]', (el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
    });
    check('导航标签可见', tab.w > 0 && tab.h > 0 && tab.top >= 0, JSON.stringify(tab));

    // 3. 移动端：触控热区 ≥44px；输入框 ≥16px（防 iOS 聚焦放大）
    if (isMobile(dev)) {
      const sizes = await page.evaluate(() => ({
        tabH: document.querySelector('.tab').getBoundingClientRect().height,
        btnH: document.querySelector('.btn') ? document.querySelector('.btn').getBoundingClientRect().height : 0,
        inputFont: parseFloat(getComputedStyle(document.querySelector('#search-input')).fontSize),
        minH: getComputedStyle(document.querySelector('#search-input')).minHeight,
      }));
      check('Tab 触控高度 ≥44px', sizes.tabH >= 43, `${Math.round(sizes.tabH)}px`);
      check('按钮触控高度 ≥44px', sizes.btnH >= 43, `${Math.round(sizes.btnH)}px`);
      check('输入框字号 ≥16px（防 iOS 缩放）', sizes.inputFont >= 16, `${sizes.inputFont}px`);
    }

    // 4. 桌面端：自选/估值列表应双列（≥1024px）
    if (dev.viewport.width >= 1024) {
      const cols = await page.$eval('#watch-list', (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
      check('宽屏列表为双列', cols === 2, `列数=${cols}`);
    }

    // 5. 搜索 + 自选卡片在任意尺寸下可用
    await page.click('.tab[data-tab=search]');
    await page.type('#search-input', '161725');
    await new Promise((r) => setTimeout(r, 1600));
    const items = await page.$$eval('.search-item', (els) => els.length);
    check('搜索结果可见', items > 0, `结果数=${items}`);
    if (items > 0) {
      // 首次设备为「＋加入自选」，之后设备可能已是「已自选」（localStorage 持久），两种都兼容
      const addBtn = await page.$('.search-item .btn:not(.ghost)');
      if (addBtn) { await addBtn.click(); }
      await new Promise((r) => setTimeout(r, 1200));
      await page.click('.tab[data-tab=watch]');
      await new Promise((r) => setTimeout(r, 1500));
      const watchOk = await page.$eval('#watch-list', (el) => el.textContent.includes('161725'));
      check('自选卡片渲染', watchOk);
      // 卡片不超出视口宽度
      const cardOk = await page.evaluate(() => {
        const c = document.querySelector('#watch-list .fund-card');
        if (!c) return true;
        const r = c.getBoundingClientRect();
        return r.left >= -1 && r.right <= document.documentElement.clientWidth + 1;
      });
      check('卡片未溢出视口', cardOk);
    }

    // 6. 弹窗在任意尺寸下不超出视口且可滚动（已登录时无登录按钮，直接调用 openAuth）
    await page.evaluate(() => openAuth('login'));
    await new Promise((r) => setTimeout(r, 300));
    const modalOk = await page.evaluate(() => {
      const m = document.querySelector('.modal');
      const r = m.getBoundingClientRect();
      return { fits: r.top >= -1 && r.bottom <= innerHeight + 1, maxH: getComputedStyle(m).maxHeight };
    });
    check('登录弹窗不超出视口', modalOk.fits, JSON.stringify(modalOk));
    await page.keyboard.press('Escape');

    // 7. 安全区变量已解析（非 iOS 为 0，不报错即可）
    const safe = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sab').trim());
    check('安全区变量可用', safe !== undefined && safe !== '', `--sab="${safe}"`);
  }

  // 8. 旋转重绘：先竖屏看详情画布宽度，再旋转为横屏，画布宽度应变化
  console.log('\n【旋转/缩放重绘】');
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.click('.tab[data-tab=detail]');
  await page.type('#detail-input', '161725');
  await page.click('#detail-btn');
  await page.waitForFunction(() => !!document.querySelector('#nav-chart'), { timeout: 25000 });
  await new Promise((r) => setTimeout(r, 1200));
  const w1 = await page.$eval('#nav-chart', (c) => c.width);
  await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await new Promise((r) => setTimeout(r, 1200));
  const w2 = await page.$eval('#nav-chart', (c) => c.width);
  check('横竖屏切换后画布按新宽度重绘', w2 !== w1 && w2 > 0, `竖屏=${w1} → 横屏=${w2}`);

  // 9. 未登录态：自选提示登录，且不使用浏览器本地存储
  console.log('\n【未登录态（无本地存储）】');
  const anonCtx = await browser.createBrowserContext();     // 独立上下文：无登录 Cookie
  const anon = await anonCtx.newPage();
  const anonErrors = [];
  anon.on('pageerror', (e) => anonErrors.push(e.message));
  await anon.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await anon.goto(BASE, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 1200));
  const anonWatch = await anon.$eval('#watch-list', (el) => el.textContent.replace(/\s+/g, ' '));
  check('未登录自选区提示登录', anonWatch.includes('登录'), anonWatch.slice(0, 60));
  const anonAddTry = await anon.evaluate(async () => {
    const r = await fetch('/api/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '000001', name: 'x' }) });
    return r.status;
  });
  check('未登录调用自选接口被拒 (401)', anonAddTry === 401, 'HTTP ' + anonAddTry);
  const anonLocal = await anon.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('fundWatch')));
  check('未登录不写入浏览器本地存储', anonLocal.length === 0, JSON.stringify(anonLocal));
  check('未登录页无 JS 报错', anonErrors.length === 0, anonErrors.join(' | '));
  await anonCtx.close();

  check('全程无 JS 报错', errors.length === 0, errors.join(' | '));
  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);

  await browser.close();
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e.message); server.kill(); process.exit(1); });
