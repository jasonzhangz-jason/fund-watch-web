const { api } = require('../../utils/api');
const F = require('../../utils/format');

Page({
  data: {
    loading: false,
    err: '',
    lt: null,
    items: [],
    sortBy: 'amount',
    expanded: '',
    coveredText: '—',
    totalText: '—',
    coverageText: '—',
    coverageWidth: 0,
    quarterText: '',
    insufficient: [],
  },

  onLoad() {
    this.load();
  },

  onPullDownRefresh() {
    this.load(true).then(function () { wx.stopPullDownRefresh(); });
  },

  load(force) {
    const self = this;
    this.setData({ loading: true, err: '' });
    return api.lookthrough(Boolean(force))
      .then(function (r) {
        const lt = r.lookthrough;
        self.setData({
          loading: false,
          lt: lt,
          items: self.sortItems(lt.items, self.data.sortBy),
          coveredText: F.fmtMoney(lt.coveredAmount),
          totalText: F.fmtMoney(lt.totalAmount),
          coverageText: lt.coverage.toFixed(1) + '%',
          coverageWidth: Math.min(100, lt.coverage),
          quarterText: lt.quarter ? '数据期：' + lt.quarter + (lt.date ? ' · ' + lt.date : '') : '',
          insufficient: lt.noData || [],
        });
      })
      .catch(function (e) {
        self.setData({ loading: false, err: e.message });
      });
  },

  sortItems(items, key) {
    const copy = (items || []).slice();
    copy.sort(function (a, b) { return (b[key] || 0) - (a[key] || 0); });
    return copy.map(function (s) {
      return Object.assign({}, s, {
        amountText: F.fmtMoney(s.amount),
        ratioText: s.ratio.toFixed(2) + '%',
        funds: (s.funds || []).map(function (f) {
          return Object.assign({}, f, {
            amountText: F.fmtMoney(f.amount),
            weightText: f.weight.toFixed(2) + '%',
          });
        }),
      });
    });
  },

  onSort(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ sortBy: key, items: this.sortItems(this.data.items, key) });
  },

  onToggle(e) {
    const code = e.currentTarget.dataset.code;
    this.setData({ expanded: this.data.expanded === code ? '' : code });
  },

  onOpenFund(e) {
    wx.navigateTo({ url: '/pages/fund/fund?code=' + e.currentTarget.dataset.code });
  },

  onRefresh() {
    this.load(true);
  },
});
