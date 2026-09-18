/**
 * 基金相关性分析测试
 *   node scripts/test-correlation.mjs
 *
 * 关键：测试**独立复算**一遍相关性（自己按公式算皮尔逊系数），
 *       与接口返回的矩阵逐值比对，确保不是「接口自己说自己对」。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(path.join(tmpdir(), 'fundwatch-corr-'));
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

let server;
const start = () =>
  spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/dev-server.mjs', '--no-qr'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB },
    stdio: 'ignore',
  });

async function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* 未就绪 */
    }
    await wait(250);
  }
  return false;
}

const cookies = [];
async function req(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookies.length ? { cookie: cookies.join('; ') } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const c of r.headers.getSetCookie?.() || []) cookies.push(c.split(';')[0]);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** 独立实现：皮尔逊相关系数 */
function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return cov / Math.sqrt(va * vb);
}

const FUNDS = [
  { code: '161725', name: '招商中证白酒指数(LOF)A', amount: 60000 },
  { code: '163406', name: '兴全合润混合A', amount: 30000 },
  { code: '006274', name: '圆信永丰医药健康A', amount: 10000 },
  { code: '005827', name: '易方达蓝筹精选混合', amount: 20000 },
];

try {
  server = start();
  if (!(await waitFor(`${BASE}/api/health`))) throw new Error('后端未就绪');

  /* ---------- 权限 ---------- */
  console.log('\n【1】权限与前置');
  const anon = await fetch(`${BASE}/api/portfolio/correlation`);
  check('未登录访问相关性分析被拒 (401)', anon.status === 401, String(anon.status));

  const username = `corr_${Math.random().toString(36).slice(2, 7)}`;
  const reg = await req('POST', '/api/auth/register', { username, password: 'corr123456' });
  check('注册测试账号', reg.status === 200, JSON.stringify(reg.body).slice(0, 80));

  const empty = await req('GET', '/api/portfolio/correlation');
  check('无持仓时返回空矩阵并给出原因', empty.body.correlation.matrix.length === 0 && Boolean(empty.body.correlation.reason), JSON.stringify(empty.body.correlation.reason));

  const one = await req('POST', '/api/positions', { ...FUNDS[0], profit: 0 });
  check('写入 1 只持仓', one.status === 200);
  const single = await req('GET', '/api/portfolio/correlation');
  check('仅 1 只基金时提示至少需要 2 只', single.body.correlation.pairs.length === 0 && single.body.correlation.reason.includes('至少'), JSON.stringify(single.body.correlation.reason));

  for (const f of FUNDS.slice(1)) await req('POST', '/api/positions', { ...f, profit: 0 });

  /* ---------- 结构 ---------- */
  console.log('\n【2】相关性矩阵结构');
  const res = await req('GET', '/api/portfolio/correlation?days=60');
  const c = res.body.correlation;
  check('接口返回 200', res.status === 200 && Boolean(c), JSON.stringify(res.body).slice(0, 100));
  check('分析窗口 = 60（交易日）', c.window === 60, String(c.window));
  check('参与基金数 = 4', c.fundCount === 4, String(c.fundCount));
  check('矩阵为 N×N', c.matrix.length === 4 && c.matrix.every((row) => row.length === 4), JSON.stringify(c.matrix.map((r) => r.length)));
  check('对角线 = 1', c.matrix.every((row, i) => row[i] === 1));
  check('矩阵对称', c.matrix.every((row, i) => row.every((v, j) => v === c.matrix[j][i])));
  check(
    '相关系数均在 [-1, 1]',
    c.matrix.every((row) => row.every((v) => v === null || (v >= -1.0001 && v <= 1.0001))),
    JSON.stringify(c.matrix),
  );
  check('两两组合数 = 6', c.pairs.length === 6, String(c.pairs.length));
  check('共同交易日区间有效', Boolean(c.startDate) && Boolean(c.endDate) && c.pointCount > 30, `${c.startDate} ~ ${c.endDate} (${c.pointCount} 点)`);
  check('收益率样本数 = 净值点数 - 1', c.returnCount === c.pointCount - 1, `${c.returnCount} vs ${c.pointCount - 1}`);
  check('给出最相似/最分散组合', Boolean(c.mostSimilar) && Boolean(c.mostDiverse), `${c.mostSimilar?.aName}↔${c.mostSimilar?.bName} ${c.mostSimilar?.corr}`);
  check('组合按相关性降序', c.pairs.every((p, i) => i === 0 || c.pairs[i - 1].corr >= p.corr));
  check('最相似 = 组合首位', c.mostSimilar.corr === c.pairs[0].corr && c.mostSimilar.aCode === c.pairs[0].aCode);
  check('最分散 = 组合末位', c.mostDiverse.corr === c.pairs[c.pairs.length - 1].corr);
  const avg = c.pairs.reduce((s, p) => s + p.corr, 0) / c.pairs.length;
  check('平均相关性与组合一致', Math.abs(c.avgCorr - avg) < 0.0001, `${c.avgCorr} vs ${avg}`);

  /* ---------- 独立复算 ---------- */
  console.log('\n【3】独立复算比对（测试自己按公式算一遍）');
  const series = [];
  for (const f of FUNDS) {
    const byDate = new Map();
    for (let page = 1; page <= 4; page += 1) {
      const r = await req('GET', `/api/nav?code=${f.code}&page=${page}&size=20`);
      for (const it of r.body.items || []) {
        const nav = parseFloat(it.dwjz);
        if (it.date && Number.isFinite(nav) && nav > 0) byDate.set(it.date, nav);
      }
    }
    series.push({ code: f.code, byDate });
  }
  // 共同交易日（与接口同口径：交集后取最近 window+1 个）
  const common = [...series[0].byDate.keys()]
    .filter((d) => series.every((s) => s.byDate.has(d)))
    .sort()
    .slice(-(c.window + 1));
  check('复算得到的共同交易日数与接口一致', common.length === c.pointCount, `${common.length} vs ${c.pointCount}`);
  check('起止日期一致', common[0] === c.startDate && common[common.length - 1] === c.endDate, `${common[0]}~${common[common.length - 1]} vs ${c.startDate}~${c.endDate}`);

  const rets = series.map((s) => {
    const out = [];
    for (let i = 1; i < common.length; i += 1) out.push(s.byDate.get(common[i]) / s.byDate.get(common[i - 1]) - 1);
    return out;
  });
  let maxDiff = 0;
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      const expect = i === j ? 1 : Math.round(pearson(rets[i], rets[j]) * 10000) / 10000;
      const got = c.matrix[i][j];
      maxDiff = Math.max(maxDiff, Math.abs(expect - got));
    }
  }
  check('矩阵每个值都与独立复算一致（误差 < 1e-4）', maxDiff < 1e-4, `最大偏差 ${maxDiff}`);
  check('相关系数不是全 0/全 1（确实算出了差异）', c.pairs.some((p) => Math.abs(p.corr) > 0.01));

  /* ---------- 窗口与参数 ---------- */
  console.log('\n【4】窗口参数与边界');
  const w20 = await req('GET', '/api/portfolio/correlation?days=20');
  const w120 = await req('GET', '/api/portfolio/correlation?days=120');
  check('days=20 生效', w20.body.correlation.window === 20 && w20.body.correlation.returnCount === 20, `${w20.body.correlation.returnCount}`);
  check('days=120 生效（自动翻页取更长历史）', w120.body.correlation.window === 120 && w120.body.correlation.returnCount >= 100, `${w120.body.correlation.returnCount}`);
  check('窗口越大样本越多', w120.body.correlation.pointCount > w20.body.correlation.pointCount);
  const small = await req('GET', '/api/portfolio/correlation?days=1');
  check('过小窗口被夹到下限 20', small.body.correlation.window === 20, String(small.body.correlation.window));

  /* ---------- 数据不足的基金 ---------- */
  console.log('\n【5】净值数据不足的基金');
  await req('POST', '/api/positions', { code: '000000', name: '不存在的基金', amount: 5000, profit: 0 });
  const withBad = await req('GET', '/api/portfolio/correlation?days=60');
  const cb = withBad.body.correlation;
  check('无净值数据的基金被单列，不参与矩阵', cb.insufficient.some((f) => f.code === '000000'), JSON.stringify(cb.insufficient));
  check('矩阵仍为 4×4（剔除无效基金后）', cb.matrix.length === 4, String(cb.matrix.length));

  /* ---------- 缓存 ---------- */
  console.log('\n【6】净值缓存');
  const t0 = Date.now();
  const cached = await req('GET', '/api/portfolio/correlation?days=60');
  const ms = Date.now() - t0;
  check('二次请求命中净值缓存（< 400ms）', ms < 400, `${ms}ms`);
  check('缓存结果一致', cached.body.correlation.pointCount === c.pointCount && cached.body.correlation.avgCorr === c.avgCorr);

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
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}
process.exit(fail === 0 ? 0 : 1);
