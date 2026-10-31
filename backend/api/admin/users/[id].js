// /api/admin/users/[id] —— 用户详情（含自选基金）/ 删除用户 / 重置密码（仅管理员）
const { parseCookies } = require('../../../server/auth.cjs');
const h = require('../../../server/handlers.cjs');

const safeJson = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

module.exports = async function handler(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const query = { ...(req.query || {}) };
  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});

  let result;
  if (req.method === 'GET') result = h.adminUserDetail({ cookies, query });
  else if (req.method === 'DELETE') result = h.adminDeleteUser({ cookies, query });
  else if (req.method === 'POST' && body.action === 'resetPassword') result = h.adminResetPassword({ cookies, query, body });
  else result = { status: 405, headers: {}, body: { ok: false, error: '不支持的请求方法' } };

  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
};
