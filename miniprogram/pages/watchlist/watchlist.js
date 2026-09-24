const { api } = require('../../utils/api');
const F = require('../../utils/format');

const AUTO_MS = 60000;

Page({
  data: {
    statusBarHeight: 20,
    user: null,
    loading: false,
    list: [],
    rows: [],
    empty: false,
    sourceText: '未登录',
    sortKey: '',
    sortDir: 'desc',
    err: '',
  },

  onLoad() {
    const app = getApp();
    this.setData({ statusBarHeight: app.globalData.statusBarHeight });
    this.onAuth = this.handleAuth.bind(this);
    app.subscribe(this.onAuth);
  },

  onUnload() {
    getApp().unsubscribe(this.onAuth);
    this.stopTimer();
  },

  onHide() {
    this.stopTimer();
  },

  onShow() {
    this.setData({ user: getApp().globalData.user });
    this.load();
    this.startTimer();
  },

  handleAuth(user) {
    this.setData({ user: user });
    this.load();
  },

  startTimer() {
    const self = this;
    this.stopTimer();
    this.timer = setInterval(function () { self.load(); }, AUTO_MS);
  },
  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  onPullDownRefresh() {
    this.load().then(function () { wx.stopPullDownRefresh(); });
  },

  load() {
    const self = this;
    const app = getApp();
    if (!app.globalData.user) {
      this.setData({ rows: [], list: [], empty: true, sourceText: '未登录', user: null });
      return Promise.resolve();
    }
    this.setData({ loading: true, err: '' });
    return api.watchlist()
      .then(function (r) {
        const items = r.items || [];
        if (!items.length) {
          self.setData({ rows: [], list: [], empty: true, sourceText: '账号已同步 · 暂无自选' });
          return null;
        }
        const codes = items.map(function (i) { return i.code; });
        // 一次请求拿全部行情（净值 / 当日涨幅 / 盘中估值）
        return api.quotes(codes).then(function (q) {
          const map = {};
          (q.items || []).forEach(function (x) { map[x.code] = x; });
          const rows = items.map(function (i) {
            const m = map[i.code] || {};
            return {
              code: i.code,
              name: m.name || i.name,
              latest: m.day_change === null || m.day_change === undefined ? null : m.day_change,
              estimate: m.est_change === null || m.est_change === undefined ? null : m.est_change,
              estAvailable: Boolean(m.estimate_available) && m.est_change !== null && m.est_change !== undefined,
              navDate: m.nav_date || '',
              latestValue: m.day_change === null || m.day_change === undefined ? -Infinity : m.day_change,
              estimateValue: m.est_change === null || m.est_change === undefined ? -Infinity : m.est_change,
            };
          });
          self.setData({
            rows: rows,
            list: self.applySort(rows),
            empty: false,
            sourceText: '账号已同步 · 60s',
            loading: false,
            user: getApp().globalData.user,
          });
          return null;
        });
      })
      .catch(function (e) {
        self.setData({ loading: false, err: e.message, sourceText: '行情不可用（' + e.message + '）' });
      });
  },

  applySort(rows) {
    const key = this.data.sortKey;
    if (!key) return rows;
    const dir = this.data.sortDir === 'desc' ? -1 : 1;
    const copy = rows.slice();
    copy.sort(function (a, b) {
      const va = key === 'latestChange' ? a.latestValue : a.estimateValue;
      const vb = key === 'latestChange' ? b.latestValue : b.estimateValue;
      if (va === -Infinity && vb === -Infinity) return 0;
      if (va === -Infinity) return 1;
      if (vb === -Infinity) return -1;
      return (va - vb) * dir;
    });
    return copy;
  },

  onSort(e) {
    const key = e.currentTarget.dataset.key;
    let dir = 'desc';
    if (this.data.sortKey === key) dir = this.data.sortDir === 'desc' ? 'asc' : 'desc';
    this.setData({ sortKey: key, sortDir: dir });
    this.setData({ list: this.applySort(this.data.rows) });
  },

  onOpenFund(e) {
    wx.navigateTo({ url: '/pages/fund/fund?code=' + e.currentTarget.dataset.code });
  },

  onAdd() {
    wx.navigateTo({ url: '/pages/search/search' });
  },

  onLogin() {
    wx.switchTab({ url: '/pages/mine/mine' });
  },

  /** 长按取消自选 */
  onLongPress(e) {
    const code = e.currentTarget.dataset.code;
    const name = e.currentTarget.dataset.name;
    wx.showModal({
      title: '取消自选',
      content: '确定将「' + name + '」移出自选？',
      success(res) {
        if (!res.confirm) return;
        api.removeWatch(code).then(function () {
          wx.showToast({ title: '已移除', icon: 'success' });
          getApp().notify();
        });
      },
    });
  },
});
