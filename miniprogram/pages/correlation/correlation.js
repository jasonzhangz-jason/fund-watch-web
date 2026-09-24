const { api } = require('../../utils/api');

const COLORS = ['#1977ff', '#e8303c', '#1c9574', '#f5a524', '#8b5cf6', '#0ea5e9', '#ec4899', '#64748b'];

/** 相关性底色：正相关越强越红（同涨同跌），负相关越强越绿（分散） */
function corrStyle(v) {
  if (v === null || v === undefined) return { bg: '#f1f2f4', fg: '#9aa0aa' };
  const a = Math.min(1, Math.abs(v));
  const alpha = (0.06 + a * 0.6).toFixed(3);
  const strong = a > 0.55;
  return v >= 0
    ? { bg: 'rgba(232,48,60,' + alpha + ')', fg: strong ? '#ffffff' : '#5b6068' }
    : { bg: 'rgba(28,149,116,' + alpha + ')', fg: strong ? '#ffffff' : '#5b6068' };
}

function levelText(v) {
  if (v >= 0.8) return '高度相关';
  if (v >= 0.5) return '中度相关';
  if (v >= 0) return '低相关';
  return '负相关';
}

Page({
  data: {
    days: 60,
    loading: false,
    err: '',
    avgText: '—',
    avgUp: false,
    fundCount: 0,
    pairCount: 0,
    rangeText: '',
    pointText: '',
    interpretation: '',
    dates: [],
    series: [],
    legend: [],
    changes: [],
    matrixRows: [],
    colIndexes: [],
    pairs: [],
    mostSimilar: null,
    mostDiverse: null,
    insufficient: [],
    reason: '',
  },

  onLoad() {
    this.load(this.data.days);
  },

  onPullDownRefresh() {
    this.load(this.data.days).then(function () { wx.stopPullDownRefresh(); });
  },

  load(days) {
    const self = this;
    this.setData({ loading: true, err: '', days: days });
    return api.correlation(days, false)
      .then(function (r) {
        const c = r.correlation;
        const funds = c.funds || [];
        const n = funds.length;
        const rows = [];
        for (let i = 0; i < n; i += 1) {
          const cells = [];
          for (let j = 0; j < n; j += 1) {
            const v = c.matrix[i] && c.matrix[i][j] !== undefined ? c.matrix[i][j] : null;
            const st = corrStyle(v);
            cells.push({ v: v === null ? '—' : v.toFixed(2), bg: st.bg, fg: st.fg });
          }
          rows.push({ idx: i + 1, name: funds[i].name, cells: cells });
        }
        const legend = (c.series || []).map(function (s, i) {
          return { idx: i + 1, name: s.name, color: COLORS[i % COLORS.length] };
        });
        const changes = (c.series || []).map(function (s, i) {
          return {
            idx: i + 1,
            name: s.name,
            color: COLORS[i % COLORS.length],
            text: (s.totalChange >= 0 ? '+' : '') + s.totalChange.toFixed(2) + '%',
            up: s.totalChange >= 0,
          };
        });
        const pairs = (c.pairs || []).map(function (p) {
          const color = corrStyle(p.corr).bg;
          return Object.assign({}, p, {
            corrText: p.corr.toFixed(2),
            level: levelText(p.corr),
            barWidth: Math.min(100, Math.abs(p.corr) * 100),
            color: color,
          });
        });
        const avg = c.avgCorr;
        let interpretation = '';
        if (avg !== null && avg !== undefined) {
          if (avg >= 0.8) interpretation = '账本内基金高度同涨同跌，分散化效果有限，可考虑换成相关性更低的品种';
          else if (avg >= 0.5) interpretation = '整体中度相关：有一定分散，但同向波动仍较明显';
          else if (avg >= 0.2) interpretation = '相关性偏低，组合分散效果较好';
          else interpretation = '相关性很低甚至负相关，分散效果很好';
        }
        const colIndexes = [];
        for (let i = 1; i <= n; i += 1) colIndexes.push(i);

        self.setData({
          loading: false,
          avgText: avg === null || avg === undefined ? '—' : avg.toFixed(2),
          avgUp: avg !== null && avg !== undefined && avg >= 0.5,
          fundCount: n,
          pairCount: pairs.length,
          rangeText: c.startDate ? c.startDate + ' ~ ' + c.endDate : '',
          pointText: '共同交易日 ' + c.pointCount + ' 天',
          interpretation: interpretation,
          dates: c.dates || [],
          series: c.series || [],
          legend: legend,
          changes: changes,
          matrixRows: rows,
          colIndexes: colIndexes,
          pairs: pairs,
          mostSimilar: pairs.length ? pairs[0] : null,
          mostDiverse: pairs.length ? pairs[pairs.length - 1] : null,
          insufficient: c.insufficient || [],
          reason: c.reason || '',
        });
      })
      .catch(function (e) {
        self.setData({ loading: false, err: e.message });
      });
  },

  onWindow(e) {
    this.load(Number(e.currentTarget.dataset.days));
  },
});
