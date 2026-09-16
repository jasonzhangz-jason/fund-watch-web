'use strict';
/**
 * 账本聚合服务：账户资产 / 持有收益 / 当日收益
 *   - 数据来源：positions（持仓）+ watchlist（自选）+ fund_quotes（行情缓存）
 *   - 每次构建都会把结果**落库**到 position_daily / account_daily（按交易日 upsert），
 *     因此「当日收益」「账户资产」可回溯、可重启不丢，也是收益曲线的数据源。
 */
const { getDb, checkpoint } = require('./db.cjs');
const market = require('./market.cjs');

const commit = () => {
  try {
    checkpoint();
  } catch {
    /* 忽略 */
  }
};
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const todayLocal = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function listPositions(userId) {
  return getDb()
    .prepare('SELECT code, name, amount, profit FROM positions WHERE user_id = ? ORDER BY sort_order ASC, id ASC')
    .all(userId);
}

function countWatch(userId) {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM watchlist WHERE user_id = ?').get(userId);
  return Number(row?.n || 0);
}

/**
 * 构建（并落库）账户账本
 * @param {number} userId
 * @param {{ force?: boolean, maxAgeMs?: number }} [opts] force=true 时强制刷新上游行情
 */
async function buildPortfolio(userId, opts = {}) {
  const positions = listPositions(userId);
  const quotes = await market.getQuotes(
    positions.map((p) => p.code),
    { force: opts.force, maxAgeMs: opts.maxAgeMs },
  );
  const date = market.tradeDateOf(quotes);

  let totalAmount = 0;
  let totalProfit = 0;
  let dayProfit = 0;

  const items = positions.map((p) => {
    const q = quotes.get(p.code) || {};
    const dayChange = typeof q.day_change === 'number' ? q.day_change : null;
    const estChange = typeof q.est_change === 'number' ? q.est_change : null;
    const itemDayProfit = dayChange === null ? 0 : round2((p.amount * dayChange) / 100);

    totalAmount += p.amount;
    totalProfit += p.profit;
    dayProfit += itemDayProfit;

    return {
      code: p.code,
      name: q.name || p.name,
      amount: round2(p.amount),
      profit: round2(p.profit),
      nav: q.nav ?? null,
      navDate: q.nav_date ?? null,
      dayChange,
      estChange,
      estAvailable: Boolean(q.estimate_available),
      dayProfit: itemDayProfit,
      updatedAt: q.updated_at ?? null,
    };
  });

  const db = getDb();
  const now = new Date().toISOString();

  /* ---- 当日持仓明细 ---- */
  const upsertPos = db.prepare(
    `INSERT INTO position_daily (user_id, date, code, name, amount, profit, nav, day_change, est_change, day_profit, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, date, code) DO UPDATE SET
       name = excluded.name, amount = excluded.amount, profit = excluded.profit,
       nav = excluded.nav, day_change = excluded.day_change, est_change = excluded.est_change,
       day_profit = excluded.day_profit, updated_at = excluded.updated_at`,
  );
  for (const it of items) {
    upsertPos.run(userId, date, it.code, it.name, it.amount, it.profit, it.nav, it.dayChange, it.estChange, it.dayProfit, now);
  }
  // 当天已被删除的持仓，同步清理其快照
  if (items.length) {
    const keep = items.map(() => '?').join(',');
    db.prepare(`DELETE FROM position_daily WHERE user_id = ? AND date = ? AND code NOT IN (${keep})`).run(
      userId,
      date,
      ...items.map((i) => i.code),
    );
  } else {
    db.prepare('DELETE FROM position_daily WHERE user_id = ? AND date = ?').run(userId, date);
  }

  /* ---- 账户当日快照 ---- */
  const watchCount = countWatch(userId);
  db.prepare(
    `INSERT INTO account_daily (user_id, date, total_amount, total_profit, day_profit, position_cnt, watch_cnt, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET
       total_amount = excluded.total_amount, total_profit = excluded.total_profit,
       day_profit = excluded.day_profit, position_cnt = excluded.position_cnt,
       watch_cnt = excluded.watch_cnt, updated_at = excluded.updated_at`,
  ).run(userId, date, round2(totalAmount), round2(totalProfit), round2(dayProfit), items.length, watchCount, now);
  commit();

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

/** 账户资产/收益历史（默认近 30 天） */
function getHistory(userId, days = 30) {
  const n = Math.min(Math.max(Number(days) || 30, 1), 365);
  const rows = getDb()
    .prepare('SELECT date, total_amount, total_profit, day_profit, position_cnt, watch_cnt FROM account_daily WHERE user_id = ? ORDER BY date DESC LIMIT ?')
    .all(userId, n);
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

/** 某日（或最近 N 天）持仓明细快照 */
function getPositionDaily(userId, { date, days = 1 } = {}) {
  const db = getDb();
  if (date) {
    const rows = db
      .prepare('SELECT date, code, name, amount, profit, nav, day_change, est_change, day_profit FROM position_daily WHERE user_id = ? AND date = ? ORDER BY day_profit DESC')
      .all(userId, date);
    return rows.map(mapDaily);
  }
  const n = Math.min(Math.max(Number(days) || 1, 1), 90);
  const dates = db
    .prepare('SELECT DISTINCT date FROM position_daily WHERE user_id = ? ORDER BY date DESC LIMIT ?')
    .all(userId, n)
    .map((r) => r.date);
  if (!dates.length) return [];
  const placeholders = dates.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT date, code, name, amount, profit, nav, day_change, est_change, day_profit FROM position_daily WHERE user_id = ? AND date IN (${placeholders}) ORDER BY date DESC, day_profit DESC`)
    .all(userId, ...dates);
  return rows.map(mapDaily);
}

function mapDaily(r) {
  return {
    date: r.date,
    code: r.code,
    name: r.name,
    amount: r.amount,
    profit: r.profit,
    nav: r.nav,
    dayChange: r.day_change,
    estChange: r.est_change,
    dayProfit: r.day_profit,
  };
}

/** 当前账户快照（不触发上游请求；无快照时返回 null） */
function getSnapshot(userId, date) {
  const db = getDb();
  const row = date
    ? db.prepare('SELECT * FROM account_daily WHERE user_id = ? AND date = ?').get(userId, date)
    : db.prepare('SELECT * FROM account_daily WHERE user_id = ? ORDER BY date DESC LIMIT 1').get(userId);
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

module.exports = { buildPortfolio, getHistory, getPositionDaily, getSnapshot, todayLocal };
