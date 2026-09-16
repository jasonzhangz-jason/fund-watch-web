// /api/watchlist/[code] —— 删除自选
// DELETE /api/watchlist/161725
const { parseCookies } = require('../../server/auth.cjs');
const h = require('../../server/handlers.cjs');

module.exports = async function handler(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const result = req.method === 'DELETE'
    ? h.removeWatchlist({ cookies, query: { code: req.query.code } })
    : { status: 405, headers: {}, body: { ok: false, error: '不支持的请求方法' } };

  for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
};
