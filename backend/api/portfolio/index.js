// /api/portfolio —— 账户账本（账户资产 / 持有收益 / 当日收益 / 持仓明细）
// GET /api/portfolio            使用行情缓存（60s）
// GET /api/portfolio?refresh=1  强制刷新上游行情后重算并落库
const { parseCookies } = require('../../server/auth.cjs');
const h = require('../../server/handlers.cjs');

module.exports = async function handler(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const query = req.query || {};
  const result =
    req.method === 'GET'
      ? await h.getPortfolio({ cookies, query })
      : { status: 405, headers: {}, body: { ok: false, error: '不支持的请求方法' } };

  for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
};
