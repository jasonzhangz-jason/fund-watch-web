// /api/admin/users —— 用户列表（仅管理员，支持 ?q= 搜索与分页）
const { parseCookies } = require('../../server/auth.cjs');
const h = require('../../server/handlers.cjs');

module.exports = async function handler(req, res) {
  const result = req.method === 'GET'
    ? h.adminUsers({ cookies: parseCookies(req.headers.cookie), query: req.query || {} })
    : { status: 405, headers: {}, body: { ok: false, error: '不支持的请求方法' } };
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
};
