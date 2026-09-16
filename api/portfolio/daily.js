// /api/portfolio/daily —— 持仓每日明细快照（position_daily）
// GET /api/portfolio/daily?date=2026-09-16
// GET /api/portfolio/daily?days=7
const { parseCookies } = require('../../server/auth.cjs');
const h = require('../../server/handlers.cjs');

module.exports = async function handler(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const query = req.query || {};
  const result =
    req.method === 'GET'
      ? h.portfolioDaily({ cookies, query })
      : { status: 405, headers: {}, body: { ok: false, error: '不支持的请求方法' } };

  for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
};
