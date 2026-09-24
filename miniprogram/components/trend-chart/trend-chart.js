/**
 * 归一化走势对比图（起点 = 100）
 *   对应 Web 端 components/TrendCompare.tsx：小程序无 SVG，改用 canvas 2d 绘制。
 *   传入 dates（共同交易日）与 series（[{name, points}]），points 已由后端归一化。
 */
const COLORS = ['#1977ff', '#e8303c', '#1c9574', '#f5a524', '#8b5cf6', '#0ea5e9', '#ec4899', '#64748b'];

Component({
  properties: {
    dates: { type: Array, value: [], observer: 'draw' },
    series: { type: Array, value: [], observer: 'draw' },
  },
  data: { width: 0, height: 320 },
  lifetimes: {
    attached() {
      this.initCanvas();
    },
  },
  methods: {
    initCanvas() {
      const self = this;
      wx.createSelectorQuery()
        .in(this)
        .select('#trend-canvas')
        .fields({ node: true, size: true })
        .exec(function (res) {
          const item = res && res[0];
          if (!item || !item.node) return;
          const canvas = item.node;
          const dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2) || 2;
          canvas.width = item.width * dpr;
          canvas.height = item.height * dpr;
          const ctx = canvas.getContext('2d');
          ctx.scale(dpr, dpr);
          self.canvas = canvas;
          self.ctx = ctx;
          self.box = { w: item.width, h: item.height };
          self.draw();
        });
    },

    draw() {
      const ctx = this.ctx;
      const box = this.box;
      if (!ctx || !box) return;
      const dates = this.data.dates || [];
      const series = this.data.series || [];
      const w = box.w;
      const h = box.h;
      const pad = { top: 12, right: 8, bottom: 22, left: 38 };

      ctx.clearRect(0, 0, w, h);
      if (!series.length || dates.length < 2) return;

      // 计算 y 轴范围（含基准 100）
      let lo = 100;
      let hi = 100;
      series.forEach(function (s) {
        (s.points || []).forEach(function (v) {
          if (typeof v === 'number' && isFinite(v)) {
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        });
      });
      const span = Math.max(1, hi - lo);
      const min = lo - span * 0.12;
      const max = hi + span * 0.12;
      const n = dates.length - 1;
      const xOf = function (i) { return pad.left + (i / n) * (w - pad.left - pad.right); };
      const yOf = function (v) { return pad.top + (1 - (v - min) / (max - min)) * (h - pad.top - pad.bottom); };

      // 横向参考线（区间低点 / 100 / 区间高点）
      const ticks = [lo, 100, hi];
      ctx.font = '10px sans-serif';
      ctx.textBaseline = 'middle';
      ticks.forEach(function (t, idx) {
        if (idx > 0 && Math.abs(t - ticks[idx - 1]) < 0.01) return;
        const y = yOf(t);
        ctx.strokeStyle = t === 100 ? '#c8cdd6' : '#eff1f4';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (ctx.setLineDash) ctx.setLineDash(t === 100 ? [3, 3] : []);
        ctx.moveTo(pad.left, y);
        ctx.lineTo(w - pad.right, y);
        ctx.stroke();
        if (ctx.setLineDash) ctx.setLineDash([]);
        ctx.fillStyle = '#9aa0aa';
        ctx.textAlign = 'right';
        ctx.fillText(t.toFixed(t === 100 ? 0 : 1), pad.left - 6, y);
      });

      // 各基金曲线
      series.forEach(function (s, si) {
        const pts = s.points || [];
        if (pts.length < 2) return;
        ctx.strokeStyle = COLORS[si % COLORS.length];
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        pts.forEach(function (v, i) {
          const x = xOf(i);
          const y = yOf(v);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      });

      // 时间轴首尾
      ctx.fillStyle = '#9aa0aa';
      ctx.textAlign = 'left';
      ctx.fillText(String(dates[0]).slice(5), pad.left, h - 8);
      ctx.textAlign = 'right';
      ctx.fillText(String(dates[dates.length - 1]).slice(5), w - pad.right, h - 8);
    },
  },
});
