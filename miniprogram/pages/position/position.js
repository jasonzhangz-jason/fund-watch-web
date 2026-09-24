const { api } = require('../../utils/api');

Page({
  data: {
    mode: 'add', // add=添加，list=修改（列表）
    // 添加
    kw: '',
    results: [],
    picked: null,
    amount: '',
    profit: '',
    showPicker: false,
    saving: false,
    err: '',
    // 修改
    list: [],
    editing: '',
    editAmount: '',
    editProfit: '',
  },

  onLoad(query) {
    const mode = (query && query.mode) || 'add';
    this.setData({ mode: mode });
    if (mode === 'list') this.loadList();
    if (query && query.code) {
      this.setData({
        picked: { code: query.code, name: decodeURIComponent(query.name || '') },
        showPicker: false,
      });
    } else if (mode === 'add') {
      this.setData({ showPicker: true });
    }
  },

  /* ---------------- 选择基金 ---------------- */
  onInput(e) {
    const self = this;
    const kw = e.detail.value;
    this.setData({ kw: kw, err: '' });
    if (this.timer) clearTimeout(this.timer);
    if (!kw.trim()) {
      this.setData({ results: [] });
      return;
    }
    this.timer = setTimeout(function () {
      api.search(kw.trim())
        .then(function (r) { self.setData({ results: r.items || [] }); })
        .catch(function (e) { self.setData({ err: e.message }); });
    }, 260);
  },

  onPick(e) {
    const code = e.currentTarget.dataset.code;
    const name = e.currentTarget.dataset.name;
    this.setData({ picked: { code: code, name: name }, results: [], kw: '', showPicker: false, err: '' });
  },

  togglePicker() {
    this.setData({ showPicker: !this.data.showPicker });
  },

  onAmount(e) { this.setData({ amount: e.detail.value }); },
  onProfit(e) { this.setData({ profit: e.detail.value }); },

  save() {
    const self = this;
    const picked = this.data.picked;
    if (!picked) {
      this.setData({ err: '请先选择基金' });
      return;
    }
    const amount = Number(this.data.amount);
    if (!isFinite(amount) || amount < 0) {
      this.setData({ err: '请填写有效的持有金额' });
      return;
    }
    const profit = Number(this.data.profit || 0);
    this.setData({ saving: true, err: '' });
    api.savePosition({ code: picked.code, name: picked.name, amount: amount, profit: isFinite(profit) ? profit : 0 })
      .then(function () {
        self.setData({ saving: false });
        wx.showToast({ title: '已保存到账本', icon: 'success' });
        getApp().notify();
        setTimeout(function () { wx.navigateBack(); }, 600);
      })
      .catch(function (e) {
        self.setData({ saving: false, err: e.message });
      });
  },

  /* ---------------- 修改持仓 ---------------- */
  loadList() {
    const self = this;
    api.positions()
      .then(function (r) {
        self.setData({ list: r.items || [] });
      })
      .catch(function (e) {
        self.setData({ err: e.message });
      });
  },

  onToggleEdit(e) {
    const code = e.currentTarget.dataset.code;
    const row = this.data.list.filter(function (x) { return x.code === code; })[0];
    if (!row) return;
    if (this.data.editing === code) {
      this.setData({ editing: '' });
      return;
    }
    this.setData({ editing: code, editAmount: String(row.amount), editProfit: String(row.profit) });
  },

  onEditAmount(e) { this.setData({ editAmount: e.detail.value }); },
  onEditProfit(e) { this.setData({ editProfit: e.detail.value }); },

  saveEdit(e) {
    const self = this;
    const code = e.currentTarget.dataset.code;
    const row = this.data.list.filter(function (x) { return x.code === code; })[0];
    if (!row) return;
    const amount = Number(this.data.editAmount);
    if (!isFinite(amount) || amount < 0) {
      wx.showToast({ title: '金额不合法', icon: 'none' });
      return;
    }
    api.savePosition({ code: row.code, name: row.name, amount: amount, profit: Number(this.data.editProfit || 0) })
      .then(function () {
        wx.showToast({ title: '已保存', icon: 'success' });
        self.setData({ editing: '' });
        self.loadList();
        getApp().notify();
      })
      .catch(function (err) { wx.showToast({ title: err.message, icon: 'none' }); });
  },

  remove(e) {
    const self = this;
    const code = e.currentTarget.dataset.code;
    const name = e.currentTarget.dataset.name;
    wx.showModal({
      title: '删除持仓',
      content: '确定删除「' + name + '」？',
      success(res) {
        if (!res.confirm) return;
        api.removePositions([code])
          .then(function () {
            wx.showToast({ title: '已删除', icon: 'success' });
            self.loadList();
            getApp().notify();
          })
          .catch(function (err) { wx.showToast({ title: err.message, icon: 'none' }); });
      },
    });
  },

  top(e) {
    const self = this;
    api.reorderPosition(e.currentTarget.dataset.code, 'top')
      .then(function () {
        self.loadList();
        getApp().notify();
      })
      .catch(function (err) { wx.showToast({ title: err.message, icon: 'none' }); });
  },
});
