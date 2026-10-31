// /api/admin/stats —— 后台总览统计（仅管理员）
const { parseCookies } = require('../../server/auth.cjs');
const h = require('../../server/handlers.cjs');

module.exports = async function handler(req, res) {
  const result = req.method === 'GET'
    ? h.adminStats({ cookies: parseCookies(req.headers.cookie) })
    : { status: 405, headers: {}, body: { ok: false, error: '不支持的请求方法' } };
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
};
