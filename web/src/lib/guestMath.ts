/**
 * 游客模式的派生计算（持仓穿透 / 相关性分析）
 *
 * 口径与后端 **完全一致**（backend/server/portfolio.cjs、correlation.cjs）：
 *   穿透金额 = Σ(基金持有金额 × 该股票占净值比 / 100)
 *   相关性   = 共同交易日上「日收益率」的皮尔逊系数
 * 数据全部取自公开接口（/api/holdings、/api/nav），不上传本地持仓。
 */
import { api, type Correlation, type LookThrough, type LookThroughStock, type PositionItem } from './api';

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const round4 = (n: number) => Math.round((Number(n) || 0) * 10000) / 10000;

/** 持仓收益率 %（本金 ≤ 0 → null），与后端 holdRate 一致 */
export const holdRate = (amount: number, profit: number): number | null => {
  const cost = (Number(amount) || 0) - (Number(profit) || 0);
  if (!Number.isFinite(cost) || cost <= 0) return null;
  return round2(((Number(profit) || 0) / cost) * 100);
};

/** 皮尔逊相关系数（等长序列，n < 3 视为不足） */
export function pearson(a: number[], b: number[]): number | null {
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
  if (va <= 0 || vb <= 0) return null;
  return cov / Math.sqrt(va * vb);
}

/* ============================ 持仓穿透 ============================ */
export async function localLookthrough(positions: PositionItem[]): Promise<LookThrough> {
  const totalAmount = positions.reduce((s, p) => s + (Number(p.amount) || 0), 0);

  const fetched = await Promise.all(
    positions.map(async (p) => {
      const h = await api.holdings(p.code).catch(() => null);
      return { p, items: h?.items ?? [], date: h?.date ?? null, quarter: h?.quarter ?? null };
    }),
  );

  const stocks = new Map<string, { code: string; name: string; amount: number; funds: LookThroughStock['funds'] }>();
  const noData: LookThrough['noData'] = [];
  let coveredAmount = 0;
  let date: string | null = null;
  let quarter: string | null = null;

  for (const { p, items, date: d, quarter: q } of fetched) {
    if (!date && d) date = d;
    if (!quarter && q) quarter = q;
    if (!items.length) {
      noData.push({ code: p.code, name: p.name, amount: round2(p.amount) });
      continue;
    }
    for (const it of items) {
      const weight = Number(it.weight) || 0;
      const exposure = round2(((Number(p.amount) || 0) * weight) / 100);
      coveredAmount += exposure;
      const cur = stocks.get(it.code) ?? { code: it.code, name: it.name, amount: 0, funds: [] };
      cur.amount = round2(cur.amount + exposure);
      cur.funds.push({
        code: p.code,
        name: p.name,
        weight: round2(weight),
        amount: exposure,
        change: typeof it.change === 'number' ? it.change : null,
      });
      stocks.set(it.code, cur);
    }
  }

  const items: LookThroughStock[] = [...stocks.values()]
    .map((s) => ({
      code: s.code,
      name: s.name,
      amount: s.amount,
      ratio: totalAmount > 0 ? round2((s.amount / totalAmount) * 100) : 0,
      fundCount: s.funds.length,
      funds: [...s.funds].sort((a, b) => b.amount - a.amount),
    }))
    .sort((a, b) => b.amount - a.amount)
    .map((s, i) => ({ ...s, rank: i + 1 }));

  return {
    totalAmount: round2(totalAmount),
    coveredAmount: round2(coveredAmount),
    coverage: totalAmount > 0 ? round2((coveredAmount / totalAmount) * 100) : 0,
    positionCount: positions.length,
    stockCount: items.length,
    date,
    quarter,
    stale: false,
    noData,
    items,
    updatedAt: new Date().toISOString(),
  };
}

/* ============================ 相关性分析 ============================ */

/** 取近 need 条历史净值（上游每页 20 条，按页拉取） */
async function navHistory(code: string, need: number): Promise<Array<{ date: string; nav: number }>> {
  const out: Array<{ date: string; nav: number }> = [];
  const pages = Math.max(1, Math.ceil(need / 20));
  for (let page = 1; page <= pages; page += 1) {
    const r = await api.nav(code, 20, page).catch(() => null);
    const rows = r?.items ?? [];
    for (const row of rows) {
      const nav = Number(row.dwjz);
      if (row.date && Number.isFinite(nav) && nav > 0) out.push({ date: row.date, nav });
    }
    if (rows.length < 20) break;
  }
  return out;
}

const levelOf = (v: number) => (v >= 0.8 ? '高度相关' : v >= 0.5 ? '中度相关' : v >= 0 ? '低相关' : '负相关');

export async function localCorrelation(positions: PositionItem[], windowDays = 60): Promise<Correlation> {
  const win = Math.min(240, Math.max(20, Number(windowDays) || 60));
  const need = win + 1;

  const raw = await Promise.all(
    positions.map(async (p) => {
      const rows = await navHistory(p.code, need);
      const byDate = new Map<string, number>();
      for (const r of rows) byDate.set(r.date, r.nav);
      return { code: p.code, name: p.name, amount: Number(p.amount) || 0, byDate };
    }),
  );

  const withData = raw.filter((f) => f.byDate.size > 1);
  const insufficient = raw
    .filter((f) => f.byDate.size <= 1)
    .map((f) => ({ code: f.code, name: f.name, points: f.byDate.size }));

  let commonDates: string[] = [];
  if (withData.length >= 2) {
    const [first, ...rest] = withData;
    commonDates = [...first.byDate.keys()].filter((d) => rest.every((f) => f.byDate.has(d))).sort();
    if (commonDates.length > need) commonDates = commonDates.slice(-need);
  }

  if (commonDates.length < 4 || withData.length < 2) {
    return {
      window: win,
      requestedWindow: Number(windowDays) || 60,
      pointCount: commonDates.length,
      startDate: commonDates[0] ?? null,
      endDate: commonDates[commonDates.length - 1] ?? null,
      fundCount: withData.length,
      funds: withData.map((f) => ({ code: f.code, name: f.name, amount: round2(f.amount) })),
      matrix: [],
      pairs: [],
      mostSimilar: null,
      mostDiverse: null,
      avgCorr: null,
      insufficient,
      updatedAt: new Date().toISOString(),
      reason:
        withData.length < 2 ? '账本至少需要 2 只基金才能做相关性分析' : '共同交易日不足（新基金或净值数据缺失）',
    };
  }

  const series = withData.map((f) => {
    const rets: number[] = [];
    for (let i = 1; i < commonDates.length; i += 1) {
      const prev = f.byDate.get(commonDates[i - 1]) as number;
      const cur = f.byDate.get(commonDates[i]) as number;
      rets.push(cur / prev - 1);
    }
    return { ...f, rets };
  });

  const n = series.length;
  const matrix = series.map((a, i) =>
    series.map((b, j) => {
      if (i === j) return 1;
      const c = pearson(a.rets, b.rets);
      return c === null ? null : round4(c);
    }),
  );

  const bases = series.map((f) => f.byDate.get(commonDates[0]) as number);
  const seriesOut = series.map((f, i) => ({
    code: f.code,
    name: f.name,
    points: commonDates.map((d) => Math.round(((f.byDate.get(d) as number) / bases[i]) * 100000) / 1000),
    totalChange: round2(((f.byDate.get(commonDates[commonDates.length - 1]) as number) / bases[i]) * 100 - 100),
  }));

  const pairs: Correlation['pairs'] = [];
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
        level: levelOf(c),
      });
    }
  }
  pairs.sort((a, b) => b.corr - a.corr);

  return {
    window: win,
    requestedWindow: Number(windowDays) || 60,
    pointCount: commonDates.length,
    startDate: commonDates[0],
    endDate: commonDates[commonDates.length - 1],
    fundCount: n,
    returnCount: series[0].rets.length,
    funds: series.map((f) => ({ code: f.code, name: f.name, amount: round2(f.amount) })),
    dates: commonDates,
    series: seriesOut,
    matrix,
    pairs,
    mostSimilar: pairs[0] ?? null,
    mostDiverse: pairs[pairs.length - 1] ?? null,
    avgCorr: pairs.length ? round4(pairs.reduce((s, p) => s + p.corr, 0) / pairs.length) : null,
    insufficient,
    updatedAt: new Date().toISOString(),
  };
}
