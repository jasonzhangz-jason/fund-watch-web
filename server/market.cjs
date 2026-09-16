'use strict';
/**
 * 行情服务（服务端共享）
 *   - 上游：fundgz（盘中估值）+ eastmoney f10/lsjz（历史/最新净值）
 *   - 缓存：fund_quotes 表（默认 60s 内直接命中，避免频繁打上游）
 *   - 对外：estimateOf / navListOf 保持既有 HTTP 接口的数据结构不变；
 *           getQuotes 提供持仓/自选所需的统一行情（净值、当日涨幅、盘中估值）
 */
const { getDb } = require('./db.cjs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const GZ_URL = 'https://fundgz.1234567.com.cn/js';
const LSJZ_URL = 'https://api.fund.eastmoney.com/f10/lsjz';
const CACHE_TTL_MS = 60_000;

const isCode = (c) => /^\d{6}$/.test(String(c || ''));
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

function headers(code) {
  return { 'User-Agent': UA, Referer: `https://fund.eastmoney.com/${code}.html` };
}

function parseJsonp(text) {
  const m = text.match(/jsonpgz\(\s*(\{[\s\S]*?\})\s*\)\s*;?/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** 盘中估值（fundgz）；不可用返回 null */
async function gzOf(code) {
  try {
    const r = await fetch(`${GZ_URL}/${code}.js?rt=${Date.now()}`, { headers: headers(code), signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = parseJsonp(await r.text());
    if (!j || !j.fundcode) return null;
    return {
      available: true,
      code: j.fundcode,
      name: j.name,
      gsz: j.gsz,
      gszzl: j.gszzl,
      gztime: j.gztime,
      dwjz: j.dwjz,
      jzrq: j.jzrq,
    };
  } catch {
    return null;
  }
}

/** 历史净值列表（含最新一条） */
async function navListOf(code, page = 1, size = 20) {
  const r = await fetch(`${LSJZ_URL}?fundCode=${code}&pageIndex=${page}&pageSize=${size}`, {
    headers: headers(code),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`upstream http ${r.status}`);
  const j = await r.json();
  const rows = j?.Data?.LSJZList;
  if (!Array.isArray(rows)) return { total: 0, items: [] };
  return {
    total: j.TotalCount || 0,
    items: rows.map((d) => ({
      date: d.FSRQ,
      dwjz: d.DWJZ,
      ljjz: d.LJJZ,
      jzzzl: d.JZZZL,
      sgzt: d.SGZT,
      shzt: d.SHZT,
    })),
  };
}

/** 最新净值一条（失败返回 null） */
async function latestNavOf(code) {
  try {
    const { items } = await navListOf(code, 1, 1);
    return items[0] || null;
  } catch {
    return null;
  }
}

/** 既有 /api/estimate 的单只结构（估值不可用时回落为最新净值信息） */
async function estimateOf(code) {
  const gz = await gzOf(code);
  if (gz) return gz;
  const row = await latestNavOf(code);
  if (!row) return { available: false, code, name: '', gsz: '', gszzl: '', gztime: '', dwjz: '', jzrq: '' };
  return {
    available: false,
    code,
    name: '',
    gsz: row.dwjz,
    gszzl: row.jzzzl,
    gztime: row.date,
    dwjz: row.dwjz,
    jzrq: row.date,
  };
}

/* ---------------- 行情缓存 ---------------- */

function readCached(codes) {
  if (!codes.length) return [];
  const placeholders = codes.map(() => '?').join(',');
  return getDb().prepare(`SELECT * FROM fund_quotes WHERE code IN (${placeholders})`).all(...codes);
}

function writeCached(q) {
  getDb()
    .prepare(
      `INSERT INTO fund_quotes (code, name, nav, nav_date, day_change, acc_nav, est_change, est_time, estimate_available, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         name = excluded.name, nav = excluded.nav, nav_date = excluded.nav_date,
         day_change = excluded.day_change, acc_nav = excluded.acc_nav,
         est_change = excluded.est_change, est_time = excluded.est_time,
         estimate_available = excluded.estimate_available, updated_at = excluded.updated_at`,
    )
    .run(
      q.code,
      q.name || '',
      q.nav,
      q.nav_date,
      q.day_change,
      q.acc_nav,
      q.est_change,
      q.est_time,
      q.estimate_available ? 1 : 0,
      new Date().toISOString(),
    );
}

/** 单只基金的统一行情（上游 → 规范化结构） */
async function fetchQuote(code) {
  const [gz, nav] = await Promise.all([gzOf(code), latestNavOf(code)]);
  if (!gz && !nav) return null;
  return {
    code,
    name: (gz && gz.name) || '',
    nav: num(nav?.dwjz) ?? num(gz?.dwjz),
    nav_date: nav?.date || gz?.jzrq || null,
    day_change: num(nav?.jzzzl),
    acc_nav: num(nav?.ljjz),
    est_change: gz ? num(gz.gszzl) : null,
    est_time: gz?.gztime || null,
    estimate_available: Boolean(gz),
  };
}

const rowToQuote = (r) => ({
  code: r.code,
  name: r.name,
  nav: r.nav,
  nav_date: r.nav_date,
  day_change: r.day_change,
  acc_nav: r.acc_nav,
  est_change: r.est_change,
  est_time: r.est_time,
  estimate_available: Boolean(r.estimate_available),
  updated_at: r.updated_at,
});

/**
 * 取多只基金行情（默认 60s 缓存）
 * @param {string[]} codes
 * @param {{ maxAgeMs?: number, force?: boolean }} [opts]
 * @returns {Promise<Map<string, object>>} code → quote
 */
async function getQuotes(codes, opts = {}) {
  const list = [...new Set((codes || []).filter(isCode))];
  const map = new Map();
  if (!list.length) return map;

  const maxAge = opts.maxAgeMs ?? CACHE_TTL_MS;
  const now = Date.now();
  for (const row of readCached(list)) map.set(row.code, rowToQuote(row));

  const stale = list.filter((code) => {
    if (opts.force) return true;
    const q = map.get(code);
    if (!q?.updated_at) return true;
    return now - Date.parse(q.updated_at) > maxAge;
  });

  if (stale.length) {
    await Promise.all(
      stale.map(async (code) => {
        const q = await fetchQuote(code).catch(() => null);
        if (!q) return;
        writeCached(q);
        map.set(code, { ...q, updated_at: new Date().toISOString() });
      }),
    );
  }
  return map;
}

/** 持仓/自选里最新的净值日期（用于"当日"口径）；无数据时返回本地日期 */
function tradeDateOf(quotes) {
  const dates = [...quotes.values()].map((q) => q.nav_date).filter(Boolean).sort();
  if (dates.length) return dates[dates.length - 1];
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

module.exports = {
  gzOf,
  navListOf,
  latestNavOf,
  estimateOf,
  fetchQuote,
  getQuotes,
  tradeDateOf,
  CACHE_TTL_MS,
};
