// /api/portfolio/lookthrough —— 持仓穿透：按各基金前十大重仓股穿透到个股（需登录）
const { parseCookies } = require('../../../server/auth.cjs');
const h = require('../../../server/handlers.cjs');

module.exports = async function handler(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const query = { ...(req.query || {}) };

  const result =
    req.method === 'GET'
      ? await h.lookthrough({ cookies, query })
      : { status: 405, headers: {}, body: { ok: false, error: '不支持的请求方法' } };

  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
};
