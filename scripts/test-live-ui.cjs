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
    // 轮询等待会话建立（机器负载高时固定等待不可靠）
    let meApi = { user: null };
    for (let i = 0; i < 40; i++) {
      await wait(250);
      meApi = await page.evaluate(async () => (await fetch('/api/auth/me')).json());
      if (meApi.user?.username === user) break;
    }
    await wait(800); // 让前端把登录态渲染出来
    const afterReg = await page.$eval('body', (b) => b.innerText);
    check('注册成功后登录引导消失', !afterReg.includes('登录后自选会保存到账号'), afterReg.slice(0, 60));
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
    check('username 与接口一致', Boolean(me.user) && mineText.includes(me.user.username), JSON.stringify(me.user));
    check('role 渲染为中文', mineText.includes('普通用户') || mineText.includes('管理员'));
    check('普通用户看不到「后台管理」按钮', !mineText.includes('后台管理'));
    check('「我的」页已无「后台概览」展示栏', !mineText.includes('后台概览'));
    check('显示「我的自选 / 持仓穿透」入口', mineText.includes('我的自选') && mineText.includes('持仓穿透'));
    check('「我的」页不再平铺持仓明细', !mineText.includes('我的持仓明细'), mineText.slice(0, 100));
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

    /* ---------- 8c. 持仓收益率：展示 + 排序 ---------- */
    console.log('\n【8c】持仓收益率：逐只展示 + 点击表头排序');
    // 再补两只持仓（收益率差异明显，便于验证排序），随后整页重载
    await page.evaluate(async () => {
      const items = [
        { code: '006274', name: '圆信永丰医药健康A', amount: 36226.29, profit: -1497.52 },
        { code: '163406', name: '兴全合润混合A', amount: 48528.41, profit: 5752.3 },
      ];
      for (const it of items) {
        await fetch('/api/positions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(it),
        });
      }
      await fetch('/api/portfolio?refresh=1');
    });
    await page.goto(`${WEB}/#/`, { waitUntil: 'load' });
    await page.reload({ waitUntil: 'load' });
    await wait(3000);

    const pfNow = await page.evaluate(async () => (await fetch('/api/portfolio')).json());
    const readRates = () =>
      page.$$eval('[data-testid^="rate-"]', (els) =>
        els.map((e) => ({ code: e.dataset.testid.slice(5), text: e.innerText.trim() })),
      );

    const shownRates = await readRates();
    check(
      '每只持仓都展示收益率',
      shownRates.length === pfNow.portfolio.items.length && shownRates.length >= 3,
      `${shownRates.length} vs ${pfNow.portfolio.items.length}`,
    );
    const apiRate = new Map(pfNow.portfolio.items.map((i) => [i.code, i.rate]));
    const rateMismatch = shownRates.filter((s) => {
      const r = apiRate.get(s.code);
      const expect = r === null || r === undefined ? '—' : `收益率 ${r >= 0 ? '+' : ''}${r.toFixed(2)}%`;
      return s.text !== expect;
    });
    check('收益率与接口计算值一致', rateMismatch.length === 0, JSON.stringify(rateMismatch).slice(0, 140));
    const sample = pfNow.portfolio.items.find((i) => i.code === '163406');
    check(
      '口径 = 持有收益 / 本金（本金 = 金额 - 收益）',
      Boolean(sample) && Math.abs(sample.rate - (5752.3 / (48528.41 - 5752.3)) * 100) < 0.01,
      JSON.stringify(sample),
    );

    // 表头三列均可排序
    for (const label of ['当日收益', '当日涨幅', '收益率']) {
      const btn = await page.$(`button[aria-label="按${label}排序"]`);
      check(`表头「${label}」可排序`, btn !== null);
    }

    const parseRates = (list) => list.map((t) => Number((t.match(/-?\d+\.\d+/) || ['NaN'])[0]));
    await page.click('button[aria-label="按收益率排序"]');
    await wait(900);
    const descRates = parseRates((await readRates()).map((r) => r.text));
    check(
      '点击「收益率」表头按降序排列',
      descRates.every((v, i) => i === 0 || descRates[i - 1] >= v),
      descRates.join(', '),
    );
    await page.click('button[aria-label="按收益率排序"]');
    await wait(900);
    const ascRates = parseRates((await readRates()).map((r) => r.text));
    check(
      '再次点击切换为升序排列',
      ascRates.every((v, i) => i === 0 || ascRates[i - 1] <= v),
      ascRates.join(', '),
    );
    await page.screenshot({ path: path.join(ROOT, 'shots', '账本-持仓收益率.png') });

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
    const tableOnMobile = await admin2.$('[data-testid="admin-user-table"]');
    check('手机端：表格布局未渲染（单套 DOM）', tableOnMobile === null);
    await admin2.screenshot({ path: path.join(ROOT, 'shots', '后台管理-手机.png') });

    await admin2.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await wait(1200);
    const overflowPc = await admin2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('PC 端：无横向溢出', overflowPc <= 1, `${overflowPc}px`);
    const tableOnPc = await admin2.$('[data-testid="admin-user-table"]');
    check('PC 端：显示表格布局', tableOnPc !== null);
    const cardsOnPc = await admin2.$('[data-testid="admin-user-cards"]');
    check('PC 端：卡片布局未渲染（单套 DOM）', cardsOnPc === null);
    await admin2.screenshot({ path: path.join(ROOT, 'shots', '后台管理.png') });

    await admin2.setViewport({ width: 768, height: 1024, deviceScaleFactor: 2 });
    await wait(800);
    const overflowTablet = await admin2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('平板端：无横向溢出', overflowTablet <= 1, `${overflowTablet}px`);
    await admin2.close();

    /* ---------- 11. 后台用户管理：重置登录密码 + 级联删除 ---------- */
    console.log('\n【11】后台用户管理：重置登录密码 + 级联删除用户');
    const adm3 = await browser.newPage();
    await adm3.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await adm3.goto(`${WEB}/admin.html`, { waitUntil: 'load' });
    await wait(1500);

    // 造一个待管理用户（含自选 + 持仓 + 每日快照），随后切回管理员会话
    const target = await adm3.evaluate(async () => {
      const username = `todel_${Math.random().toString(36).slice(2, 7)}`;
      const reg = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'del123456' }),
      });
      if (!reg.ok) return null;
      await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '161725', name: '招商中证白酒指数(LOF)A' }),
      });
      await fetch('/api/positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '161725', name: '招商中证白酒指数(LOF)A', amount: 1000, profit: 10 }),
      });
      await fetch('/api/portfolio'); // 触发该用户每日快照，便于验证级联
      await fetch('/api/auth/logout', { method: 'POST' });
      const back = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'root', password: 'root' }),
      });
      return { username, adminAgain: back.ok };
    });
    check('已创建待管理用户并切回管理员', Boolean(target?.username) && target?.adminAgain, JSON.stringify(target));

    const statsBefore = await adm3.evaluate(async () => (await fetch('/api/admin/stats')).json());
    await adm3.reload({ waitUntil: 'load' });
    await wait(2200);

    // --- 重置密码 ---
    await adm3.click(`button[aria-label="重置 ${target.username} 的密码"]`);
    await wait(700);
    const resetModal = await adm3.$eval('body', (el) => el.innerText);
    check('弹出「重置登录密码」窗口', resetModal.includes('重置登录密码'), resetModal.slice(0, 60));
    await adm3.click('button[aria-label="生成随机密码"]');
    await wait(300);
    const generated = await adm3.$eval('input[aria-label="新密码"]', (el) => el.value);
    check('可一键生成随机密码（12 位）', generated.length === 12, generated);
    await adm3.click('button[aria-label="确认重置密码"]');
    await wait(1800);
    const resetNotice = await adm3.$eval('[data-testid="admin-notice"]', (el) => el.innerText).catch(() => '');
    check('重置成功并给出提示', resetNotice.includes('已重置'), resetNotice);
    const shownPassword = await adm3.$eval('[data-testid="new-password"]', (el) => el.textContent.trim()).catch(() => '');
    check('成功后弹层保持打开并回显新密码（便于转达）', shownPassword === generated, `${shownPassword} vs ${generated}`);
    await adm3.click('button[aria-label="关闭"]');
    await wait(400);
    const modalGone = await adm3.$('[data-testid="new-password"]');
    check('关闭后弹层消失', modalGone === null);

    const pwCheck = await adm3.evaluate(
      async ({ username, password }) => {
        await fetch('/api/auth/logout', { method: 'POST' });
        const oldPw = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password: 'del123456' }),
        });
        const newPw = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        return { oldStatus: oldPw.status, newStatus: newPw.status };
      },
      { username: target.username, password: generated },
    );
    check('重置后旧密码失效、新密码可登录', pwCheck.oldStatus === 401 && pwCheck.newStatus === 200, JSON.stringify(pwCheck));

    // 切回管理员并重载后台页
    await adm3.evaluate(async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'root', password: 'root' }),
      });
    });
    await adm3.reload({ waitUntil: 'load' });
    await wait(2200);

    // --- 级联删除 ---
    const adminDeleteDisabled = await adm3.$eval('button[aria-label="删除用户 root"]', (el) => el.disabled).catch(() => null);
    check('管理员账号的删除按钮为禁用态', adminDeleteDisabled === true, String(adminDeleteDisabled));

    await adm3.click(`button[aria-label="删除用户 ${target.username}"]`);
    await wait(700);
    const deleteModal = await adm3.$eval('body', (el) => el.innerText);
    check('删除弹层说明级联范围', deleteModal.includes('级联删除') && deleteModal.includes('自选基金'), deleteModal.slice(0, 120));
    const submitDisabled = await adm3.$eval('button[aria-label="确认删除用户"]', (el) => el.disabled);
    check('未输入用户名时确认按钮禁用', submitDisabled === true);
    await adm3.type('input[aria-label="输入用户名确认删除"]', target.username);
    await wait(300);
    await adm3.click('button[aria-label="确认删除用户"]');
    await wait(2000);
    const deleteNotice = await adm3.$eval('[data-testid="admin-notice"]', (el) => el.innerText).catch(() => '');
    check('删除成功并提示级联清理', deleteNotice.includes('已删除'), deleteNotice);

    const afterDelete = await adm3.evaluate(async () => (await fetch('/api/admin/stats')).json());
    check(
      '级联：该用户持仓与每日快照从统计中消失',
      afterDelete.stats.positionsItems < statsBefore.stats.positionsItems &&
        afterDelete.stats.positionDailyRows < statsBefore.stats.positionDailyRows,
      `before=${statsBefore.stats.positionsItems}/${statsBefore.stats.positionDailyRows} after=${afterDelete.stats.positionsItems}/${afterDelete.stats.positionDailyRows}`,
    );
    const goneInList = await adm3.evaluate(async (u) => {
      const r = await fetch(`/api/admin/users?q=${encodeURIComponent(u)}`);
      return (await r.json()).total;
    }, target.username);
    check('列表中已无该用户', goneInList === 0, String(goneInList));

    const loginGone = await adm3.evaluate(
      async ({ username, password }) => {
        const r = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        return r.status;
      },
      { username: target.username, password: generated },
    );
    check('被删用户无法再登录', loginGone === 401, String(loginGone));

    await adm3.screenshot({ path: path.join(ROOT, 'shots', '后台管理-用户操作.png') });
    await adm3.close();

    /* ---------- 12. 系统运营数据：点击指标卡查看明细 ---------- */
    console.log('\n【12】系统运营数据：点击指标卡下钻明细');
    const adm4 = await browser.newPage();
    await adm4.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await adm4.goto(`${WEB}/admin.html`, { waitUntil: 'load' });
    await wait(2500);

    const statsForMetric = await adm4.evaluate(async () => (await fetch('/api/admin/stats')).json());
    await adm4.click('button[aria-label="查看注册用户明细"]');
    await wait(1600);
    const metricModal = await adm4.$eval('[data-testid="metric-detail"]', (el) => el.innerText).catch(() => '');
    check('点击指标卡弹出明细弹层', metricModal.includes('注册用户') && metricModal.includes('共'), metricModal.slice(0, 80));
    check('明细含列头与接口口径', metricModal.includes('用户名') && metricModal.includes('注册时间'));
    const userRows = await adm4.$$eval('[data-testid="metric-detail"] tbody tr', (els) => els.length);
    check('注册用户明细行数与统计一致', userRows === statsForMetric.stats.users, `${userRows} vs ${statsForMetric.stats.users}`);
    await adm4.screenshot({ path: path.join(ROOT, 'shots', '后台管理-指标明细.png') });

    await adm4.click('button[aria-label="关闭明细"]');
    await wait(500);
    check('关闭后明细弹层消失', (await adm4.$('[data-testid="metric-detail"]')) === null);

    await adm4.click('button[aria-label="查看自选条数明细"]');
    await wait(1600);
    const wlRows = await adm4.$$eval('[data-testid="metric-detail"] tbody tr', (els) => els.length);
    check('自选条数明细行数与统计一致', wlRows === statsForMetric.stats.watchlistItems, `${wlRows} vs ${statsForMetric.stats.watchlistItems}`);
    await adm4.click('button[aria-label="关闭明细"]');
    await wait(400);

    // 手机端：明细弹层自适应且不横向溢出
    await adm4.setViewport({ width: 360, height: 800, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await wait(900);
    await adm4.click('button[aria-label="查看持仓条数明细"]');
    await wait(1600);
    const metricGoneOnMobile = await adm4.$eval('[data-testid="metric-detail"]', (el) => el.offsetParent !== null).catch(() => false);
    check('手机端：明细弹层正常展示', metricGoneOnMobile);
    const metricOverflow = await adm4.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('手机端：明细弹层无横向溢出', metricOverflow <= 1, `${metricOverflow}px`);
    await adm4.screenshot({ path: path.join(ROOT, 'shots', '后台管理-指标明细-手机.png') });
    await adm4.close();

    check('无 JS 运行时错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

    /* ---------- 13. 我的页：不展示持仓明细 + 持仓穿透 ---------- */
    console.log('\n【13】我的页：持仓明细下线 + 持仓穿透（个股 / 比重 / 涉及基金）');
    const ltPage = await browser.newPage();
    ltPage.on('pageerror', (e) => jsErrors.push(`[lookthrough] ${e.message}`));
    await ltPage.setViewport({ width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await ltPage.goto(`${WEB}/#/`, { waitUntil: 'load' });

    const ltUser = await ltPage.evaluate(async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      const username = `lt_${Math.random().toString(36).slice(2, 7)}`;
      const reg = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'lt123456' }),
      });
      if (!reg.ok) return null;
      const items = [
        { code: '161725', name: '招商中证白酒指数(LOF)A', amount: 60000, profit: -1500 },
        { code: '163406', name: '兴全合润混合A', amount: 30000, profit: 3200 },
        { code: '006274', name: '圆信永丰医药健康A', amount: 10000, profit: -420 },
      ];
      for (const it of items) {
        await fetch('/api/positions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(it),
        });
      }
      return { username };
    });
    check('已创建穿透测试账号（3 只持仓）', Boolean(ltUser?.username), JSON.stringify(ltUser));

    await ltPage.goto(`${WEB}/#/mine`, { waitUntil: 'load' });
    await ltPage.reload({ waitUntil: 'load' });
    await wait(2600);
    const mineText2 = await ltPage.$eval('body', (el) => el.innerText);
    check('我的页不再展示持仓明细', !mineText2.includes('我的持仓明细'), mineText2.slice(0, 80));
    check('我的页提供「持仓穿透」入口', mineText2.includes('持仓穿透'));
    check('「我的自选」下方提供「我的持仓」入口', mineText2.includes('我的自选') && mineText2.includes('我的持仓'));

    // 「我的持仓」显示持仓基金数，点击跳转账本
    const posEntryHint = await ltPage.$eval('button[aria-label="我的持仓"]', (el) => el.innerText.replace(/[^\d]/g, ''));
    check('「我的持仓」显示持仓基金数 = 3', posEntryHint === '3', posEntryHint);
    await ltPage.click('button[aria-label="我的持仓"]');
    await wait(2500);
    const ledgerUrl = ltPage.url();
    const ledgerText2 = await ltPage.$eval('body', (el) => el.innerText);
    check('点击「我的持仓」跳转到账本主页', ledgerUrl.endsWith('#/') || ledgerUrl.endsWith('#'), ledgerUrl);
    check('账本页展示账户资产与持仓', ledgerText2.includes('账户资产') && ledgerText2.includes('¥'), ledgerText2.slice(0, 70));

    await ltPage.goto(`${WEB}/#/mine`, { waitUntil: 'load' });
    await wait(2000);
    await ltPage.click('button[aria-label="持仓穿透"]');
    await wait(6000);
    check('进入持仓穿透页', ltPage.url().includes('#/lookthrough'), ltPage.url());

    const ltApi = await ltPage.evaluate(async () => (await fetch('/api/portfolio/lookthrough')).json());
    const ltData = ltApi.lookthrough;
    const ltText = await ltPage.$eval('body', (el) => el.innerText);
    check('展示穿透资产与覆盖率', ltText.includes('穿透资产') && ltText.includes('重仓股覆盖'), ltText.slice(0, 90));
    check('穿透出个股（多只基金参与）', ltData.items.length > 0, `${ltData.items.length} 只个股`);
    check('说明仅覆盖前十大重仓股', ltText.includes('前十大重仓股') && ltText.includes('覆盖率通常小于 100%'));

    const ltRows = await ltPage.$$eval('ul li button[aria-label$="穿透明细"]', (els) =>
      els.map((e) => e.getAttribute('aria-label')),
    );
    check('个股行数与接口一致', ltRows.length === ltData.items.length, `${ltRows.length} vs ${ltData.items.length}`);

    const money = (n) => n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const topStock = ltData.items[0];
    check('首行展示穿透金额', ltText.includes(`¥${money(topStock.amount)}`), `期望 ¥${money(topStock.amount)}`);
    check('首行展示占账户比', ltText.includes(`占账户 ${topStock.ratio.toFixed(2)}%`), `期望 ${topStock.ratio.toFixed(2)}%`);

    // 展开 → 看具体哪几只基金持有
    await ltPage.click('ul li button[aria-label$="穿透明细"]');
    await wait(900);
    const expandedText = await ltPage.$eval('body', (el) => el.innerText);
    check(
      '展开后显示涉及基金及其占净值比',
      expandedText.includes('占净值') && expandedText.includes(topStock.funds[0].name.slice(0, 6)),
      `期望包含 ${topStock.funds[0].name} / 占净值 ${topStock.funds[0].weight.toFixed(2)}%`,
    );
    check('涉及基金的贡献金额与接口一致', expandedText.includes(`¥${money(topStock.funds[0].amount)}`));
    await ltPage.screenshot({ path: path.join(ROOT, 'shots', '持仓穿透.png') });

    // 排序：按涉及基金数
    const byFunds = [...ltData.items].sort((a, b) => b.fundCount - a.fundCount);
    await ltPage.click('button[aria-label="按涉及基金数排序"]');
    await wait(900);
    const sortedFirst = (await ltPage.$$eval('ul li button[aria-label$="穿透明细"]', (els) => els.map((e) => e.getAttribute('aria-label'))))[0] || '';
    check('按涉及基金数排序生效', sortedFirst.includes(byFunds[0].name.slice(0, 5)), `${sortedFirst} vs ${byFunds[0].name}`);

    // 点击穿透中的基金 → 基金详情
    await ltPage.click(`ul li button[aria-label="查看 ${topStock.funds[0].name} 详情"]`);
    await wait(1800);
    check('点击穿透中的基金进入详情页', ltPage.url().includes('#/fund/'), ltPage.url());
    check('详情页标题为对应基金', (await ltPage.$eval('body', (el) => el.innerText)).includes(topStock.funds[0].name.slice(0, 6)));
    await ltPage.close();

    /* ---------- 14. 我的页：基金相关性分析 ---------- */
    console.log('\n【14】' + '基金相关性分析：走势相似程度（矩阵 / 最相似 / 最分散）');
    const corrPage = await browser.newPage();
    corrPage.on('pageerror', (e) => jsErrors.push(`[correlation] ${e.message}`));
    await corrPage.setViewport({ width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await corrPage.goto(`${WEB}/#/`, { waitUntil: 'load' });

    const corrUser = await corrPage.evaluate(async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      const username = `cr_${Math.random().toString(36).slice(2, 7)}`;
      const reg = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'cr123456' }),
      });
      if (!reg.ok) return null;
      const items = [
        { code: '161725', name: '招商中证白酒指数(LOF)A', amount: 60000 },
        { code: '163406', name: '兴全合润混合A', amount: 30000 },
        { code: '006274', name: '圆信永丰医药健康A', amount: 10000 },
        { code: '005827', name: '易方达蓝筹精选混合', amount: 20000 },
      ];
      for (const it of items) {
        await fetch('/api/positions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...it, profit: 0 }),
        });
      }
      return { username };
    });
    check('已创建相关性测试账号（4 只基金）', Boolean(corrUser?.username), JSON.stringify(corrUser));

    await corrPage.goto(`${WEB}/#/mine`, { waitUntil: 'load' });
    await corrPage.reload({ waitUntil: 'load' });
    await wait(2600);
    const mineText3 = await corrPage.$eval('body', (el) => el.innerText);
    check('我的页提供「基金相关性分析」入口', mineText3.includes('基金相关性分析'));

    await corrPage.click('button[aria-label="基金相关性分析"]');
    await wait(9000);
    check('进入基金相关性分析页', corrPage.url().includes('#/correlation'), corrPage.url());

    const corrApi = await corrPage.evaluate(async () => (await fetch('/api/portfolio/correlation?days=60')).json());
    const cd = corrApi.correlation;
    const corrText = await corrPage.$eval('body', (el) => el.innerText);
    check('展示平均相关性与区间', corrText.includes('平均相关性') && corrText.includes(`${cd.pointCount} 天`), corrText.slice(0, 90));
    check('平均相关性与接口一致', corrText.includes(cd.avgCorr.toFixed(2)), `期望 ${cd.avgCorr.toFixed(2)}`);
    check('展示最相似 / 最分散组合', corrText.includes('最相似') && corrText.includes('最分散'));
    check('最相似组合名称与接口一致', corrText.includes(cd.mostSimilar.aName.slice(0, 5)) && corrText.includes(cd.mostSimilar.corr.toFixed(2)));
    check('最分散组合相关性一致', corrText.includes(cd.mostDiverse.corr.toFixed(2)), `期望 ${cd.mostDiverse.corr.toFixed(2)}`);

    const cells = await corrPage.$$eval('td[data-testid^="corr-"]', (els) => els.map((e) => e.textContent.trim()));
    check('矩阵为 N×N（16 格）', cells.length === cd.fundCount ** 2, `${cells.length} vs ${cd.fundCount ** 2}`);
    const n = cd.fundCount;
    check('对角线均为 1.00', Array.from({ length: n }, (_, i) => cells[i * n + i]).every((t) => t === '1.00'), JSON.stringify(Array.from({ length: n }, (_, i) => cells[i * n + i])));
    const symmetrical = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => cells[i * n + j] === cells[j * n + i])).flat().every(Boolean);
    check('矩阵在页面上左右对称', symmetrical, JSON.stringify(cells));
    const onScreen = cells.map((t) => (t === '—' ? null : Number(t)));
    check('矩阵数值与接口一致', onScreen.every((v, k) => Math.abs(v - cd.matrix[Math.floor(k / n)][k % n]) < 0.005), JSON.stringify(onScreen));

    // 归一化走势对比图（起点 100 的多条折线 + 图例）
    const paths = await corrPage.$$eval('[data-testid="trend-compare"] path', (els) => els.length);
    check('走势对比图渲染出每条基金的曲线', paths === cd.series.length, `${paths} vs ${cd.series.length}`);
    const legend = await corrPage.$$eval('[data-testid="trend-legend"] li', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
    check('走势图图例与基金一一对应', legend.length === cd.series.length, JSON.stringify(legend).slice(0, 120));
    const changes = await corrPage.$$eval('[data-testid="trend-changes"] li', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
    check(
      '区间涨跌列表与接口一致',
      changes.length === cd.series.length &&
        cd.series.every((s, i) => changes[i]?.includes(`${s.totalChange >= 0 ? '+' : ''}${s.totalChange.toFixed(2)}%`)),
      JSON.stringify({ changes, series: cd.series.map((s) => s.totalChange) }).slice(0, 160),
    );

    // 切换窗口：共同交易日应变化并与接口一致
    await corrPage.click('button[aria-label="近120个交易日"]');
    await wait(9000);
    const corrApi120 = await corrPage.evaluate(async () => (await fetch('/api/portfolio/correlation?days=120')).json());
    const t120 = await corrPage.$eval('body', (el) => el.innerText);
    check(
      '切换近 120 日后样本数变化且与接口一致',
      t120.includes(`${corrApi120.correlation.pointCount} 天`) && corrApi120.correlation.pointCount > cd.pointCount,
      `${corrApi120.correlation.pointCount} vs ${cd.pointCount}`,
    );
    const overflowCorr = await corrPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('相关性页无横向溢出', overflowCorr <= 1, `${overflowCorr}px`);
    await corrPage.screenshot({ path: path.join(ROOT, 'shots', '基金相关性分析.png') });
    await corrPage.close();

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
