// /api/watchlist —— 自选基金列表 / 新增 / 批量同步
// GET  /api/watchlist            列表（需登录）
// POST /api/watchlist            {code, name} 新增；{mode:'sync', items:[...]} 批量同步
const { parseCookies } = require('../../server/auth.cjs');
const h = require('../../server/handlers.cjs');

const safeJson = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

module.exports = async function handler(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});

  let result;
  if (req.method === 'GET') result = h.listWatchlist({ cookies });
  else if (req.method === 'POST') result = body.mode === 'sync' ? h.syncWatchlist({ cookies, body }) : h.addWatchlist({ cookies, body });
  else result = { status: 405, headers: {}, body: { ok: false, error: '不支持的请求方法' } };

  for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
};
