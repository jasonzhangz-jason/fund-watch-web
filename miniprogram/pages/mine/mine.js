const { api } = require('../../utils/api');
const F = require('../../utils/format');
const { getBaseUrl, setBaseUrl } = require('../../utils/config');

Page({
  data: {
    statusBarHeight: 20,
    user: null,
    ready: false,
    // 登录表单
    mode: 'login',
    username: '',
    password: '',
    busy: false,
    formErr: '',
    // 账本概览
    totalAmount: '0.00',
    totalDayProfit: '+0.00',
    profitUp: true,
    positionCount: 0,
    watchCount: 0,
    summaryText: '暂无持仓',
    // 服务器地址
    baseUrl: '',
    baseInput: '',
    baseMsg: '',
    baseMsgOk: false,
    testing: false,
  },

  onLoad() {
    const app = getApp();
    this.setData({ statusBarHeight: app.globalData.statusBarHeight, baseUrl: getBaseUrl(), baseInput: getBaseUrl() });
    this.onAuth = this.handleAuth.bind(this);
    app.subscribe(this.onAuth);
  },

  onUnload() {
    getApp().unsubscribe(this.onAuth);
  },

  onShow() {
    const app = getApp();
    this.setData({ user: app.globalData.user, ready: app.globalData.ready });
    if (app.globalData.user) this.loadPortfolio();
  },

  handleAuth(user, ready) {
    this.setData({ user: user, ready: ready });
    if (user) this.loadPortfolio();
    else this.setData({ totalAmount: '0.00', totalDayProfit: '+0.00', positionCount: 0, watchCount: 0, summaryText: '暂无持仓' });
  },

  loadPortfolio() {
    const self = this;
    return api.portfolio()
      .then(function (r) {
        const pf = r.portfolio;
        self.setData({
          totalAmount: F.fmtMoney(pf.totalAmount),
          totalDayProfit: F.fmtMoneySigned(pf.dayProfit),
          profitUp: pf.dayProfit >= 0,
          positionCount: pf.positionCount,
          watchCount: pf.watchCount,
          summaryText: '持仓 ' + pf.positionCount + ' 只 · 服务端账本已落库',
        });
      })
      .catch(function (e) {
        self.setData({ summaryText: '账本不可用（' + e.message + '）' });
      });
  },

  /* ---------------- 登录 / 注册 ---------------- */
  switchMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode, formErr: '' });
  },
  onUserInput(e) {
    this.setData({ username: e.detail.value, formErr: '' });
  },
  onPwdInput(e) {
    this.setData({ password: e.detail.value, formErr: '' });
  },

  submit() {
    const self = this;
    const u = this.data.username.trim();
    const p = this.data.password;
    if (!u || !p) {
      this.setData({ formErr: '请填写用户名与密码' });
      return;
    }
    if (!getApp().requireBaseUrl()) return;
    this.setData({ busy: true, formErr: '' });
    const fn = this.data.mode === 'login' ? api.login : api.register;
    fn(u, p)
      .then(function (r) {
        getApp().setUser(r.user);
        self.setData({ busy: false, username: '', password: '', formErr: '' });
        wx.showToast({ title: self.data.mode === 'login' ? '登录成功' : '注册成功', icon: 'success' });
        self.loadPortfolio();
      })
      .catch(function (e) {
        self.setData({ busy: false, formErr: e.message });
      });
  },

  logout() {
    const self = this;
    wx.showModal({
      title: '退出登录',
      content: '确定退出当前账号？',
      success(res) {
        if (!res.confirm) return;
        api.logout().then(function () {
          getApp().setUser(null);
          self.setData({ username: '', password: '' });
          wx.showToast({ title: '已退出', icon: 'success' });
        });
      },
    });
  },

  /* ---------------- 服务器地址 ---------------- */
  onBaseInput(e) {
    this.setData({ baseInput: e.detail.value, baseMsg: '' });
  },

  testBase() {
    const self = this;
    const url = String(this.data.baseInput || '').trim().replace(/\/+$/, '');
    if (!url) {
      this.setData({ baseMsg: '请填写后端地址（如 https://your-app.vercel.app）', baseMsgOk: false });
      return;
    }
    this.setData({ testing: true, baseMsg: '' });
    wx.request({
      url: url + '/api/health',
      method: 'GET',
      success(res) {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        self.setData({
          testing: false,
          baseMsgOk: ok,
          baseMsg: ok ? '连接成功' : '后端返回 HTTP ' + res.statusCode,
        });
      },
      fail(e) {
        self.setData({ testing: false, baseMsgOk: false, baseMsg: '无法连接：' + (e.errMsg || '') });
      },
    });
  },

  saveBase() {
    const self = this;
    const clean = setBaseUrl(this.data.baseInput);
    this.setData({ baseUrl: clean, baseInput: clean, baseMsg: '已保存，正在重新读取账号…', baseMsgOk: true });
    getApp().refreshUser().then(function () {
      self.setData({ baseMsg: clean ? '已保存：' + clean : '已清空（需重新配置才能使用）', baseMsgOk: true });
    });
  },

  /* ---------------- 入口 ---------------- */
  goWatchlist() {
    wx.switchTab({ url: '/pages/watchlist/watchlist' });
  },
  goLedger() {
    wx.switchTab({ url: '/pages/ledger/ledger' });
  },
  goLookthrough() {
    wx.navigateTo({ url: '/pages/lookthrough/lookthrough' });
  },
  goCorrelation() {
    wx.navigateTo({ url: '/pages/correlation/correlation' });
  },
  noop() {},
});
