/** 涨跌色块（对应 Web 端 components/ui.tsx 的 ChangeChip） */
Component({
  properties: {
    value: { type: Number, value: 0, observer: 'sync' },
    muted: { type: Boolean, value: false, observer: 'sync' },
    small: { type: Boolean, value: false },
  },
  data: { text: '—', cls: 'chip-gray' },
  lifetimes: {
    attached() {
      this.sync();
    },
  },
  methods: {
    sync() {
      const v = Number(this.data.value);
      if (this.data.muted || !isFinite(v)) {
        this.setData({ text: '—', cls: 'chip-gray' });
        return;
      }
      this.setData({
        text: (v >= 0 ? '+' : '') + v.toFixed(2) + '%',
        cls: v >= 0 ? 'chip-up' : 'chip-down',
      });
    },
  },
});
