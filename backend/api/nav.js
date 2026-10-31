/**
 * 基金历史净值代理（东方财富 f10/lsjz API）
 * GET /api/nav?code=161725&page=1&size=20
 *
 * 实现集中在 server/market.cjs（与 /api/quotes、账本聚合共用）。
 */
const market = require('../server/market.cjs');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
  try {
    const code = (req.query.code || '').toString().trim();
    const page = parseInt(req.query.page || '1', 10);
    const size = Math.min(parseInt(req.query.size || '20', 10), 100);
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: '基金代码须为6位数字' });

    const { total, items } = await market.navListOf(code, page, size);
    res.json({ ok: true, code, total, page, size, items });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
};
