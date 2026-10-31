/**
 * 账本聚合 / 每日快照 / 持仓穿透 / 相关性分析（Cloudflare Workers 版）
 *   口径与 Node 端 server/portfolio.cjs、server/correlation.cjs 完全一致：
 *     当日收益 = 持有金额 × 当日涨幅
 *     持仓收益率 = 持有收益 / 本金（本金 = 持有金额 − 持有收益）
 *     穿透金额 = Σ(持有金额 × 该股占净值比)；相关性 = 共同交易日上日收益率的皮尔逊系数
 */
import { all, one, batch, nowIso, round2, todayLocal } from './db.js';
import { getQuotes, tradeDateOf, getHoldings, navHistoryOf } from './upstream.js';

/** 持仓收益率 %（本金 ≤ 0 时为 null） */
export const holdRate = (amount, profit) => {
  const cost = (Number(amount) || 0) - (Number(profit) || 0);
  if (!Number.isFinite(cost) || cost <= 0) return null;
  return round2(((Number(profit) || 0) / cost) * 100);
};

async function listPositions(db, userId) {
  return all(
    db,
    'SELECT code, name, amount, profit FROM positions WHERE user_id = ? ORDER BY sort_order ASC, id ASC',
    userId,
  );
}

async function countWatch(db, userId) {
  const row = await one(db, 'SELECT COUNT(*) AS n FROM watchlist WHERE user_id = ?', userId);
  return Number((row && row.n) || 0);
}

/** 构建（并落库）账户账本 */
export async function buildPortfolio(db, userId, opts = {}) {
  const positions = await listPositions(db, userId);
  const quotes = await getQuotes(db, positions.map((p) => p.code), { force: opts.force, maxAgeMs: opts.maxAgeMs });
  const date = tradeDateOf(quotes);

  let totalAmount = 0;
  let totalProfit = 0;
  let dayProfit = 0;

  const items = positions.map((p) => {
    const q = quotes.get(p.code) || {};
    const dayChange = typeof q.day_change === 'number' ? q.day_change : null;
    const estChange = typeof q.est_change === 'number' ? q.est_change : null;
    const itemDayProfit = dayChange === null ? 0 : round2((p.amount * dayChange) / 100);

    totalAmount += Number(p.amount) || 0;
    totalProfit += Number(p.profit) || 0;
    dayProfit += itemDayProfit;

    return {
      code: p.code,
      name: q.name || p.name,
      amount: round2(p.amount),
      profit: round2(p.profit),
      rate: holdRate(p.amount, p.profit),
      nav: q.nav ?? null,
      navDate: q.nav_date ?? null,
      dayChange,
      estChange,
      estAvailable: Boolean(q.estimate_available),
      dayProfit: itemDayProfit,
      updatedAt: q.updated_at ?? null,
    };
  });

  const now = nowIso();
  const stmts = [];

  /* ---- 当日持仓明细（逐条 upsert） ---- */
  const upsertPos = `INSERT INTO position_daily (user_id, date, code, name, amount, profit, nav, day_change, est_change, day_profit, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, date, code) DO UPDATE SET
       name = excluded.name, amount = excluded.amount, profit = excluded.profit,
       nav = excluded.nav, day_change = excluded.day_change, est_change = excluded.est_change,
       day_profit = excluded.day_profit, updated_at = excluded.updated_at`;
  for (const it of items) {
    stmts.push({
      sql: upsertPos,
      args: [userId, date, it.code, it.name, it.amount, it.profit, it.nav, it.dayChange, it.estChange, it.dayProfit, now],
    });
  }
  if (items.length) {
    const keep = items.map(() => '?').join(',');
    stmts.push({
      sql: `DELETE FROM position_daily WHERE user_id = ? AND date = ? AND code NOT IN (${keep})`,
      args: [userId, date, ...items.map((i) => i.code)],
    });
  } else {
    stmts.push({ sql: 'DELETE FROM position_daily WHERE user_id = ? AND date = ?', args: [userId, date] });
  }

  /* ---- 账户当日快照 ---- */
  const watchCount = await countWatch(db, userId);
  stmts.push({
    sql: `INSERT INTO account_daily (user_id, date, total_amount, total_profit, day_profit, position_cnt, watch_cnt, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, date) DO UPDATE SET
            total_amount = excluded.total_amount, total_profit = excluded.total_profit,
            day_profit = excluded.day_profit, position_cnt = excluded.position_cnt,
            watch_cnt = excluded.watch_cnt, updated_at = excluded.updated_at`,
    args: [userId, date, round2(totalAmount), round2(totalProfit), round2(dayProfit), items.length, watchCount, now],
  });
  await batch(db, stmts);

  return {
    date,
    totalAmount: round2(totalAmount),
    totalProfit: round2(totalProfit),
    dayProfit: round2(dayProfit),
    positionCount: items.length,
    watchCount,
    updatedAt: now,
    items,
  };
}

/** 账户资产/收益历史（近 N 天，按日期升序返回） */
export async function getHistory(db, userId, days = 30) {
  const n = Math.min(Math.max(Number(days) || 30, 1), 365);
  const rows = await all(
    db,
    'SELECT date, total_amount, total_profit, day_profit, position_cnt, watch_cnt FROM account_daily WHERE user_id = ? ORDER BY date DESC LIMIT ?',
    userId,
    n,
  );
  return rows
    .map((r) => ({
      date: r.date,
      totalAmount: r.total_amount,
      totalProfit: r.total_profit,
      dayProfit: r.day_profit,
      positionCount: r.position_cnt,
      watchCount: r.watch_cnt,
    }))
    .reverse();
}

const mapDaily = (r) => ({
  date: r.date,
  code: r.code,
  name: r.name,
  amount: r.amount,
  profit: r.profit,
  nav: r.nav,
  dayChange: r.day_change,
  estChange: r.est_change,
  dayProfit: r.day_profit,
});

const DAILY_COLS = 'date, code, name, amount, profit, nav, day_change, est_change, day_profit';

/** 某日（或最近 N 天）的持仓明细快照 */
export async function getPositionDaily(db, userId, { date, days = 1 } = {}) {
  if (date) {
    const rows = await all(
      db,
      `SELECT ${DAILY_COLS} FROM position_daily WHERE user_id = ? AND date = ? ORDER BY day_profit DESC`,
      userId,
      String(date),
    );
    return rows.map(mapDaily);
  }
  const n = Math.min(Math.max(Number(days) || 1, 1), 90);
  const dates = (
    await all(db, 'SELECT DISTINCT date FROM position_daily WHERE user_id = ? ORDER BY date DESC LIMIT ?', userId, n)
  ).map((r) => r.date);
  if (!dates.length) return [];
  const placeholders = dates.map(() => '?').join(',');
  const rows = await all(
    db,
    `SELECT ${DAILY_COLS} FROM position_daily WHERE user_id = ? AND date IN (${placeholders}) ORDER BY date DESC, day_profit DESC`,
    userId,
    ...dates,
  );
  return rows.map(mapDaily);
}

/** 当前账户快照（不触发上游） */
export async function getSnapshot(db, userId, date) {
  const row = date
    ? await one(db, 'SELECT * FROM account_daily WHERE user_id = ? AND date = ?', userId, String(date))
    : await one(db, 'SELECT * FROM account_daily WHERE user_id = ? ORDER BY date DESC LIMIT 1', userId);
  if (!row) return null;
  return {
    date: row.date,
    totalAmount: row.total_amount,
    totalProfit: row.total_profit,
    dayProfit: row.day_profit,
    positionCount: row.position_cnt,
    watchCount: row.watch_cnt,
    updatedAt: row.updated_at,
  };
}

/* ==================== 持仓穿透 ==================== */
export async function buildLookthrough(db, userId, opts = {}) {
  const positions = await listPositions(db, userId);
  const totalAmount = positions.reduce((s, p) => s + (Number(p.amount) || 0), 0);

  const fetched = await Promise.all(
    positions.map(async (p) => ({ p, h: await getHoldings(p.code, { force: Boolean(opts.force) }) })),
  );

  const stocks = new Map();
  const noData = [];
  let coveredAmount = 0;
  let date = null;
  let quarter = null;
  let stale = false;

  for (const { p, h } of fetched) {
    const items = (h && h.items) || [];
    if (h && h.stale) stale = true;
    if (!date && h && h.date) date = h.date;
    if (!quarter && h && h.quarter) quarter = h.quarter;
    if (!items.length) {
      noData.push({ code: p.code, name: p.name, amount: round2(p.amount) });
      continue;
    }
    for (const it of items) {
      const weight = Number(it.weight) || 0;
      const exposure = round2(((Number(p.amount) || 0) * weight) / 100);
      coveredAmount += exposure;
      const cur = stocks.get(it.code) || { code: it.code, name: it.name, amount: 0, funds: [] };
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

  const items = [...stocks.values()]
    .map((s) => ({
      code: s.code,
      name: s.name,
      amount: s.amount,
      ratio: totalAmount > 0 ? round2((s.amount / totalAmount) * 100) : 0,
      fundCount: s.funds.length,
      funds: s.funds.sort((a, b) => b.amount - a.amount),
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
    stale,
    noData,
    items,
    updatedAt: nowIso(),
  };
}

/* ==================== 相关性分析 ==================== */
/** 皮尔逊相关系数（等长序列） */
export function pearson(a, b) {
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

const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

export async function buildCorrelation(db, userId, opts = {}) {
  const win = Math.min(240, Math.max(20, parseInt(opts.window ?? 60, 10) || 60));
  const positions = await listPositions(db, userId);
  const need = win + 1;

  const raw = await Promise.all(
    positions.map(async (p) => {
      const rows = await navHistoryOf(p.code, need, { force: Boolean(opts.force) });
      const byDate = new Map();
      for (const r of rows) {
        const nav = parseFloat(r.dwjz);
        if (r.date && Number.isFinite(nav) && nav > 0) byDate.set(r.date, nav);
      }
      return { code: p.code, name: p.name, amount: Number(p.amount) || 0, byDate };
    }),
  );

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
      funds: fundsWithData.map((f) => ({ code: f.code, name: f.name, amount: round2(f.amount) })),
      matrix: [],
      pairs: [],
      mostSimilar: null,
      mostDiverse: null,
      avgCorr: null,
      insufficient,
      updatedAt: nowIso(),
      reason: fundsWithData.length < 2 ? '账本至少需要 2 只基金才能做相关性分析' : '共同交易日不足（新基金或净值数据缺失）',
    };
  }

  const series = fundsWithData.map((f) => {
    const rets = [];
    for (let i = 1; i < commonDates.length; i += 1) {
      const prev = f.byDate.get(commonDates[i - 1]);
      const cur = f.byDate.get(commonDates[i]);
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

  const bases = series.map((f) => f.byDate.get(commonDates[0]));
  const seriesOut = series.map((f, i) => ({
    code: f.code,
    name: f.name,
    points: commonDates.map((d) => Math.round((f.byDate.get(d) / bases[i]) * 100000) / 1000),
    totalChange: round2((f.byDate.get(commonDates[commonDates.length - 1]) / bases[i]) * 100 - 100),
  }));

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
        level: c >= 0.8 ? '高度相关' : c >= 0.5 ? '中度相关' : c >= 0 ? '低相关' : '负相关',
      });
    }
  }
  pairs.sort((a, b) => b.corr - a.corr);
  const avgCorr = pairs.length ? round4(pairs.reduce((s, p) => s + p.corr, 0) / pairs.length) : null;

  return {
    window: win,
    requestedWindow: parseInt(opts.window ?? 60, 10) || 60,
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
    mostSimilar: pairs[0] || null,
    mostDiverse: pairs[pairs.length - 1] || null,
    avgCorr,
    insufficient,
    updatedAt: nowIso(),
  };
}

export { todayLocal };
