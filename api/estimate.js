/**
 * 基金盘中实时估值（多级兜底）
 * GET /api/estimate?codes=161725,000001
 *
 * 优先：fundgz.1234567.com.cn/js/{code}.js（JSONP，盘中估值）
 * 兜底：api.fund.eastmoney.com/f10/lsjz 最新历史净值（估值不可用时的降级展示）
 *
 * 注意：fundgz 对部分网络/海外 IP 可能返回 404 页面，此时自动降级为最新净值，
 * 前端会用 estimate.available=false 标识。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const GZ_URL = 'https://fundgz.1234567.com.cn/js';
const LSJZ_URL = 'https://api.fund.eastmoney.com/f10/lsjz';

function parseJsonp(text, code) {
  // jsonpgz({...});
  const m = text.match(/jsonpgz\(\s*(\{[\s\S]*?\})\s*\)\s*;?/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

async function gzOf(code) {
  const url = `${GZ_URL}/${code}.js?rt=${Date.now()}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: `https://fund.eastmoney.com/${code}.html` },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const text = await r.text();
  const j = parseJsonp(text, code);
  if (!j || !j.fundcode) return null;
  return {
    available: true,
    code: j.fundcode,
    name: j.name,
    gsz: j.gsz,          // 估算净值
    gszzl: j.gszzl,      // 估算涨跌幅(%)
    gztime: j.gztime,    // 估值时间
    dwjz: j.dwjz,        // 昨日单位净值
    jzrq: j.jzrq,        // 昨日净值日期
  };
}

async function latestNavOf(code) {
  const url = `${LSJZ_URL}?fundCode=${code}&pageIndex=1&pageSize=1`;
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: `https://fund.eastmoney.com/${code}.html` },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const row = j?.Data?.LSJZList?.[0];
  if (!row) return null;
  return {
    available: false,
    code,
    name: '',
    gsz: row.DWJZ,
    gszzl: row.JZZZL,
    gztime: row.FSRQ,
    dwjz: row.DWJZ,
    jzrq: row.FSRQ,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
  try {
    const codes = (req.query.codes || '').toString().split(',').map((s) => s.trim()).filter((s) => /^\d{6}$/.test(s));
    if (!codes.length) return res.status(400).json({ ok: false, error: '缺少 codes 参数（逗号分隔的6位基金代码）' });

    const results = await Promise.all(codes.map(async (code) => {
      try {
        const gz = await gzOf(code);
        if (gz) return gz;
        const nav = await latestNavOf(code);
        return nav || { available: false, code, name: '', gsz: '', gszzl: '', gztime: '', dwjz: '', jzrq: '' };
      } catch {
        return { available: false, code, name: '', gsz: '', gszzl: '', gztime: '', dwjz: '', jzrq: '' };
      }
    }));
    res.json({ ok: true, items: results });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
};
