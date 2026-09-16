/**
 * 端到端测试：账号自选落库 + 真实行情接入
 *   node scripts/test-live-ui.cjs
 *
 * 覆盖：
 *   1. 未登录时自选页显示登录引导、账号入口可用
 *   2. 注册账号 → 顶栏账号入口显示用户名
 *   3. 搜索页「＋自选」→ 后端 /api/watchlist 真的写入（账号落库）
 *   4. 自选页展示该基金，并叠加真实行情（估算/最新涨幅）
 *   5. 重启后端进程后自选仍在（SQLite 持久化）
 *   6. 详情页展示真实数据（净值走势 / 阶段收益 / 费率）
 *
 * 依赖：环境需可用的 puppeteer（PUPPETEER_MODULE / NODE_PATH）与 Chromium（PUPPETEER_EXECUTABLE_PATH）
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const API_PORT = 8788;
const WEB_PORT = 4174;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fundwatch-live-'));
const DB = path.join(tmp, 'fundwatch.db');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

function loadPuppeteer() {
  const candidates = [];
  if (process.env.PUPPETEER_MODULE) candidates.push(process.env.PUPPETEER_MODULE);
  if (process.env.NODE_PATH) candidates.push(...process.env.NODE_PATH.split(path.delimiter).filter(Boolean));
  candidates.push(path.join(ROOT, 'node_modules'));
  for (const dir of candidates) {
    try {
      return require(require.resolve('puppeteer', { paths: [dir] }));
    } catch {
      /* 继续 */
    }
  }
  throw new Error('未找到 puppeteer：请设置 PUPPETEER_MODULE 或 NODE_PATH');
}

async function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status < 500) return true;
    } catch {
      /* 未就绪 */
    }
    await wait(250);
  }
  return false;
}

const procs = [];
function startApi() {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/dev-server.mjs', '--no-qr'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(API_PORT), DB_PATH: DB },
    stdio: 'ignore',
  });
  procs.push(p);
  return p;
}
function startWeb() {
  const p = spawn(process.execPath, [path.join('node_modules', 'vite', 'bin', 'vite.js'), '--port', String(WEB_PORT), '--strictPort'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(API_PORT) }, // 让 vite 的 /api 代理指向测试后端
    stdio: 'ignore',
  });
  procs.push(p);
  return p;
}

(async () => {
  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));

  let api = startApi();
  startWeb();
  await waitFor(`${API}/api/health`);
  await waitFor(`${WEB}/`);

  const user = `live_${Date.now().toString().slice(-6)}`;
  const pwd = 'live123456';

  try {
    /* ---------- 1. 未登录状态 ---------- */
    console.log('\n【1】未登录：自选页显示登录引导');
    await page.goto(`${WEB}/#/watchlist`, { waitUntil: 'load' });
    await wait(800);
    const hint = await page.$eval('body', (b) => b.innerText);
    check('显示“登录后自选会保存到账号”引导', hint.includes('登录后自选会保存到账号'));
    check('提供「立即登录」入口', hint.includes('立即登录'));

    /* ---------- 1b. 未登录：不得出现任何静态/演示数据 ---------- */
    console.log('\n【1b】未登录：所有页面不展示静态数据');
    const anonWatch = await page.$eval('body', (b) => b.innerText);
    check('自选页为空态 + 登录引导', anonWatch.includes('登录后可添加自选'), anonWatch.slice(0, 90));
    check('自选页无演示自选基金', !anonWatch.includes('华商新趋势优选混合'));

    await page.goto(`${WEB}/#/`, { waitUntil: 'load' });
    await wait(900);
    const anonLedger = await page.$eval('body', (b) => b.innerText);
    check('账本页显示登录引导', anonLedger.includes('登录后即可记账'));
    check('账本页无静态资产数据', !anonLedger.includes('623,336.79') && !anonLedger.includes('华商新趋势优选混合'), anonLedger.slice(0, 90));
    check('账本页账户资产为 0.00', anonLedger.includes('0.00'));
    check('账本页无演示持仓行', (await page.$$('ul li')).length === 0, String((await page.$$('ul li')).length));

    await page.goto(`${WEB}/#/mine`, { waitUntil: 'load' });
    await wait(900);
    const anonMine = await page.$eval('body', (b) => b.innerText);
    check('我的页显示未登录态', anonMine.includes('未登录'));
    check('我的页无持仓明细（未登录不渲染）', !anonMine.includes('华商新趋势优选混合') && !anonMine.includes('我的持仓明细'));

    await page.goto(`${WEB}/#/add`, { waitUntil: 'load' });
    await wait(900);
    const anonAdd = await page.$eval('body', (b) => b.innerText);
    check('添加持仓页要求登录', anonAdd.includes('登录后即可记账'), anonAdd.slice(0, 80));
    check('添加持仓页不显示表单', !anonAdd.includes('请输入持有金额'));

    /* ---------- 1c. 顶部标题区已剔除，入口改由 Tab / 菜单承载 ---------- */
    console.log('\n【1c】三页顶部无标题区');
    for (const [name, hash] of [['账本', '#/'], ['自选', '#/watchlist'], ['我的', '#/mine']]) {
      await page.goto(`${WEB}/${hash}`, { waitUntil: 'load' });
      await wait(900);
      const h1 = await page.$$eval('h1', (els) => els.map((e) => e.innerText.trim()));
      check(`${name}页无顶部标题（h1）`, h1.length === 0, h1.join(','));
    }
    // 搜索入口改由 ⊕ 操作菜单承载
    await page.goto(`${WEB}/#/`, { waitUntil: 'load' });
    await wait(900);
    await page.click('button[aria-label="账本操作"]');
    await wait(400);
    const menuText = await page.$eval('[role="menu"]', (el) => el.innerText).catch(() => '');
    check('账本 ⊕ 菜单含「搜索基金」入口', menuText.includes('搜索基金'), menuText.replace(/\n/g, ' / '));
    await page.click('[role="menu"] button:first-child');
    await wait(900);
    check('点菜单可进入搜索页', page.url().includes('#/search'), page.url());

    /* ---------- 2. 注册 ---------- */
    console.log('\n【2】注册账号');
    await page.goto(`${WEB}/#/watchlist`, { waitUntil: 'load' });
    await wait(900);
    await page.click('button[aria-label="立即登录"]');
    await wait(400);
    await page.click('button[aria-label="切换到注册"]');
    await wait(200);
    await page.type('input[aria-label="用户名"]', user);
    await page.type('input[aria-label="密码"]', pwd);
    await page.click('button ::-p-text(注册并登录)');
    await wait(1500);
    const afterReg = await page.$eval('body', (b) => b.innerText);
    check('注册成功后登录引导消失', !afterReg.includes('登录后自选会保存到账号'), afterReg.slice(0, 60));
    const meApi = await page.evaluate(async () => (await fetch('/api/auth/me')).json());
    check('会话已建立（/api/auth/me 返回该用户）', meApi.user?.username === user, JSON.stringify(meApi.user));

    /* ---------- 3. 搜索并加入自选 ---------- */
    console.log('\n【3】搜索并「＋自选」→ 落库');
    await page.goto(`${WEB}/#/search`, { waitUntil: 'load' });
    await wait(600);
    await page.type('input[aria-label="搜索基金"]', '白酒');
    await wait(2500);
    const first = await page.$eval('ul li:nth-child(2)', (el) => el.innerText.replace(/\n/g, ' | '));
    check('搜索到基金（真实接口）', /＋自选/.test(first), first);
    const fundCode = (first.match(/(\d{6})/) || [])[1] || '';
    const fundName = first.split('|')[0].trim();
    await page.click('ul li:nth-child(2) button:last-child');
    await wait(1200);

    const listAfterAdd = await page.evaluate(async () => {
      const r = await fetch('/api/watchlist');
      return r.json();
    });
    check('/api/watchlist 已写入（账号落库）', listAfterAdd.items?.some((i) => i.code === fundCode), JSON.stringify(listAfterAdd.items));

    /* ---------- 4. 自选页展示真实行情 ---------- */
    console.log('\n【4】自选页：账号数据 + 真实行情');
    await page.goto(`${WEB}/#/watchlist`, { waitUntil: 'load' });
    await wait(3000);
    const watchText = await page.$eval('body', (b) => b.innerText);
    check('自选页出现该基金', watchText.includes(fundName.slice(0, 6)), watchText.slice(0, 120));
    check('显示实时数据来源', watchText.includes('实时数据'), watchText.split('\n').slice(0, 6).join(' / '));
    check('显示涨幅数值', /[+-]\d+\.\d{2}%/.test(watchText));
    check('状态行标注 60s 自动刷新', watchText.includes('60s'), watchText.split('\n').slice(0, 6).join(' / '));
    await page.screenshot({ path: path.join(ROOT, 'shots', '自选-账号实时.png') });

    /* ---------- 4b. 下拉刷新 + 60s 自动刷新 ---------- */
    console.log('\n【4b】自选页：下拉刷新与 60s 自动刷新');
    let estimateCalls = 0;
    const countEstimate = (req) => {
      if (req.url().includes('/api/estimate')) estimateCalls++;
    };
    page.on('request', countEstimate);
    const cdp = await page.createCDPSession();

    const before = estimateCalls;
    // 模拟手指下拉（CDP 真实触摸事件）
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 320 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y: 430 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y: 540 }] });
    await wait(250);
    const pullText = await page.$eval('[data-testid="ptr"]', (el) => el.innerText);
    check('下拉时出现刷新提示', /松开立即刷新|下拉刷新/.test(pullText), pullText);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await wait(400);
    const refreshingText = await page.$eval('[data-testid="ptr"]', (el) => el.innerText).catch(() => '');
    await wait(2500);
    const doneText = await page.$eval('[data-testid="ptr"]', (el) => el.innerText).catch(() => '');
    check('下拉触发刷新（正在刷新/刷新完成）', /正在刷新|刷新完成/.test(refreshingText + doneText), `${refreshingText} | ${doneText}`);
    check('下拉刷新真的重新请求了行情', estimateCalls > before, `${before} → ${estimateCalls}`);

    // 60 秒自动刷新（按默认间隔实测：等待 62s 观察是否自动重取行情）
    const beforeAuto = estimateCalls;
    console.log('    等待 62s 观察自动刷新…');
    await wait(62000);
    check('60s 自动刷新生效', estimateCalls > beforeAuto, `${beforeAuto} → ${estimateCalls}`);
    page.off('request', countEstimate);

    /* ---------- 5. 我的页：账号信息 ---------- */
    console.log('\n【5】我的页：账号信息（标题居中、不展示接口字段）');
    await page.goto(`${WEB}/#/mine`, { waitUntil: 'load' });
    await wait(1800);
    const mineText = await page.$eval('body', (b) => b.innerText);
    const me = await page.evaluate(async () => (await fetch('/api/auth/me')).json());
    check('username 与接口一致', mineText.includes(me.user.username));
    check('role 渲染为中文', mineText.includes('普通用户') || mineText.includes('管理员'));
    check('普通用户看不到「后台管理」按钮', !mineText.includes('后台管理'));
    check('「我的」页已无「后台概览」展示栏', !mineText.includes('后台概览'));
    check('显示「我的自选 / 我的持仓明细」', mineText.includes('我的自选') && mineText.includes('我的持仓明细'));
    check('已剔除接口字段展示（无 id/created_at 行）', !mineText.includes('created_at') && !/\bid\b/.test(mineText), mineText.slice(0, 100));
    check('已剔除技术性说明文案', !mineText.includes('HttpOnly') && !mineText.includes('/api/auth/me'));
    const tabs = await page.$$eval('nav button', (els) => els.map((e) => e.innerText.trim()));
    check('底部三个 Tab：账本/自选/我的', tabs.join(',') === '账本,自选,我的', tabs.join(','));
    await page.screenshot({ path: path.join(ROOT, 'shots', '我的.png') });

    /* ---------- 6. 添加持仓 → 账号落库 ---------- */
    console.log('\n【6】添加持仓：真实搜索选择器 → /api/positions 落库');
    await page.goto(`${WEB}/#/add`, { waitUntil: 'load' });
    await wait(900);
    await page.click('button[aria-label="选择基金"]');
    await wait(500);
    await page.type('input[aria-label="搜索基金"]', '白酒');
    await wait(2600);
    const pickerFirst = await page.$eval('ul li:first-child', (el) => el.innerText.replace(/\n/g, ' | '));
    check('选择器使用真实搜索', pickerFirst.includes('白酒'), pickerFirst);
    await page.click('ul li:first-child button');
    await wait(400);
    await page.type('input[aria-label="持有金额"]', '12345.67');
    await page.type('input[aria-label="持有收益"]', '-888.5');
    await page.click('button ::-p-text(完成)');
    await wait(1600);
    const posList = await page.evaluate(async () => (await fetch('/api/positions')).json());
    check(
      '持仓已写入 /api/positions',
      Boolean(posList.items?.some((i) => Math.abs(i.amount - 12345.67) < 0.005)),
      JSON.stringify(posList.items),
    );

    /* ---------- 7. 详情页真实数据 ---------- */
    console.log('\n【7】详情页真实数据（含真实重仓股）');
    await page.goto(`${WEB}/#/fund/${fundCode}`, { waitUntil: 'load' });
    await wait(4500);
    const detailText = await page.$eval('body', (b) => b.innerText);
    check('显示净值走势（真实 /api/detail）', detailText.includes('净值走势'));
    check('显示阶段收益与费率', detailText.includes('阶段收益') && detailText.includes('申购费率'));
    check('净值为数值', /净值\(\d{2}-\d{2}\)/.test(detailText), detailText.slice(0, 80));
    const hd = await page.evaluate(async (c) => (await fetch(`/api/holdings?code=${c}`)).json(), fundCode);
    if (hd.items?.length) {
      check('重仓股为真实数据（页面无「演示数据」标记）', !detailText.includes('演示数据'), detailText.slice(0, 80));
      check('页面出现真实重仓股名称', detailText.includes(hd.items[0].name.slice(0, 3)), `${hd.items[0].name} / ${hd.items[0].weight}%`);
      check(
        '重仓股占比与 /api/holdings 一致',
        detailText.includes(hd.items[0].weight.toFixed(2)),
        `api=${hd.items[0].weight.toFixed(2)}%`,
      );
    } else {
      check('重仓股接口可用', false, '未返回持仓明细');
    }

    /* 详情页数值与接口逐项比对（证明是真实数据） */
    const navApi = await page.evaluate(async (c) => (await fetch(`/api/nav?code=${c}&size=2`)).json(), fundCode);
    const navNow = navApi.items?.[0];
    check('详情页净值与 /api/nav 一致', !navNow || detailText.includes(navNow.dwjz), `api=${navNow?.dwjz}`);
    check('详情页净值日期与 /api/nav 一致', !navNow || detailText.includes(String(navNow.date).slice(5)), `api=${navNow?.date}`);
    const dApi = await page.evaluate(async (c) => (await fetch(`/api/detail?code=${c}`)).json(), fundCode);
    if (dApi.trend?.length > 1) {
      check('净值走势点数与 /api/detail 一致', detailText.includes(`近${dApi.trend.length}个交易日`), `api 走势点数=${dApi.trend.length}`);
    }
    await page.screenshot({ path: path.join(ROOT, 'shots', '详情-真实数据.png') });

    /* ---------- 8. 重启后端后仍在 ---------- */
    console.log('\n【8】重启后端：自选与持仓仍在（SQLite 持久化）');
    api.kill('SIGKILL');
    await wait(1200);
    api = startApi();
    await waitFor(`${API}/api/health`);
    const afterRestart = await page.evaluate(async () => {
      const r = await fetch('/api/watchlist');
      return r.json();
    });
    check('重启后 /api/watchlist 仍返回该基金', afterRestart.items?.some((i) => i.code === fundCode), JSON.stringify(afterRestart.items));
    const posAfter = await page.evaluate(async () => (await fetch('/api/positions')).json());
    check(
      '重启后 /api/positions 仍返回该持仓',
      Boolean(posAfter.items?.some((i) => Math.abs(i.amount - 12345.67) < 0.005)),
      JSON.stringify(posAfter.items),
    );
    await page.goto(`${WEB}/#/`, { waitUntil: 'load' });
    await wait(2600);
    const ledgerText = await page.$eval('body', (b) => b.innerText);
    check('账本页显示落库的持仓金额', ledgerText.includes('12,345.67'), ledgerText.slice(0, 120));
    check('账本页状态行标注 60s 自动刷新', ledgerText.includes('60s'), ledgerText.slice(0, 120));

    /* ---------- 8b. 账本 / 自选：点击基金行跳转详情页 ---------- */
    console.log('\n【8b】账本 / 自选：点击基金行跳转详情页');
    const ledgerRow = await page
      .$eval('ul li button', (el) => ({ label: el.getAttribute('aria-label') || '', name: el.innerText.split('\n')[0].trim() }))
      .catch(() => null);
    check('账本持仓行为可点击按钮（带 aria-label）', Boolean(ledgerRow?.label.startsWith('查看')), JSON.stringify(ledgerRow));
    await page.click('ul li button');
    await wait(1800);
    check('账本点击行进入详情页', page.url().includes('#/fund/'), page.url());
    if (ledgerRow) {
      const detailText = await page.$eval('body', (b) => b.innerText);
      check('详情页展示该基金（名称一致）', detailText.includes(ledgerRow.name.slice(0, 4)), `${ledgerRow.name} → ${detailText.slice(0, 50)}`);
    }

    await page.goto(`${WEB}/#/watchlist`, { waitUntil: 'load' });
    await wait(2500);
    const watchRow = await page
      .$eval('ul li button', (el) => ({ name: el.innerText.split('\n')[0].trim() }))
      .catch(() => null);
    await page.click('ul li button');
    await wait(1800);
    check('自选点击行进入详情页', page.url().includes('#/fund/'), page.url());
    if (watchRow) {
      const detailText2 = await page.$eval('body', (b) => b.innerText);
      check('详情页展示该自选基金', detailText2.includes(watchRow.name.slice(0, 4)), `${watchRow.name}`);
    }
    check('账本页无「演示数据」标记', !ledgerText.includes('演示数据'));
    await page.goto(`${WEB}/#/watchlist`, { waitUntil: 'load' });
    await wait(2500);
    const watchText2 = await page.$eval('body', (b) => b.innerText);
    check('重启后页面仍显示该基金', watchText2.includes(fundName.slice(0, 6)));

    /* ---------- 9. 管理员：头像栏入口 + 独立后台页 ---------- */
    console.log('\n【9】管理员：头像栏「后台管理」→ 新标签页查看运营数据');
    await page.goto(`${WEB}/#/mine`, { waitUntil: 'load' });
    await wait(1000);
    const becameAdmin = await page.evaluate(async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'root', password: 'root' }),
      });
      return r.ok;
    });
    check('管理员账号登录成功（root/root）', becameAdmin);

    await page.goto(`${WEB}/#/mine`, { waitUntil: 'load' });
    await page.reload({ waitUntil: 'load' }); // 会话由后端切换，前端需重新读取 /api/auth/me
    await wait(2000);
    const mineAdmin = await page.$eval('body', (b) => b.innerText);
    check('管理员「我的」页出现「后台管理」按钮', mineAdmin.includes('后台管理'), mineAdmin.slice(0, 100));
    check('「我的」页无「后台概览」展示栏', !mineAdmin.includes('后台概览'));

    const adminPagePromise = new Promise((resolve) => {
      browser.once('targetcreated', async (target) => {
        const p = await target.page();
        if (p) resolve(p);
      });
    });
    await page.click('button[aria-label="后台管理"]');
    const adminPage = await adminPagePromise;
    check('点击后打开了新标签页', Boolean(adminPage));
    if (adminPage) {
      await adminPage.waitForSelector('table', { timeout: 20000 }).catch(() => {});
      await wait(1500);
      const adminText = await adminPage.$eval('body', (el) => el.innerText);
      const adminUrl = adminPage.url();
      check('后台页地址为独立页面 /admin.html', adminUrl.includes('admin.html'), adminUrl);
      check('后台页展示系统运营数据', adminText.includes('系统运营数据'), adminText.slice(0, 80));
      check('后台页包含账号/自选/账本/数据分组指标', ['注册用户', '活跃会话', '自选条数', '持仓条数', '行情缓存'].every((k) => adminText.includes(k)));
      check('后台页展示用户列表', adminText.includes('用户列表') && adminText.includes('注册时间'));
      const statsApi = await adminPage.evaluate(async () => (await fetch('/api/admin/stats')).json());
      check('后台页数值与 /api/admin/stats 一致', adminText.includes(String(statsApi.stats.users)), `api users=${statsApi.stats.users}`);
      await adminPage.screenshot({ path: path.join(ROOT, 'shots', '后台管理.png') });
      await adminPage.close();
    }

    /* ---------- 10. 后台页自适应：手机 + PC ---------- */
    console.log('\n【10】后台管理页自适应（手机 / PC）');
    const admin2 = await browser.newPage();
    await admin2.setViewport({ width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await admin2.goto(`${WEB}/admin.html`, { waitUntil: 'load' });
    await wait(2500);
    const mobileText = await admin2.$eval('body', (el) => el.innerText);
    check('手机端：展示运营数据与用户列表', mobileText.includes('系统运营数据') && mobileText.includes('用户列表'), mobileText.slice(0, 80));
    check('手机端：指标卡内容可见', mobileText.includes('注册用户') && mobileText.includes('持仓条数'));
    const overflowMobile = await admin2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('手机端：无横向溢出', overflowMobile <= 1, `${overflowMobile}px`);
    const cardsVisible = await admin2.$eval('[data-testid="admin-user-cards"]', (el) => el.offsetParent !== null).catch(() => false);
    check('手机端：用户列表为卡片布局', cardsVisible);
    const tableOnMobile = await admin2.$eval('[data-testid="admin-user-table"]', (el) => el.offsetParent !== null).catch(() => true);
    check('手机端：表格布局已隐藏', !tableOnMobile);
    await admin2.screenshot({ path: path.join(ROOT, 'shots', '后台管理-手机.png') });

    await admin2.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await wait(1200);
    const overflowPc = await admin2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('PC 端：无横向溢出', overflowPc <= 1, `${overflowPc}px`);
    const tableOnPc = await admin2.$eval('[data-testid="admin-user-table"]', (el) => el.offsetParent !== null).catch(() => false);
    check('PC 端：显示表格布局', tableOnPc);
    const cardsOnPc = await admin2.$eval('[data-testid="admin-user-cards"]', (el) => el.offsetParent !== null).catch(() => true);
    check('PC 端：卡片布局已隐藏', !cardsOnPc);
    await admin2.screenshot({ path: path.join(ROOT, 'shots', '后台管理.png') });

    await admin2.setViewport({ width: 768, height: 1024, deviceScaleFactor: 2 });
    await wait(800);
    const overflowTablet = await admin2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('平板端：无横向溢出', overflowTablet <= 1, `${overflowTablet}px`);
    await admin2.close();

    check('无 JS 运行时错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

    console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  } catch (e) {
    console.error('测试异常:', e.message);
    fail++;
  } finally {
    for (const p of procs) {
      try {
        p.kill('SIGKILL');
      } catch {
        /* 忽略 */
      }
    }
    await browser.close();
    await wait(500);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
  process.exit(fail === 0 ? 0 : 1);
})();
