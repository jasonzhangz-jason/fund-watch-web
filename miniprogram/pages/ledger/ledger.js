const { api } = require('../../utils/api');
const F = require('../../utils/format');

const AUTO_MS = 60000; // 与 Web 端一致的 60s 自动刷新
/** 持仓收益率 = 持有收益 / 本金（本金 = 持有金额 - 持有收益） */
function holdRate(amount, profit) {
  const cost = Number(amount) - Number(profit);
  if (!isFinite(cost) || cost <= 0) return null;
  return (Number(profit) / cost) * 100;
}

Page({
  data: {
    statusBarHeight: 20,
    user: null,
    ready: false,
    loading: false,
    rows: [],
    list: [],
    empty: false,
    totalAmount: '0.00',
    totalDayProfit: '+0.00',
    profitUp: true,
    upCount: 0,
    downCount: 0,
    updatedText: '',
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
    this.load();
    this.startTimer();
  },

  handleAuth(user, ready) {
    this.setData({ user: user, ready: ready });
    this.load();
  },

  startTimer() {
    const self = this;
    this.stopTimer();
    this.timer = setInterval(function () {
      self.load(false);
    }, AUTO_MS);
  },

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  onPullDownRefresh() {
    const self = this;
    this.load(true).then(function () {
      wx.stopPullDownRefresh();
    });
  },

  load(force) {
    const self = this;
    const app = getApp();
    if (!app.globalData.user) {
      this.setData({ rows: [], list: [], empty: true, user: null, ready: app.globalData.ready, sourceText: '未登录', totalAmount: '0.00', totalDayProfit: '+0.00', upCount: 0, downCount: 0 });
      return Promise.resolve();
    }
    this.setData({ loading: true, err: '' });
    return api.portfolio(Boolean(force))
      .then(function (r) {
        const pf = r.portfolio;
        const rows = (pf.items || []).map(function (it) {
          const rate = it.rate === null || it.rate === undefined ? holdRate(it.amount, it.profit) : it.rate;
          return {
            code: it.code,
            name: it.name,
            amount: F.fmtMoney(it.amount),
            dayProfit: F.fmtMoneySigned(it.dayProfit),
            dayProfitUp: it.dayProfit >= 0,
            dayChange: it.dayChange === null ? 0 : it.dayChange,
            dayChangeMuted: it.dayChange === null || it.dayChange === undefined,
            rateText: rate === null ? '—' : '收益率 ' + (rate >= 0 ? '+' : '') + rate.toFixed(2) + '%',
            rateUp: rate === null ? null : rate >= 0,
            rateValue: rate === null ? -Infinity : rate,
            dayProfitValue: it.dayProfit,
            dayChangeValue: it.dayChange === null ? -Infinity : it.dayChange,
            updated: Boolean(it.updatedAt),
          };
        });
        self.setData({
          rows: rows,
          list: self.applySort(rows),
          empty: rows.length === 0,
          totalAmount: F.fmtMoney(pf.totalAmount),
          totalDayProfit: F.fmtMoneySigned(pf.dayProfit),
          profitUp: pf.dayProfit >= 0,
          upCount: rows.filter(function (r) { return r.dayChange > 0; }).length,
          downCount: rows.filter(function (r) { return r.dayChange < 0; }).length,
          updatedText: F.fmtClock(pf.updatedAt),
          sourceText: '服务端已落库 · 60s',
          loading: false,
          user: getApp().globalData.user,
          ready: true,
        });
      })
      .catch(function (e) {
        self.setData({ loading: false, err: e.message, sourceText: '行情不可用（' + e.message + '）' });
      });
  },

  /** 排序：数值降序/升序，无法计算的收益率始终排最后 */
  applySort(rows) {
    const key = this.data.sortKey;
    if (!key) return rows;
    const dir = this.data.sortDir === 'desc' ? -1 : 1;
    const pick = function (r) {
      if (key === 'dayProfit') return { v: r.dayProfitValue, n: false };
      if (key === 'dayChange') return { v: r.dayChangeValue, n: r.dayChangeMuted };
      return { v: r.rateValue, n: r.rateValue === -Infinity };
    };
    const copy = rows.slice();
    copy.sort(function (a, b) {
      const pa = pick(a);
      const pb = pick(b);
      if (pa.n && pb.n) return 0;
      if (pa.n) return 1;
      if (pb.n) return -1;
      return (pa.v - pb.v) * dir;
    });
    return copy;
  },

  onSort(e) {
    const key = e.currentTarget.dataset.key;
    let dir = 'desc';
    if (this.data.sortKey === key) dir = this.data.sortDir === 'desc' ? 'asc' : 'desc';
    this.setData({ sortKey: key, sortDir: dir }, this.afterSort);
  },

  afterSort() {
    this.setData({ list: this.applySort(this.data.rows) });
  },

  onOpenFund(e) {
    wx.navigateTo({ url: '/pages/fund/fund?code=' + e.currentTarget.dataset.code });
  },

  /** ⊕ 操作菜单：搜索基金 / 添加持仓 / 修改持仓 */
  onMenu() {
    const self = this;
    wx.showActionSheet({
      itemList: ['搜索基金', '添加持仓', '修改持仓', '重新穿透行情'],
      success(res) {
        if (res.tapIndex === 0) wx.navigateTo({ url: '/pages/search/search' });
        else if (res.tapIndex === 1) wx.navigateTo({ url: '/pages/position/position?mode=add' });
        else if (res.tapIndex === 2) wx.navigateTo({ url: '/pages/position/position?mode=list' });
        else self.load(true);
      },
    });
  },

  onLogin() {
    wx.switchTab({ url: '/pages/mine/mine' });
  },

  onAdd() {
    wx.navigateTo({ url: '/pages/position/position?mode=add' });
  },
});
