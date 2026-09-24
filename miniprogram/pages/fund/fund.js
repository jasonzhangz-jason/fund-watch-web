const { api } = require('../../utils/api');

Page({
  data: {
    code: '',
    name: '',
    loading: true,
    err: '',
    estimate: '—',
    estimateLabel: '盘中估值',
    dayChange: '—',
    dayChangeUp: true,
    nav: '—',
    navDate: '',
    trendTitle: '',
    dates: [],
    series: [],
    metrics: [],
    holdings: [],
    quarter: '',
    fav: false,
    loggedIn: false,
  },

  onLoad(query) {
    const code = (query && query.code) || '';
    this.setData({ code: code, loggedIn: Boolean(getApp().globalData.user) });
    if (!/^\d{6}$/.test(code)) {
      this.setData({ loading: false, err: '基金代码不合法' });
      return;
    }
    this.load();
    this.checkFav();
  },

  checkFav() {
    const self = this;
    if (!getApp().globalData.user) return;
    api.watchlist()
      .then(function (r) {
        const codes = (r.items || []).map(function (i) { return i.code; });
        self.setData({ fav: codes.indexOf(self.data.code) >= 0 });
      })
      .catch(function () {});
  },

  load() {
    const self = this;
    const code = this.data.code;
    this.setData({ loading: true, err: '' });
    // 详情 + 估值 + 重仓股并行；任一失败不影响其它
    Promise.all([
      api.detail(code).catch(function () { return null; }),
      api.estimates([code]).catch(function () { return null; }),
      api.holdings(code).catch(function () { return null; }),
    ]).then(function (res) {
      const detail = res[0] || {};
      const est = res[1] && res[1].items && res[1].items[0] ? res[1].items[0] : null;
      const hold = res[2] || {};
      const trend = (detail.trend || []).map(function (p) { return { date: p.date, nav: p.nav }; });
      const dates = trend.map(function (p) { return p.date; });
      const base = trend.length ? trend[0].nav : 0;
      const points = trend.map(function (p) { return base ? (p.nav / base) * 100 : 100; });
      const metrics = (detail.metrics || []).map(function (m) {
        return { label: m.label, value: m.value === null || m.value === undefined ? '—' : m.value, up: m.value >= 0 };
      });
      const holdings = (hold.items || []).map(function (h) {
        return {
          code: h.code,
          name: h.name,
          weight: h.weight === null ? '—' : h.weight.toFixed(2) + '%',
          change: h.change === null || h.change === undefined ? '—' : (h.change >= 0 ? '+' : '') + h.change.toFixed(2) + '%',
          changeUp: h.change >= 0,
        };
      });

      self.setData({
        loading: false,
        name: detail.name || (est && est.name) || code,
        estimate: est && est.available && est.gsz ? est.gsz : (est && est.dwjz ? est.dwjz : '—'),
        estimateLabel: est && est.available ? '盘中估值(' + String(est.gztime || '').slice(5, 10) + ')' : '盘中估值',
        dayChange: est && est.jzzzl ? ((Number(est.jzzzl) >= 0 ? '+' : '') + Number(est.jzzzl).toFixed(2) + '%') : '—',
        dayChangeUp: est ? Number(est.jzzzl) >= 0 : true,
        nav: est && est.dwjz ? est.dwjz : '—',
        navDate: est && est.jzrq ? String(est.jzrq).slice(5) : '',
        dates: dates,
        series: points.length > 1 ? [{ name: detail.name || code, points: points }] : [],
        trendTitle: trend.length > 1 ? '净值走势 · 近' + trend.length + '个交易日' : '净值走势',
        metrics: metrics,
        holdings: holdings,
        quarter: hold.quarter ? hold.quarter + (hold.date ? ' · ' + hold.date : '') : '',
      });
    });
  },

  onToggleFav() {
    const self = this;
    if (!getApp().globalData.user) {
      wx.showModal({
        title: '需要登录',
        content: '自选属于账号数据，登录后写入 SQLite 并与网页端同步',
        confirmText: '去登录',
        success(res) {
          if (res.confirm) wx.switchTab({ url: '/pages/mine/mine' });
        },
      });
      return;
    }
    const fav = this.data.fav;
    const done = function () {
      self.setData({ fav: !fav });
      wx.showToast({ title: fav ? '已取消自选' : '已加入自选', icon: 'success' });
      getApp().notify();
    };
    if (fav) api.removeWatch(this.data.code).then(done).catch(function (e) { wx.showToast({ title: e.message, icon: 'none' }); });
    else api.addWatch(this.data.code, this.data.name).then(done).catch(function (e) { wx.showToast({ title: e.message, icon: 'none' }); });
  },

  onAddPosition() {
    wx.navigateTo({ url: '/pages/position/position?mode=add&code=' + this.data.code + '&name=' + encodeURIComponent(this.data.name) });
  },
});
