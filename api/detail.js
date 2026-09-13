/**
 * 基金详情代理（服务端拉取 pingzhongdata 并解析，规避手机/浏览器直连该域名被拦的问题）
 * GET /api/detail?code=161725
 * 返回：基本信息、费率、阶段收益、净值走势（最近240期）
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

function pick(js, key) {
  // 匹配 var key = "value";  或 var key = 123;
  const m = js.match(new RegExp(`var\\s+${key}\\s*=\\s*"([^"]*)"`));
  if (m) return m[1];
  const n = js.match(new RegExp(`var\\s+${key}\\s*=\\s*([^;]+);`));
  return n ? n[1].trim() : undefined;
}

function pickArray(js, key) {
  const m = js.match(new RegExp(`var\\s+${key}\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;`));
  if (!m) return [];
  try { return JSON.parse(m[1]); } catch { return []; }
}

function parseTrend(raw) {
  return (raw || []).slice(-240).map((p) => ({
    date: new Date(p.x).toISOString().slice(0, 10),
    nav: p.y,
    equityReturn: p.equityReturn,
  }));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  try {
    const code = (req.query.code || '').toString().trim();
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: '基金代码须为6位数字' });

    const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js?rt=${Date.now()}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: `https://fund.eastmoney.com/${code}.html` },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error(`upstream http ${r.status}`);
    const js = await r.text();

    const name = pick(js, 'fS_name') || code;
    const trendRaw = pickArray(js, 'Data_netWorthTrend');
    if (!trendRaw.length) {
      return res.json({ ok: true, code, name, found: false, trend: [] });
    }

    const num = (v) => (v === undefined || v === '' ? null : Number(v));
    res.json({
      ok: true,
      code,
      name,
      found: true,
      rate: pick(js, 'fund_Rate'),
      sourceRate: pick(js, 'fund_sourceRate'),
      minsg: pick(js, 'fund_minsg'),
      metrics: {
        m1: num(pick(js, 'syl_1y')),   // 近1月
        m6: num(pick(js, 'syl_6y')),   // 近6月
        y1: num(pick(js, 'syl_1n')),   // 近1年
        y3: num(pick(js, 'syl_3y')),   // 近3年
      },
      latestNav: trendRaw[trendRaw.length - 1].y,
      latestDate: new Date(trendRaw[trendRaw.length - 1].x).toISOString().slice(0, 10),
      trend: parseTrend(trendRaw),
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
};
