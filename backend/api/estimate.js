/**
 * 基金盘中实时估值（多级兜底）
 * GET /api/estimate?codes=161725,000001
 *
 * 实现集中在 server/market.cjs（与 /api/quotes、账本聚合共用一套上游逻辑与缓存）：
 *   优先 fundgz 盘中估值；不可用时回落最新历史净值，前端以 estimate.available=false 标识。
 */
const market = require('../server/market.cjs');

const EMPTY = (code) => ({ available: false, code, name: '', gsz: '', gszzl: '', gztime: '', dwjz: '', jzrq: '' });

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
  try {
    const codes = (req.query.codes || '')
      .toString()
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d{6}$/.test(s));
    if (!codes.length) return res.status(400).json({ ok: false, error: '缺少 codes 参数（逗号分隔的6位基金代码）' });

    const items = await Promise.all(codes.map((code) => market.estimateOf(code).catch(() => EMPTY(code))));
    res.json({ ok: true, items });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
};
