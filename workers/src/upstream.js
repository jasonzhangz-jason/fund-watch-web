/**
 * 上游行情与基金数据（Cloudflare Workers 版）
 *
 * 与 Node 端 server/market.cjs 保持**同一套上游地址与解析规则**：
 *   估值 fundgz.1234567.com.cn/js/{code}.js（JSONP）
 *   净值 api.fund.eastmoney.com/f10/lsjz（需 Referer）
 *   重仓股 fundf10.eastmoney.com/FundArchivesDatas.aspx（HTML 表格）+ push2 批量股票行情
 *
 * 差异：行情缓存落在 **D1 的 fund_quotes 表**（跨请求共享），重仓股/净值历史用实例内 Map（短时缓存）。
 */
import { all, one, run, nowIso } from './db.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const GZ_URL = 'https://fundgz.1234567.com.cn/js';
const LSJZ_URL = 'https://api.fund.eastmoney.com/f10/lsjz';
const JJCC_URL = 'https://fundf10.eastmoney.com/FundArchivesDatas.aspx';
const STOCK_QUOTE_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get';

export const CACHE_TTL_MS = 60_000;
const NAV_PAGE_SIZE = 20;
const HOLDINGS_TTL_MS = 30 * 60 * 1000;

const isCode = (c) => /^\d{6}$/.test(String(c || ''));
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const numOf = (s) => {
  const v = parseFloat(String(s || '').replace(/[,%\s]/g, ''));
  return Number.isFinite(v) ? v : null;
};
const stripTags = (html) => html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
const marketOf = (code) => (/^(6|5|9)/.test(code) ? '1' : '0');
const fundHeaders = (code) => ({ 'User-Agent': UA, Referer: `https://fund.eastmoney.com/${code}.html` });

/** 实例内缓存（重仓股是季度数据，净值历史变化慢） */
const holdingsCache = new Map();
const navHistoryCache = new Map();

/* ---------------- 盘中估值（JSONP） ---------------- */
function parseJsonp(text) {
  const m = text.match(/jsonpgz\(\s*(\{[\s\S]*?\})\s*\)\s*;?/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export async function gzOf(code) {
  try {
    const r = await fetch(`${GZ_URL}/${code}.js?rt=${Date.now()}`, {
      headers: fundHeaders(code),
      signal: AbortSignal.timeout(8000),
    });
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

/* ---------------- 历史净值 ---------------- */
export async function navListOf(code, page = 1, size = 20) {
  const r = await fetch(`${LSJZ_URL}?fundCode=${code}&pageIndex=${page}&pageSize=${size}`, {
    headers: fundHeaders(code),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`upstream http ${r.status}`);
  const j = await r.json();
  const rows = j && j.Data && j.Data.LSJZList;
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

export async function latestNavOf(code) {
  try {
    const { items } = await navListOf(code, 1, 1);
    return items[0] || null;
  } catch {
    return null;
  }
}

/** 取最近 need 个交易日的净值（上游每页最多 20 条，自动翻页） */
export async function navHistoryOf(code, need = 61, opts = {}) {
  const hit = navHistoryCache.get(code);
  if (!opts.force && hit && Date.now() - hit.at < HOLDINGS_TTL_MS && hit.value.length >= need) return hit.value;
  const pages = Math.max(1, Math.ceil(need / NAV_PAGE_SIZE));
  const items = [];
  for (let p = 1; p <= pages; p += 1) {
    try {
      const { items: rows } = await navListOf(code, p, NAV_PAGE_SIZE);
      items.push(...rows);
      if (rows.length < NAV_PAGE_SIZE) break;
    } catch {
      break;
    }
  }
  if (items.length) navHistoryCache.set(code, { at: Date.now(), value: items });
  return items.length ? items : (hit && hit.value) || [];
}

/** 单只基金的估值结构（估值不可用时回落为最新净值信息） */
export async function estimateOf(code) {
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

/* ---------------- 重仓股 ---------------- */
export async function fetchHoldings(code) {
  const r = await fetch(`${JJCC_URL}?type=jjcc&code=${code}&topline=10`, {
    headers: { 'User-Agent': UA, Referer: `https://fundf10.eastmoney.com/ccmx_${code}.html` },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`upstream http ${r.status}`);
  const html = await r.text();

  const date = (html.match(/截止至：<font[^>]*>([\d-]+)<\/font>/) || [])[1] || null;
  const quarter = (html.match(/(\d{4}年\d季度)股票投资明细/) || [])[1] || null;

  const tbody = (html.match(/<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || '';
  const rows = [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => stripTags(c[1])),
  );

  const items = rows
    .map((cells) => ({
      code: cells[1] || '',
      name: cells[2] || '',
      weight: numOf(cells[6]),
      shares: numOf(cells[7]),
      marketValue: numOf(cells[8]),
      change: null,
    }))
    .filter((i) => /^\d{6}$/.test(i.code) && i.name);

  if (items.length) {
    try {
      const secids = items.map((i) => `${marketOf(i.code)}.${i.code}`).join(',');
      const qr = await fetch(`${STOCK_QUOTE_URL}?secids=${secids}&fields=f3,f12&fltt=2&invt=2`, {
        headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
        signal: AbortSignal.timeout(8000),
      });
      const qj = await qr.json();
      const map = new Map(((qj && qj.data && qj.data.diff) || []).map((d) => [d.f12, d.f3]));
      for (const i of items) {
        const v = map.get(i.code);
        i.change = typeof v === 'number' ? v : null;
      }
    } catch {
      /* 行情失败不影响持仓明细 */
    }
  }
  return { code, date, quarter, items };
}

export async function getHoldings(code, opts = {}) {
  if (!isCode(code)) return { code, date: null, quarter: null, items: [] };
  const hit = holdingsCache.get(code);
  if (!opts.force && hit && Date.now() - hit.at < HOLDINGS_TTL_MS) return hit.value;
  try {
    const value = await fetchHoldings(code);
    holdingsCache.set(code, { at: Date.now(), value });
    return value;
  } catch (e) {
    if (hit) return { ...hit.value, stale: true };
    return { code, date: null, quarter: null, items: [], error: e.message };
  }
}

/* ---------------- 行情（D1 缓存） ---------------- */
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

export async function fetchQuote(code) {
  const [gz, nav] = await Promise.all([gzOf(code), latestNavOf(code)]);
  if (!gz && !nav) return null;
  return {
    code,
    name: (gz && gz.name) || '',
    nav: num(nav && nav.dwjz) ?? num(gz && gz.dwjz),
    nav_date: (nav && nav.date) || (gz && gz.jzrq) || null,
    day_change: num(nav && nav.jzzzl),
    acc_nav: num(nav && nav.ljjz),
    est_change: gz ? num(gz.gszzl) : null,
    est_time: (gz && gz.gztime) || null,
    estimate_available: Boolean(gz),
  };
}

async function readCached(db, codes) {
  if (!codes.length) return [];
  const placeholders = codes.map(() => '?').join(',');
  return all(db, `SELECT * FROM fund_quotes WHERE code IN (${placeholders})`, ...codes);
}

async function writeCached(db, q) {
  await run(
    db,
    `INSERT INTO fund_quotes (code, name, nav, nav_date, day_change, acc_nav, est_change, est_time, estimate_available, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET
       name = excluded.name, nav = excluded.nav, nav_date = excluded.nav_date,
       day_change = excluded.day_change, acc_nav = excluded.acc_nav,
       est_change = excluded.est_change, est_time = excluded.est_time,
       estimate_available = excluded.estimate_available, updated_at = excluded.updated_at`,
    q.code,
    q.name || '',
    q.nav,
    q.nav_date,
    q.day_change,
    q.acc_nav,
    q.est_change,
    q.est_time,
    q.estimate_available ? 1 : 0,
    nowIso(),
  );
}

/**
 * 取多只基金行情（默认 60s 缓存）
 * @returns {Promise<Map<string, object>>}
 */
export async function getQuotes(db, codes, opts = {}) {
  const list = [...new Set((codes || []).filter(isCode))];
  const map = new Map();
  if (!list.length) return map;

  const maxAge = opts.maxAgeMs ?? CACHE_TTL_MS;
  const now = Date.now();
  for (const row of await readCached(db, list)) map.set(row.code, rowToQuote(row));

  const stale = list.filter((code) => {
    if (opts.force) return true;
    const q = map.get(code);
    if (!q || !q.updated_at) return true;
    return now - Date.parse(q.updated_at) > maxAge;
  });

  if (stale.length) {
    await Promise.all(
      stale.map(async (code) => {
        const q = await fetchQuote(code).catch(() => null);
        if (!q) return;
        await writeCached(db, q);
        map.set(code, { ...q, updated_at: nowIso() });
      }),
    );
  }
  return map;
}

/** 最新净值日期（"当日"口径）；无数据时用本地日期 */
export function tradeDateOf(quotes) {
  const dates = [...quotes.values()].map((q) => q.nav_date).filter(Boolean).sort();
  if (dates.length) return dates[dates.length - 1];
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export { isCode };
