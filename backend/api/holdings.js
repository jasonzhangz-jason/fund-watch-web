/**
 * 基金重仓股（真实数据）
 * GET /api/holdings?code=006274
 *
 * 上游：
 *   1) fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc  基金持仓明细（HTML 表格）
 *      —— 涨跌幅列在 HTML 中为空（由前端 JS 填充），故另取行情
 *   2) push2.eastmoney.com/api/qt/ulist.np/get                批量股票行情（f3 = 涨跌幅）
 *
 * 解析与缓存统一在 server/market.cjs 的 getHoldings（持仓穿透也复用同一份数据）。
 */
const { getHoldings } = require('../server/market.cjs');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');
  try {
    const code = (req.query.code || '').toString().trim();
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: '基金代码须为6位数字' });

    const force = String(req.query.refresh || '') === '1';
    const r = await getHoldings(code, { force });
    if (r.error) return res.status(502).json({ ok: false, error: r.error });
    res.json({ ok: true, code: r.code, date: r.date, quarter: r.quarter, items: r.items });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
};
