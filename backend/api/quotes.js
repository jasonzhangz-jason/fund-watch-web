// /api/quotes —— 批量行情（走 fund_quotes 缓存；命中 60s 内不再打上游）
// GET /api/quotes?codes=161725,006274
// GET /api/quotes?codes=...&refresh=1   强制刷新
const { parseCookies } = require('../server/auth.cjs');
const h = require('../server/handlers.cjs');

module.exports = async function handler(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const query = req.query || {};
  const result =
    req.method === 'GET'
      ? await h.getQuotes({ cookies, query })
      : { status: 405, headers: {}, body: { ok: false, error: '不支持的请求方法' } };

  for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
};
