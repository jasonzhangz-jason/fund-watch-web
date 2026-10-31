// /api/positions/reorder —— 持仓排序（置顶 / 上移 / 下移）
// POST /api/positions/reorder  {code, dir: 'top' | 'up' | 'down'}
const { parseCookies } = require('../../server/auth.cjs');
const h = require('../../server/handlers.cjs');

const safeJson = (s) => {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
};

module.exports = async function handler(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body || {};
  const result =
    req.method === 'POST'
      ? h.reorderPosition({ cookies, body })
      : { status: 405, headers: {}, body: { ok: false, error: '不支持的请求方法' } };

  for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
};
