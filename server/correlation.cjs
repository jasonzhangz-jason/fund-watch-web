'use strict';
/**
 * 基金相关性分析
 *   对账本内每两只基金，用**对齐到共同交易日**的**日收益率**序列计算皮尔逊相关系数：
 *     r_i,t = nav_i,t / nav_i,t-1 - 1
 *     corr(i,j) = cov(r_i, r_j) / (σ_i · σ_j)
 *
 * 为什么用日收益率而不是净值本身：两只长期上涨的基金净值天然同向，
 * 直接对净值求相关会得到虚高的「伪相关」；收益率相关性才反映真实的同涨同跌程度。
 */
const market = require('./market.cjs');
const { getDb } = require('./db.cjs');

const round = (n, d = 4) => Math.round((Number(n) || 0) * 10 ** d) / 10 ** d;

/** 皮尔逊相关系数（等长序列，无缺失） */
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i += 1) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va <= 0 || vb <= 0) return null; // 一方完全无波动（如货基）→ 无法定义相关
  return cov / Math.sqrt(va * vb);
}

function listPositions(userId) {
  return getDb()
    .prepare('SELECT code, name, amount FROM positions WHERE user_id = ? ORDER BY sort_order ASC, id ASC')
    .all(userId);
}

/**
 * 构建相关性分析结果
 * @param {number} userId
 * @param {{window?: number, force?: boolean}} opts window = 参与计算的交易日数（默认 60）
 */
async function buildCorrelation(userId, opts = {}) {
  const win = Math.min(240, Math.max(20, parseInt(opts.window ?? 60, 10) || 60));
  const positions = listPositions(userId);
  const need = win + 1; // window 个收益率需要 window+1 个净值点

  // 1) 拉取每只基金的净值序列（按日期倒序），转为 date → nav
  const raw = await Promise.all(
    positions.map(async (p) => {
      const rows = await market.navHistoryOf(p.code, need, { force: Boolean(opts.force) });
      const byDate = new Map();
      for (const r of rows) {
        const nav = parseFloat(r.dwjz);
        if (r.date && Number.isFinite(nav) && nav > 0) byDate.set(r.date, nav);
      }
      return { code: p.code, name: p.name, amount: Number(p.amount) || 0, byDate };
    }),
  );

  // 2) 共同交易日：所有基金都有净值的日期交集（升序取最近 win+1 个）
  const fundsWithData = raw.filter((f) => f.byDate.size > 1);
  const insufficient = raw
    .filter((f) => f.byDate.size <= 1)
    .map((f) => ({ code: f.code, name: f.name, points: f.byDate.size }));

  let commonDates = [];
  if (fundsWithData.length >= 2) {
    const [first, ...rest] = fundsWithData;
    commonDates = [...first.byDate.keys()].filter((d) => rest.every((f) => f.byDate.has(d))).sort();
    if (commonDates.length > need) commonDates = commonDates.slice(-need);
  }

  if (commonDates.length < 4 || fundsWithData.length < 2) {
    return {
      window: win,
      requestedWindow: parseInt(opts.window ?? 60, 10) || 60,
      pointCount: commonDates.length,
      startDate: commonDates[0] || null,
      endDate: commonDates[commonDates.length - 1] || null,
      fundCount: fundsWithData.length,
      funds: fundsWithData.map((f) => ({ code: f.code, name: f.name, amount: round(f.amount, 2) })),
      matrix: [],
      pairs: [],
      mostSimilar: null,
      mostDiverse: null,
      avgCorr: null,
      insufficient,
      updatedAt: new Date().toISOString(),
      reason: fundsWithData.length < 2 ? '账本至少需要 2 只基金才能做相关性分析' : '共同交易日不足（新基金或净值数据缺失）',
    };
  }

  // 3) 日收益率序列（对齐到共同交易日）
  const series = fundsWithData.map((f) => {
    const rets = [];
    for (let i = 1; i < commonDates.length; i += 1) {
      const prev = f.byDate.get(commonDates[i - 1]);
      const cur = f.byDate.get(commonDates[i]);
      rets.push(cur / prev - 1);
    }
    return { ...f, rets };
  });

  // 4) 相关系数矩阵
  const n = series.length;
  const matrix = series.map((a, i) =>
    series.map((b, j) => {
      if (i === j) return 1;
      const c = pearson(a.rets, b.rets);
      return c === null ? null : round(c, 4);
    }),
  );

  const pairs = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const c = matrix[i][j];
      if (c === null) continue;
      pairs.push({
        aCode: series[i].code,
        aName: series[i].name,
        bCode: series[j].code,
        bName: series[j].name,
        corr: c,
        /** 直观标签：≥0.8 高度相关 / 0.5-0.8 中度 / 0-0.5 低相关 / <0 负相关 */
        level: c >= 0.8 ? '高度相关' : c >= 0.5 ? '中度相关' : c >= 0 ? '低相关' : '负相关',
      });
    }
  }
  pairs.sort((a, b) => b.corr - a.corr);
  const avgCorr = pairs.length ? round(pairs.reduce((s, p) => s + p.corr, 0) / pairs.length, 4) : null;

  return {
    window: win,
    requestedWindow: parseInt(opts.window ?? 60, 10) || 60,
    pointCount: commonDates.length,
    startDate: commonDates[0],
    endDate: commonDates[commonDates.length - 1],
    fundCount: n,
    returnCount: series[0].rets.length,
    funds: series.map((f) => ({ code: f.code, name: f.name, amount: round(f.amount, 2) })),
    matrix,
    pairs,
    mostSimilar: pairs[0] || null,
    mostDiverse: pairs[pairs.length - 1] || null,
    avgCorr,
    insufficient,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { buildCorrelation, pearson };
