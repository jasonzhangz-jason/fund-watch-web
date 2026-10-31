'use strict';
/**
 * 运营指标明细定义（双运行时共享）
 *   - Node / Vercel：server/handlers.cjs 的 adminMetricDetail 使用
 *   - Cloudflare Workers：workers/src/admin.js 使用
 *
 * 每项：columns 定义前端表格列，sql 返回明细行（别名为前端字段），countSql/countArgs 返回总数
 * （总数必须与 /api/admin/stats 的对应字段一致，test:admin 有专门的一致性断言）。
 */
const METRIC_DEFS = {
  users: {
    title: '注册用户',
    note: '全部账号',
    columns: [
      { key: 'id', label: 'ID', align: 'right' },
      { key: 'username', label: '用户名' },
      { key: 'role', label: '角色' },
      { key: 'createdAt', label: '注册时间' },
    ],
    sql: "SELECT id, username, CASE role WHEN 'admin' THEN '管理员' ELSE '普通用户' END AS role, created_at AS createdAt FROM users ORDER BY id ASC LIMIT 200",
    countSql: 'SELECT COUNT(*) AS n FROM users',
  },
  admins: {
    title: '管理员',
    note: 'role = admin 的账号',
    columns: [
      { key: 'id', label: 'ID', align: 'right' },
      { key: 'username', label: '用户名' },
      { key: 'createdAt', label: '注册时间' },
    ],
    sql: "SELECT id, username, created_at AS createdAt FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 200",
    countSql: "SELECT COUNT(*) AS n FROM users WHERE role = 'admin'",
  },
  activeSessions: {
    title: '活跃会话',
    note: '未过期的登录会话',
    columns: [
      { key: 'username', label: '用户名' },
      { key: 'createdAt', label: '建立时间' },
      { key: 'expiresAt', label: '过期时间' },
      { key: 'remainDays', label: '剩余', align: 'right' },
    ],
    sql: `SELECT u.username AS username, s.created_at AS createdAt, s.expires_at AS expiresAt,
                 CAST(julianday(s.expires_at) - julianday('now') AS INTEGER) AS remainDays
          FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.expires_at > ? ORDER BY s.created_at DESC LIMIT 200`,
    args: () => [new Date().toISOString()],
    countSql: 'SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?',
    countArgs: () => [new Date().toISOString()],
  },
  watchlistItems: {
    title: '自选条数',
    note: 'watchlist 全部记录',
    columns: [
      { key: 'username', label: '用户名' },
      { key: 'code', label: '代码' },
      { key: 'name', label: '基金名称' },
      { key: 'createdAt', label: '加入时间' },
    ],
    sql: `SELECT u.username AS username, w.code AS code, w.name AS name, w.created_at AS createdAt
          FROM watchlist w JOIN users u ON u.id = w.user_id
          ORDER BY w.id DESC LIMIT 200`,
    countSql: 'SELECT COUNT(*) AS n FROM watchlist',
  },
  usersWithWatchlist: {
    title: '有自选用户',
    note: '按用户聚合的自选数量',
    columns: [
      { key: 'username', label: '用户名' },
      { key: 'count', label: '自选条数', align: 'right' },
      { key: 'lastAt', label: '最近加入' },
    ],
    sql: `SELECT u.username AS username, COUNT(*) AS count, MAX(w.created_at) AS lastAt
          FROM watchlist w JOIN users u ON u.id = w.user_id
          GROUP BY w.user_id ORDER BY count DESC LIMIT 200`,
    countSql: 'SELECT COUNT(DISTINCT user_id) AS n FROM watchlist',
  },
  positionsItems: {
    title: '持仓条数',
    note: 'positions 全部记录',
    columns: [
      { key: 'username', label: '用户名' },
      { key: 'code', label: '代码' },
      { key: 'name', label: '基金名称' },
      { key: 'amount', label: '持有金额', align: 'right' },
      { key: 'profit', label: '持有收益', align: 'right' },
      { key: 'createdAt', label: '记录时间' },
    ],
    sql: `SELECT u.username AS username, p.code AS code, p.name AS name, p.amount AS amount,
                 p.profit AS profit, p.created_at AS createdAt
          FROM positions p JOIN users u ON u.id = p.user_id
          ORDER BY p.amount DESC LIMIT 200`,
    countSql: 'SELECT COUNT(*) AS n FROM positions',
  },
  usersWithPositions: {
    title: '有持仓用户',
    note: '按用户聚合的持仓与资产',
    columns: [
      { key: 'username', label: '用户名' },
      { key: 'count', label: '持仓只数', align: 'right' },
      { key: 'amount', label: '持有金额', align: 'right' },
      { key: 'profit', label: '持有收益', align: 'right' },
    ],
    sql: `SELECT u.username AS username, COUNT(*) AS count, SUM(p.amount) AS amount, SUM(p.profit) AS profit
          FROM positions p JOIN users u ON u.id = p.user_id
          GROUP BY p.user_id ORDER BY amount DESC LIMIT 200`,
    countSql: 'SELECT COUNT(DISTINCT user_id) AS n FROM positions',
  },
  quotesCached: {
    title: '行情缓存',
    note: 'fund_quotes 缓存的基金行情',
    columns: [
      { key: 'code', label: '代码' },
      { key: 'name', label: '基金名称' },
      { key: 'nav', label: '单位净值', align: 'right' },
      { key: 'navDate', label: '净值日期' },
      { key: 'dayChange', label: '当日涨幅%', align: 'right' },
      { key: 'estChange', label: '盘中估值%', align: 'right' },
      { key: 'updatedAt', label: '抓取时间' },
    ],
    sql: `SELECT code, name, nav, nav_date AS navDate, day_change AS dayChange,
                 est_change AS estChange, updated_at AS updatedAt
          FROM fund_quotes ORDER BY updated_at DESC LIMIT 200`,
    countSql: 'SELECT COUNT(*) AS n FROM fund_quotes',
  },
  snapshotDays: {
    title: '快照天数',
    note: 'account_daily 按交易日聚合',
    columns: [
      { key: 'date', label: '交易日' },
      { key: 'users', label: '用户数', align: 'right' },
      { key: 'amount', label: '账户资产合计', align: 'right' },
      { key: 'dayProfit', label: '当日总收益合计', align: 'right' },
    ],
    sql: `SELECT date, COUNT(*) AS users, SUM(total_amount) AS amount, SUM(day_profit) AS dayProfit
          FROM account_daily GROUP BY date ORDER BY date DESC LIMIT 200`,
    countSql: 'SELECT COUNT(DISTINCT date) AS n FROM account_daily',
  },
  positionDailyRows: {
    title: '每日明细行',
    note: 'position_daily 每只持仓的每日快照',
    columns: [
      { key: 'date', label: '交易日' },
      { key: 'username', label: '用户名' },
      { key: 'code', label: '代码' },
      { key: 'name', label: '基金名称' },
      { key: 'dayChange', label: '当日涨幅%', align: 'right' },
      { key: 'dayProfit', label: '当日收益', align: 'right' },
    ],
    sql: `SELECT d.date AS date, u.username AS username, d.code AS code, d.name AS name,
                 d.day_change AS dayChange, d.day_profit AS dayProfit
          FROM position_daily d JOIN users u ON u.id = d.user_id
          ORDER BY d.date DESC, d.day_profit DESC LIMIT 200`,
    countSql: 'SELECT COUNT(*) AS n FROM position_daily',
  },
};

module.exports = { METRIC_DEFS };
