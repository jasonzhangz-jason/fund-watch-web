/**
 * 基金重仓股（真实数据）
 * GET /api/holdings?code=006274
 *
 * 上游：
 *   1) fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc  基金持仓明细（HTML 表格）
 *      —— 涨跌幅列在 HTML 中为空（由前端 JS 填充），故另取行情
 *   2) push2.eastmoney.com/api/qt/ulist.np/get                批量股票行情（f3 = 涨跌幅）
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const JJCC_URL = 'https://fundf10.eastmoney.com/FundArchivesDatas.aspx';
const QUOTE_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get';

/** 交易所前缀：沪市 1，深市 0 */
const marketOf = (code) => (/^(6|5|9)/.test(code) ? '1' : '0');
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
const numOf = (s) => {
  const v = parseFloat(String(s || '').replace(/[,%\s]/g, ''));
  return Number.isFinite(v) ? v : null;
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');
  try {
    const code = (req.query.code || '').toString().trim();
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: '基金代码须为6位数字' });

    const r = await fetch(`${JJCC_URL}?type=jjcc&code=${code}&topline=10`, {
      headers: { 'User-Agent': UA, Referer: `https://fundf10.eastmoney.com/ccmx_${code}.html` },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error(`upstream http ${r.status}`);
    const html = await r.text();

    const date = (html.match(/截止至：<font[^>]*>([\d-]+)<\/font>/) || [])[1] || null;
    const quarter = (html.match(/(\d{4}年\d季度)股票投资明细/) || [])[1] || null;

    const tbody = (html.match(/<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || '';
    const rows = [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) =>
      [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => text(c[1])),
    );

    const items = rows
      .map((cells) => ({
        code: cells[1] || '',
        name: cells[2] || '',
        weight: numOf(cells[6]), // 占净值比例
        shares: numOf(cells[7]), // 持股数（万股）
        marketValue: numOf(cells[8]), // 持仓市值（万元）
        change: null,
      }))
      .filter((i) => /^\d{6}$/.test(i.code) && i.name);

    // 批量补涨跌幅（真实行情）
    if (items.length) {
      try {
        const secids = items.map((i) => `${marketOf(i.code)}.${i.code}`).join(',');
        const qr = await fetch(`${QUOTE_URL}?secids=${secids}&fields=f3,f12&fltt=2&invt=2`, {
          headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
          signal: AbortSignal.timeout(8000),
        });
        const qj = await qr.json();
        const map = new Map((qj?.data?.diff || []).map((d) => [d.f12, d.f3]));
        for (const i of items) {
          const v = map.get(i.code);
          i.change = typeof v === 'number' ? v : null;
        }
      } catch {
        /* 行情失败不影响持仓明细 */
      }
    }

    res.json({ ok: true, code, date, quarter, items });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
};
