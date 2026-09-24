/**
 * 后端接口客户端（对应 Web 端 src/lib/api.ts）
 *
 * 与小程序的差异：
 *   1) 只能用 wx.request（无 fetch）
 *   2) 必须使用完整 URL（无同源相对路径）
 *   3) wx.request **不会自动维护 Cookie**：这里手动保存 Set-Cookie 并在后续请求里回传，
 *      从而复用后端既有的 HttpOnly 会话机制（后端读 cookie 头）
 */
const { getBaseUrl } = require('./config');

const COOKIE_KEY = 'fundwatch_session_cookie';

function getCookie() {
  return wx.getStorageSync(COOKIE_KEY) || '';
}

function saveCookieFrom(header) {
  if (!header) return;
  const raw = header['Set-Cookie'] || header['set-cookie'];
  if (!raw) return;
  const first = String(raw).split(',')[0].split(';')[0];
  if (first.indexOf('=') > 0) wx.setStorageSync(COOKIE_KEY, first);
}

function clearCookie() {
  wx.removeStorageSync(COOKIE_KEY);
}

/**
 * 发起请求
 * @param {string} path 以 /api 开头的路径
 * @param {{method?:string, data?:object, timeout?:number}} opts
 */
function request(path, opts) {
  const o = opts || {};
  return new Promise(function (resolve, reject) {
    const base = getBaseUrl();
    if (!base) {
      reject(new Error('未配置服务器地址'));
      return;
    }
    const header = { 'Content-Type': 'application/json' };
    const cookie = getCookie();
    if (cookie) header.Cookie = cookie;

    wx.request({
      url: base + path,
      method: o.method || 'GET',
      data: o.data,
      header: header,
      timeout: o.timeout || 15000,
      success(res) {
        saveCookieFrom(res.header);
        const body = res.data || {};
        if (res.statusCode >= 200 && res.statusCode < 300 && body.ok !== false) {
          resolve(body);
        } else {
          const err = new Error(body.error || ('HTTP ' + res.statusCode));
          err.status = res.statusCode;
          reject(err);
        }
      },
      fail(e) {
        const err = new Error(e.errMsg || '网络请求失败');
        err.status = 0;
        reject(err);
      },
    });
  });
}

const api = {
  /* ---------------- 账号 ---------------- */
  me: function () { return request('/api/auth/me'); },
  register: function (username, password) {
    return request('/api/auth/register', { method: 'POST', data: { username: username, password: password } });
  },
  login: function (username, password) {
    return request('/api/auth/login', { method: 'POST', data: { username: username, password: password } });
  },
  logout: function () {
    return request('/api/auth/logout', { method: 'POST' }).then(function (r) {
      clearCookie();
      return r;
    });
  },

  /* ---------------- 行情（公开接口，无需登录） ---------------- */
  search: function (key) { return request('/api/search?key=' + encodeURIComponent(key)); },
  estimates: function (codes) { return request('/api/estimate?codes=' + codes.join(',')); },
  nav: function (code, size) { return request('/api/nav?code=' + code + '&size=' + (size || 20)); },
  detail: function (code) { return request('/api/detail?code=' + code); },
  holdings: function (code) { return request('/api/holdings?code=' + code); },
  quotes: function (codes, refresh) {
    return request('/api/quotes?codes=' + codes.join(',') + (refresh ? '&refresh=1' : ''));
  },

  /* ---------------- 自选 ---------------- */
  watchlist: function () { return request('/api/watchlist'); },
  addWatch: function (code, name) {
    return request('/api/watchlist', { method: 'POST', data: { code: code, name: name } });
  },
  removeWatch: function (code) { return request('/api/watchlist/' + code, { method: 'DELETE' }); },
  reorderWatch: function (code, dir) {
    return request('/api/watchlist/reorder', { method: 'POST', data: { code: code, dir: dir } });
  },

  /* ---------------- 持仓（账本） ---------------- */
  positions: function () { return request('/api/positions'); },
  savePosition: function (p) { return request('/api/positions', { method: 'POST', data: p }); },
  removePositions: function (codes) {
    return request('/api/positions?codes=' + codes.join(','), { method: 'DELETE' });
  },
  reorderPosition: function (code, dir) {
    return request('/api/positions/reorder', { method: 'POST', data: { code: code, dir: dir } });
  },

  /* ---------------- 账本聚合与衍生分析 ---------------- */
  portfolio: function (refresh) { return request('/api/portfolio' + (refresh ? '?refresh=1' : '')); },
  portfolioHistory: function (days) { return request('/api/portfolio/history?days=' + (days || 30)); },
  portfolioDaily: function (days) { return request('/api/portfolio/daily?days=' + (days || 1)); },
  lookthrough: function (refresh) { return request('/api/portfolio/lookthrough' + (refresh ? '?refresh=1' : '')); },
  correlation: function (days, refresh) {
    return request('/api/portfolio/correlation?days=' + (days || 60) + (refresh ? '&refresh=1' : ''));
  },
};

module.exports = { request: request, api: api, getCookie: getCookie, clearCookie: clearCookie };
