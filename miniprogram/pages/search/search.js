const { api } = require('../../utils/api');
const { getBaseUrl } = require('../../utils/config');

Page({
  data: {
    kw: '',
    loading: false,
    results: [],
    favorites: [],
    searched: false,
    msg: '',
  },

  onLoad() {
    const self = this;
    if (getApp().globalData.user) {
      api.watchlist()
        .then(function (r) {
          self.setData({ favorites: (r.items || []).map(function (i) { return i.code; }) });
        })
        .catch(function () {});
    }
  },

  onInput(e) {
    const self = this;
    const kw = e.detail.value;
    this.setData({ kw: kw, msg: '' });
    if (this.timer) clearTimeout(this.timer);
    if (!kw.trim()) {
      this.setData({ results: [], searched: false });
      return;
    }
    this.timer = setTimeout(function () { self.doSearch(kw.trim()); }, 260);
  },

  doSearch(kw) {
    const self = this;
    if (!getBaseUrl()) {
      this.setData({ msg: '未配置服务器地址，请到「我的」页填写', results: [], searched: true });
      return;
    }
    this.setData({ loading: true });
    api.search(kw)
      .then(function (r) {
        self.setData({ loading: false, results: r.items || [], searched: true });
      })
      .catch(function (e) {
        self.setData({ loading: false, results: [], searched: true, msg: '搜索失败：' + e.message });
      });
  },

  onOpenFund(e) {
    wx.navigateTo({ url: '/pages/fund/fund?code=' + e.currentTarget.dataset.code });
  },

  onAdd(e) {
    const self = this;
    const code = e.currentTarget.dataset.code;
    const name = e.currentTarget.dataset.name;
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
    const added = this.data.favorites.indexOf(code) >= 0;
    const done = function () {
      wx.showToast({ title: added ? '已取消自选' : '已加入自选', icon: 'success' });
      getApp().notify();
    };
    if (added) api.removeWatch(code).then(done).catch(function (e) { wx.showToast({ title: e.message, icon: 'none' }); });
    else api.addWatch(code, name).then(done).catch(function (e) { wx.showToast({ title: e.message, icon: 'none' }); });
    const next = added
      ? this.data.favorites.filter(function (c) { return c !== code; })
      : this.data.favorites.concat([code]);
    this.setData({ favorites: next });
  },
});
