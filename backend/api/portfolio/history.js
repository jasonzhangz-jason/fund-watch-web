// /api/portfolio/history —— 账户资产 / 收益历史（account_daily）
// GET /api/portfolio/history?days=30
const { parseCookies } = require('../../server/auth.cjs');
const h = require('../../server/handlers.cjs');

module.exports = async function handler(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const query = req.query || {};
  const result =
    req.method === 'GET'
      ? h.portfolioHistory({ cookies, query })
      : { status: 405, headers: {}, body: { ok: false, error: '不支持的请求方法' } };

  for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
};
