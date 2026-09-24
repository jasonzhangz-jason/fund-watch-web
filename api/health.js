/**
 * GET /api/health —— 健康检查（公开接口，无需登录）
 *
 * 用途：
 *   1) 部署后自检 / 监控探活
 *   2) Web 端与微信小程序「服务器地址 → 测试连接」的探测地址
 *      （因此必须作为真实的 Vercel 函数存在，不能只写在本地 dev-server 里）
 */
const { dbInfo } = require('../server/db.cjs');

module.exports = async function handler(req, res) {
  // 公开接口：允许任意来源、不需要凭据
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: '不支持的请求方法' });

  let db = null;
  try {
    db = dbInfo();
  } catch {
    /* 数据库尚未初始化（首次冷启动） */
  }
  res.json({
    ok: true,
    service: 'fund-watch-web',
    version: require('../package.json').version,
    time: new Date().toISOString(),
    db,
  });
};
