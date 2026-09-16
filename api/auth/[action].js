// /api/auth/[action]  —— 注册 / 登录 / 登出 / 当前用户
// POST /api/auth/register | /api/auth/login | /api/auth/logout
// GET  /api/auth/me
const { parseCookies } = require('../../server/auth.cjs');
const h = require('../../server/handlers.cjs');

const safeJson = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

module.exports = async function handler(req, res) {
  const action = String(req.query.action || '');
  const cookies = parseCookies(req.headers.cookie);
  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});

  let result;
  switch (`${req.method} ${action}`) {
    case 'POST register': result = h.register({ body }); break;
    case 'POST login':    result = h.login({ body }); break;
    case 'POST logout':   result = h.logout({ cookies }); break;
    case 'GET me':        result = h.me({ cookies }); break;
    default:              result = { status: 404, headers: {}, body: { ok: false, error: '未知的认证接口' } };
  }

  for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
};
