/**
 * 移动端横向溢出诊断 / 回归测试
 *   node scripts/check-overflow.cjs [--verbose]
 *
 * 覆盖：
 *   - Android 常见宽度：320 / 360 / 412 / 480
 *   - iOS：375 / 393
 *   - 平板与 PC：768 / 1024 / 1280
 *   - 前台 7 个页面（已登录、带真实数据）+ 后台管理页（管理员）
 *
 * 判定：documentElement.scrollWidth > innerWidth 即溢出；并列出**具体越界元素**（含宽度与原因），
 *       便于定位是哪一个节点撑破了视口。退出码非 0 表示存在溢出。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const API_PORT = 8792;
const WEB_PORT = 4178;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
const VERBOSE = process.argv.includes('--verbose');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fundwatch-overflow-'));
const DB = path.join(tmp, 'fundwatch.db');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = [
  { name: 'Android 320', width: 320, height: 640, dpr: 2 },
  { name: 'Android 360', width: 360, height: 800, dpr: 3 },
  { name: 'Android 412', width: 412, height: 915, dpr: 2.6 },
  { name: 'Android 480', width: 480, height: 800, dpr: 2 },
  { name: 'iPhone SE 375', width: 375, height: 667, dpr: 2 },
  { name: 'iPhone 14 393', width: 393, height: 852, dpr: 3 },
  { name: 'Tablet 768', width: 768, height: 1024, dpr: 2 },
  { name: 'Tablet 1024', width: 1024, height: 768, dpr: 2 },
  { name: 'Android 横屏 640×360', width: 640, height: 360, dpr: 3 },
  { name: 'Android 横屏 800×360', width: 800, height: 360, dpr: 3 },
  { name: 'Android 横屏 915×412', width: 915, height: 412, dpr: 2.6 },
  { name: 'PC 1280', width: 1280, height: 800, dpr: 1 },
];

const PAGES = [
  { name: '账本', hash: '#/' },
  { name: '自选', hash: '#/watchlist' },
  { name: '我的', hash: '#/mine' },
  { name: '搜索', hash: '#/search' },
  { name: '详情', hash: '#/fund/006274' },
  { name: '添加持仓', hash: '#/add' },
  { name: '修改持仓', hash: '#/edit' },
  { name: '账本设置', hash: '#/settings' },
  { name: '后台管理', url: '/admin.html' },
];

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    if (VERBOSE) console.log(`  ✅ ${name}`);
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

/** 页面内采集：文档溢出量 + 越界元素清单 */
const PROBE = () => {
  const vw = window.innerWidth;
  const docOverflow = document.documentElement.scrollWidth - vw;
  const offenders = [];
  const describe = (el) => {
    const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ''}${cls ? `.${cls.replace(/\s+/g, '.')}` : ''}${text ? ` “${text}”` : ''}`;
  };
  for (const el of document.querySelectorAll('body *')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'fixed') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const overRight = rect.right - vw;
    const selfScroll = el.scrollWidth - el.clientWidth;
    // 自身内容溢出且未设滚动/裁切，或整体越出视口右侧
    const clips = ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX);
    if (overRight > 1 || (selfScroll > 1 && !clips)) {
      offenders.push({
        el: describe(el),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        overRight: Math.round(overRight),
        selfScroll: Math.round(selfScroll),
        overflowX: style.overflowX,
        minWidth: style.minWidth,
      });
    }
  }
  // 只保留最外层（过滤掉父子重复），按越界量排序
  offenders.sort((a, b) => b.overRight + b.selfScroll - (a.overRight + a.selfScroll));

  // 关键交互元素是否被裁切（横屏矮视口最容易出现：底部 TabBar / 底部按钮被切掉）
  const clipped = [];
  const nav = document.querySelector('nav');
  if (nav) {
    const r = nav.getBoundingClientRect();
    if (r.bottom > window.innerHeight + 1 || r.height === 0) {
      clipped.push(`底部 TabBar 被裁切（bottom=${Math.round(r.bottom)} > 视口高 ${window.innerHeight}）`);
    }
  }
  return { vw, docOverflow, offenders: offenders.slice(0, 6), clipped };
};

(async () => {
  let server;
  let web;
  const browser = (() => null)();
  const procs = [];
  try {
    const puppeteer = loadPuppeteer();
    server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/dev-server.mjs', '--no-qr'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(API_PORT), DB_PATH: DB },
      stdio: 'ignore',
    });
    procs.push(server);
    web = spawn(process.execPath, [path.join('node_modules', 'vite', 'bin', 'vite.js'), '--port', String(WEB_PORT), '--strictPort'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(API_PORT) },
      stdio: 'ignore',
    });
    procs.push(web);
    await waitFor(`${API}/api/health`);
    await waitFor(`${WEB}/`);

    const b = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      args: ['--no-sandbox'],
    });
    const page = await b.newPage();
    await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(`${WEB}/#/`, { waitUntil: 'load' });

    // 准备数据：注册普通用户 + 写入持仓/自选；再确保管理员会话可用
    const seeded = await page.evaluate(async () => {
      const username = `ov_${Math.random().toString(36).slice(2, 8)}`;
      const reg = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'ov123456' }),
      });
      const positions = [
        { code: '161725', name: '招商中证白酒指数(LOF)A', amount: 66209, profit: -1599.3 },
        { code: '006274', name: '圆信永丰医药健康A', amount: 36226.29, profit: -1497.52 },
        { code: '270023', name: '广发全球精选股票(QDII)人民币A', amount: 17201.78, profit: 1198.05 },
        { code: '003095', name: '中欧医疗健康混合A', amount: 96357.9, profit: -11718.65 },
      ];
      for (const p of positions) {
        await fetch('/api/positions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
      }
      await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '161725', name: '招商中证白酒指数(LOF)A' }),
      });
      return { ok: reg.ok, username };
    });
    console.log(`准备数据：注册 ${seeded.username} → ${seeded.ok ? '成功' : '失败'}`);

    for (const vp of VIEWPORTS) {
      console.log(`\n【${vp.name}】${vp.width}×${vp.height}`);
      await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, isMobile: vp.width < 768, hasTouch: vp.width < 768 });
      for (const p of PAGES) {
        // 后台页需要管理员会话；普通页面需要普通用户会话
        if (p.name === '后台管理') {
          await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
          await page.evaluate(() =>
            fetch('/api/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: 'root', password: 'root' }),
            }),
          );
          await page.goto(`${WEB}${p.url}`, { waitUntil: 'load' });
        } else {
          await page.goto(`${WEB}/${p.hash}`, { waitUntil: 'load' });
        }
        await wait(p.name === '详情' ? 3000 : 1400);
        const res = await page.evaluate(PROBE);
        const label = `${vp.name} · ${p.name}`;
        check(`${label} 无横向溢出`, res.docOverflow <= 1, `溢出 ${res.docOverflow}px`);
        check(`${label} 关键元素未被裁切`, res.clipped.length === 0, res.clipped.join('; '));
        if (res.docOverflow > 1 || res.offenders.length || res.clipped.length) {
          for (const o of res.offenders) {
            console.log(
              `     ↳ 越界元素：${o.el}\n       宽 ${o.width}px / 右边界 ${o.right} / 超出 ${o.overRight}px / 自身滚动 ${o.selfScroll} / overflowX=${o.overflowX} / min-width=${o.minWidth}`,
            );
          }
        }
      }
      // 切回普通用户，继续下一轮
      await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
      await page.evaluate(
        (username) =>
          fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password: 'ov123456' }),
          }),
        seeded.username,
      );
    }

    await b.close();
    console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  } catch (e) {
    console.error('诊断异常:', e.message, e.stack?.split('\n')[1] || '');
    fail++;
  } finally {
    for (const p of procs) {
      try {
        p.kill('SIGKILL');
      } catch {
        /* 忽略 */
      }
    }
    await wait(400);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
  process.exit(fail === 0 ? 0 : 1);
})();
