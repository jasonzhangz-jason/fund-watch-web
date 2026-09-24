const { getBaseUrl } = require('./utils/config');
const api = require('./utils/api');

App({
  globalData: {
    user: null,
    ready: false,
    /** 状态栏高度：三个 tab 页用自绘导航，需要自己留出状态栏 */
    statusBarHeight: 20,
    listeners: [],
  },

  onLaunch() {
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      this.globalData.statusBarHeight = info.statusBarHeight || 20;
    } catch (e) {
      /* 取不到就用默认值 */
    }
    this.refreshUser();
  },

  /** 读取当前登录态（会话在 Cookie 里，由 utils/api 维护） */
  refreshUser() {
    const self = this;
    return api.api.me()
      .then(function (r) {
        self.setUser(r.user || null);
        return r.user || null;
      })
      .catch(function () {
        self.setUser(null);
        return null;
      })
      .then(function (u) {
        self.globalData.ready = true;
        self.notify();
        return u;
      });
  },

  setUser(user) {
    this.globalData.user = user;
    this.notify();
  },

  /** 极简订阅：页面 onLoad 订阅、onUnload 退订 */
  subscribe(fn) {
    this.globalData.listeners.push(fn);
  },
  unsubscribe(fn) {
    this.globalData.listeners = this.globalData.listeners.filter(function (f) {
      return f !== fn;
    });
  },
  notify() {
    const g = this.globalData;
    g.listeners.forEach(function (fn) {
      try {
        fn(g.user, g.ready);
      } catch (e) {
        /* 单个订阅出错不影响其它 */
      }
    });
  },

  /** 未配置服务器地址时给出统一提示 */
  requireBaseUrl() {
    if (!getBaseUrl()) {
      wx.showModal({
        title: '请先配置服务器地址',
        content: '小程序没有「同源」概念，需要先填写后端 API 地址（如 https://your-app.vercel.app）',
        confirmText: '去配置',
        success(res) {
          if (res.confirm) wx.switchTab({ url: '/pages/mine/mine' });
        },
      });
      return false;
    }
    return true;
  },
});
