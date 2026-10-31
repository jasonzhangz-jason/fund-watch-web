// /api/positions —— 账号持仓（列表 / 新增或更新 / 删除）
// GET    /api/positions            列表（需登录）
// POST   /api/positions            {code, name, amount, profit} 新增或更新
// DELETE /api/positions?codes=a,b  删除一条或多条
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
  const query = req.query || {};

  let result;
  if (req.method === 'GET') result = h.listPositions({ cookies });
  else if (req.method === 'POST') result = h.savePosition({ cookies, body });
  else if (req.method === 'DELETE') result = h.removePositions({ cookies, body, query });
  else result = { status: 405, headers: {}, body: { ok: false, error: '不支持的请求方法' } };

  for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
};
