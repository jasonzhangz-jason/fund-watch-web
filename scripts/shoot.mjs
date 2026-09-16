/**
 * 逐页截图脚本（用于与参考截图做还原度比对）
 *
 * 依赖解析顺序：
 *   1. 环境变量 PUPPETEER_MODULE —— puppeteer 包所在目录（NODE_PATH 亦可）
 *   2. 项目本地 node_modules 中的 puppeteer
 * 浏览器（Chromium）解析顺序：
 *   1. 环境变量 PUPPETEER_EXECUTABLE_PATH
 *   2. 环境变量 PUPPETEER_CACHE_DIR / 默认 ~/.cache/puppeteer 中已下载的 Chrome
 *
 * 用法：
 *   node scripts/shoot.mjs                  # 截全部页面 → shots/
 *   node scripts/shoot.mjs home watchlist   # 只截指定页面
 */
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'shots');
const BASE = process.env.SHOOT_BASE || 'http://127.0.0.1:4173';

/* ---------------- 解析 puppeteer ---------------- */
function loadPuppeteer() {
  const candidates = [];
  if (process.env.PUPPETEER_MODULE) candidates.push(process.env.PUPPETEER_MODULE);
  if (process.env.NODE_PATH) candidates.push(...process.env.NODE_PATH.split(path.delimiter).filter(Boolean));
  candidates.push(path.join(ROOT, 'node_modules'));
  for (const dir of candidates) {
    try {
      const req = createRequire(pathToFileURL(path.join(dir, 'noop.js')).href);
      return req('puppeteer');
    } catch {
      /* 继续尝试 */
    }
  }
  throw new Error('未找到 puppeteer。请设置 PUPPETEER_MODULE / NODE_PATH，或 npm i -D puppeteer');
}

/* ---------------- 解析 Chromium ---------------- */
function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const cache = process.env.PUPPETEER_CACHE_DIR || path.join(process.env.USERPROFILE || process.env.HOME || '', '.cache', 'puppeteer', 'chrome');
  if (!existsSync(cache)) return undefined;
  for (const ver of readdirSync(cache)) {
    const exe = path.join(cache, ver, process.platform === 'win32' ? 'chrome-win64/chrome.exe' : 'chrome-linux64/chrome');
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

/** 路由 → 截图文件名（与 基金助手-UI提示词/ 中的截图名对应）
 *  账本/自选等页面属于账号数据：截图前会通过**真实接口**注册演示账号并写入持仓/自选，不使用静态数据。 */
const PAGES = [
  { name: '主页-1', hash: '#/', before: async () => {} },
  { name: '主页-2', hash: '#/', before: async (page) => page.click('button[aria-label="账本操作"]') },
  { name: '自选', hash: '#/watchlist', before: async () => {} },
  { name: '搜索-1', hash: '#/search', before: async () => {} },
  { name: '搜索-2', hash: '#/search', before: async (page) => page.type('input[aria-label="搜索基金"]', '沪深') },
  { name: '详情', hash: '#/fund/006274', before: async () => {} },
  { name: '数据源', hash: '#/fund/006274', before: async (page) => page.click('button[aria-label="切换数据源"]') },
  { name: '账本-添加持仓', hash: '#/add', before: async () => {} },
  { name: '账本-修改持仓-1', hash: '#/edit', before: async () => {} },
  { name: '账本-修改持仓-2', hash: '#/edit', before: async (page) => page.click('ul > li:first-child > div > button') },
  { name: '账本-账本设置', hash: '#/settings', before: async () => {} },
  { name: '我的', hash: '#/mine', before: async () => {} },
];

/** 通过真实接口准备一个演示账号（注册 → 写入持仓与自选） */
const SEED_POSITIONS = [
  { code: '161725', name: '招商中证白酒指数(LOF)A', amount: 66209.0, profit: -1599.3 },
  { code: '006274', name: '圆信永丰医药健康A', amount: 36226.29, profit: -1497.52 },
  { code: '163406', name: '兴全合润混合A', amount: 48528.41, profit: 5752.3 },
  { code: '003095', name: '中欧医疗健康混合A', amount: 96357.9, profit: -11718.65 },
  { code: '005827', name: '易方达蓝筹精选混合', amount: 90108.58, profit: -42565.31 },
  { code: '022485', name: '国金中证A500指数增强A', amount: 68293.37, profit: -151.88 },
  { code: '270023', name: '广发全球精选股票(QDII)人民币A', amount: 17201.78, profit: 1198.05 },
  { code: '166005', name: '中欧价值发现混合A', amount: 68523.46, profit: 8431.2 },
];

async function prepareAccount(page) {
  const result = await page.evaluate(async (positions) => {
    try {
      const health = await fetch('/api/health');
      if (!health.ok) return 'backend-offline';
    } catch {
      return 'backend-offline';
    }
    const username = `shot_${Math.random().toString(36).slice(2, 8)}`;
    const reg = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'shot123456' }),
    });
    if (!reg.ok) return 'register-failed';
    for (const p of positions) {
      await fetch('/api/positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
      });
    }
    await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '161725', name: '招商中证白酒指数(LOF)A' }),
    });
    await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '006274', name: '圆信永丰医药健康A' }),
    });
    return `ok:${username}`;
  }, SEED_POSITIONS);
  return result;
}

const only = process.argv.slice(2);
const targets = only.length ? PAGES.filter((p) => only.includes(p.name)) : PAGES;

const puppeteer = loadPuppeteer();
const executablePath = findChrome();
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  executablePath,
  args: ['--no-sandbox', '--force-device-scale-factor=1', '--font-render-hinting=none'],
});

const page = await browser.newPage();
await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const errors = [];
page.on('pageerror', (e) => errors.push(`${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

// 通过真实接口准备演示账号（后端不可用时页面会呈现空态，属预期）
await page.goto(`${BASE}/#/watchlist`, { waitUntil: 'load' });
const seed = await prepareAccount(page);
console.log(
  seed === 'backend-offline'
    ? '⚠️ 后端未启动：账号相关页面将截取空态（请先 pnpm start 再截图以获得完整数据）\n'
    : seed.startsWith('ok:')
      ? `✓ 已通过真实接口播种演示账号：${seed.slice(3)}\n`
      : `⚠️ 播种账号失败（${seed}），账号相关页面可能为空态\n`,
);

for (const p of targets) {
  // 先回空白页，确保每次都是全新挂载（避免上一页的组件状态串到本页）
  await page.goto('about:blank');
  await page.goto(`${BASE}/${p.hash}`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 450));
  try {
    await p.before(page);
  } catch (e) {
    console.log(`  ! ${p.name} 交互失败: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 450));
  const file = path.join(OUT, `${p.name}.png`);
  await page.screenshot({ path: file });
  console.log(`  ✓ ${p.name} → shots/${p.name}.png`);
}

console.log(errors.length ? `\n⚠️ 页面报错 ${errors.length} 条：\n - ${errors.slice(0, 8).join('\n - ')}` : '\n✅ 无页面报错');

await browser.close();
