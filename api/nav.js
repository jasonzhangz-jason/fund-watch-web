/**
 * 基金历史净值代理（东方财富 f10/lsjz API）
 * GET /api/nav?code=161725&page=1&size=20
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const LSJZ_URL = 'https://api.fund.eastmoney.com/f10/lsjz';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
  try {
    const code = (req.query.code || '').toString().trim();
    const page = parseInt(req.query.page || '1', 10);
    const size = Math.min(parseInt(req.query.size || '20', 10), 100);
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: '基金代码须为6位数字' });

    const url = `${LSJZ_URL}?fundCode=${code}&pageIndex=${page}&pageSize=${size}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: `https://fund.eastmoney.com/${code}.html` },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`upstream http ${r.status}`);
    const j = await r.json();
    if (!j.Data || !Array.isArray(j.Data.LSJZList)) {
      return res.json({ ok: true, code, total: 0, items: [] });
    }
    const items = j.Data.LSJZList.map((d) => ({
      date: d.FSRQ,
      dwjz: d.DWJZ,            // 单位净值
      ljjz: d.LJJZ,            // 累计净值
      jzzzl: d.JZZZL,          // 日增长率(%)
      sgzt: d.SGZT,            // 申购状态
      shzt: d.SHZT,            // 赎回状态
    }));
    res.json({ ok: true, code, total: j.TotalCount || 0, page, size, items });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
};
