/**
 * 账本服务专项测试（账户资产 / 当日收益 / 每日快照 / 行情缓存）
 *   node scripts/test-portfolio.mjs
 *
 * 覆盖：
 *   1. 新增持仓后 /api/portfolio 返回账户资产 = Σ金额、当日收益 = Σ(金额×涨幅)
 *   2. 当日明细与账户快照写入 position_daily / account_daily（可查历史）
 *   3. 修改金额 / 删除持仓后，快照与汇总同步更新且不重复
 *   4. 自选数量进入账户快照
 *   5. 行情缓存：TTL 内复用（updated_at 不变），refresh=1 强制刷新
 *   6. 重启后端后历史与持仓仍在（SQLite 持久化）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fundwatch-portfolio-'));
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
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

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

let server;
function start() {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/dev-server.mjs', '--no-qr'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB },
    stdio: 'ignore',
  });
  return server;
}

let cookie = '';
const req = async (url, init = {}) => {
  const r = await fetch(BASE + url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(init.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
};
const get = (u) => req(u);
const post = (u, data) => req(u, { method: 'POST', body: JSON.stringify(data) });
const del = (u) => req(u, { method: 'DELETE' });

(async () => {
  try {
    start();
    await waitFor(`${BASE}/api/health`);

    /* ---------- 准备账号 ---------- */
    console.log('\n【1】注册并写入持仓');
    const username = `pf_${Date.now().toString().slice(-6)}`;
    const reg = await post('/api/auth/register', { username, password: 'pf123456' });
    check('注册成功', reg.status === 200, JSON.stringify(reg.body));

    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'pf123456' }),
    });
    cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    check('取得会话 Cookie', cookie.startsWith('fw_session='), cookie || '(空)');

    await post('/api/positions', { code: '161725', name: '招商中证白酒指数(LOF)A', amount: 10000, profit: 500 });
    await post('/api/positions', { code: '006274', name: '圆信永丰医药健康A', amount: 5000, profit: -200 });

    /* ---------- 账户账本 ---------- */
    console.log('\n【2】/api/portfolio 汇总与算术');
    const pf = await get('/api/portfolio');
    const P = pf.body.portfolio;
    check('返回 200 且带 portfolio', pf.status === 200 && Boolean(P), JSON.stringify(pf.body).slice(0, 120));
    check('账户资产 = Σ金额（15000）', P?.totalAmount === 15000, String(P?.totalAmount));
    check('持有收益 = Σ收益（300）', P?.totalProfit === 300, String(P?.totalProfit));
    check('持仓 2 只', P?.items?.length === 2, String(P?.items?.length));
    const sumDay = round2((P?.items || []).reduce((s, i) => s + i.dayProfit, 0));
    check('当日总收益 = Σ明细当日收益', P?.dayProfit === sumDay, `${P?.dayProfit} vs ${sumDay}`);
    const item = (P?.items || []).find((i) => i.code === '161725');
    const expectDay = item?.dayChange === null || item?.dayChange === undefined ? 0 : round2((10000 * item.dayChange) / 100);
    check('单只当日收益 = 金额×当日涨幅', item?.dayProfit === expectDay, `${item?.dayProfit} vs ${expectDay}（涨幅 ${item?.dayChange}）`);
    check('明细含净值与涨幅字段', item?.navDate !== undefined && 'dayChange' in item && 'estChange' in item);
    check('交易日口径来自净值日期', /^\d{4}-\d{2}-\d{2}$/.test(P?.date || ''), P?.date);

    /* ---------- 快照落库 ---------- */
    console.log('\n【3】每日快照落库');
    const hist = await get('/api/portfolio/history?days=5');
    const snap = (hist.body.items || []).find((h) => h.date === P.date);
    check('account_daily 写入当日快照', Boolean(snap), JSON.stringify(hist.body.items));
    check('快照账户资产与汇总一致', snap?.totalAmount === 15000, String(snap?.totalAmount));
    check('快照当日收益与汇总一致', snap?.dayProfit === P.dayProfit, `${snap?.dayProfit} vs ${P.dayProfit}`);
    check('快照持仓数 = 2', snap?.positionCount === 2, String(snap?.positionCount));

    const daily = await get(`/api/portfolio/daily?date=${P.date}`);
    check('position_daily 写入 2 条明细', (daily.body.items || []).length === 2, JSON.stringify(daily.body.items).slice(0, 160));
    check('明细快照含当日收益字段', (daily.body.items || []).every((d) => 'dayProfit' in d && 'dayChange' in d));

    /* ---------- 自选计入快照 ---------- */
    console.log('\n【4】自选数量进入账户快照');
    await post('/api/watchlist', { code: '161725', name: '招商中证白酒指数(LOF)A' });
    const pf2 = await get('/api/portfolio');
    check('watchCount = 1', pf2.body.portfolio.watchCount === 1, String(pf2.body.portfolio.watchCount));
    const hist2 = await get('/api/portfolio/history?days=5');
    const snap2 = (hist2.body.items || []).find((h) => h.date === P.date);
    check('快照更新 watchCount（upsert 不新增行）', snap2?.watchCount === 1 && hist2.body.items.length === hist.body.items.length, JSON.stringify(snap2));

    /* ---------- 修改 / 删除同步 ---------- */
    console.log('\n【5】修改金额与删除持仓：汇总与快照同步');
    await post('/api/positions', { code: '161725', name: '招商中证白酒指数(LOF)A', amount: 20000, profit: 800 });
    const pf3 = await get('/api/portfolio');
    check('修改后账户资产 = 25000', pf3.body.portfolio.totalAmount === 25000, String(pf3.body.portfolio.totalAmount));

    await del('/api/positions?codes=006274');
    const pf4 = await get('/api/portfolio');
    check('删除后账户资产 = 20000', pf4.body.portfolio.totalAmount === 20000, String(pf4.body.portfolio.totalAmount));
    check('删除后持仓 1 只', pf4.body.portfolio.items.length === 1);
    const daily2 = await get(`/api/portfolio/daily?date=${P.date}`);
    check('当日快照同步删除该持仓', (daily2.body.items || []).length === 1, JSON.stringify(daily2.body.items).slice(0, 120));

    /* ---------- 行情缓存 ---------- */
    console.log('\n【6】行情缓存与强制刷新');
    const q1 = await get('/api/quotes?codes=161725');
    check('/api/quotes 返回行情', q1.status === 200 && q1.body.items?.length === 1, JSON.stringify(q1.body).slice(0, 120));
    check('行情含净值/当日涨幅字段', q1.body.items?.[0] && 'nav' in q1.body.items[0] && 'day_change' in q1.body.items[0]);
    const q2 = await get('/api/quotes?codes=161725');
    check('TTL 内复用缓存（updated_at 不变）', q1.body.items[0].updated_at === q2.body.items[0].updated_at, `${q1.body.items[0].updated_at} → ${q2.body.items[0].updated_at}`);
    await wait(1100);
    const q3 = await get('/api/quotes?codes=161725&refresh=1');
    check('refresh=1 触发上游刷新（updated_at 变化）', q3.body.items[0].updated_at !== q1.body.items[0].updated_at);

    /* ---------- 重启持久化 ---------- */
    console.log('\n【7】重启后端后数据仍在');
    server.kill('SIGKILL');
    await wait(1200);
    start();
    await waitFor(`${BASE}/api/health`);
    const pf5 = await get('/api/portfolio');
    check('重启后持仓仍在（账户资产 20000）', pf5.body.portfolio.totalAmount === 20000, String(pf5.body.portfolio.totalAmount));
    const hist3 = await get('/api/portfolio/history?days=5');
    check('重启后历史快照仍在', (hist3.body.items || []).some((h) => h.date === P.date), JSON.stringify(hist3.body.items));

    console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  } catch (e) {
    console.error('测试异常:', e.message, e.stack?.split('\n')[1] || '');
    fail++;
  } finally {
    try {
      server?.kill('SIGKILL');
    } catch {
      /* 忽略 */
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
