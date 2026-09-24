/** 格式化工具：与 Web 端 src/state/store.tsx 的口径保持一致 */

function fmtMoney(n) {
  const v = Number(n) || 0;
  const neg = v < 0;
  const fixed = Math.abs(v).toFixed(2);
  const parts = fixed.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + parts.join('.');
}

function fmtMoneySigned(n) {
  const v = Number(n) || 0;
  return (v >= 0 ? '+' : '-') + fmtMoney(Math.abs(v));
}

function fmtPct(n, digits) {
  const v = Number(n);
  if (!isFinite(v)) return '—';
  const d = digits === undefined ? 2 : digits;
  return (v >= 0 ? '+' : '') + v.toFixed(d) + '%';
}

/** ISO 时间 → MM-DD HH:mm */
function fmtTime(iso) {
  if (!iso) return '';
  const s = String(iso);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return s;
  return m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
}

/** ISO 时间 → HH:mm */
function fmtClock(iso) {
  const s = String(iso || '');
  const m = s.match(/T(\d{2}):(\d{2})/);
  return m ? m[1] + ':' + m[2] : '';
}

module.exports = { fmtMoney, fmtMoneySigned, fmtPct, fmtTime, fmtClock };
