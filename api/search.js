/**
 * 基金搜索代理（天天基金 fundsuggest API）
 * GET /api/search?key=中证A500&type=fund
 * 上游无 CORS 头，必须走服务端代理。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const SEARCH_URL = 'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx';

async function upstream(key) {
  const url = `${SEARCH_URL}?m=1&key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://fund.eastmoney.com/', Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`upstream http ${r.status}`);
  return r.json();
}

function mapDatas(datas) {
  return (datas || []).map((d) => ({
    code: d.CODE,
    name: d.NAME,
    shortName: d.SHORTNAME || d.NAME,
    pinyin: d.JP || '',
    category: d.CATEGORYDESC || '',
    categoryId: d.CATEGORY,
    fundType: d.FundBaseInfo?.FTYPE || '',
    marketFlag: d.MARKET || '',
  }));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');
  try {
    const key = (req.query.key || '').toString().trim();
    if (!key) return res.status(400).json({ ok: false, error: '缺少 key 参数' });
    const data = await upstream(key);
    if (data.ErrCode !== 0) {
      return res.status(502).json({ ok: false, error: `上游错误: ${data.ErrMsg || data.ErrCode}` });
    }
    res.json({ ok: true, total: (data.Datas || []).length, items: mapDatas(data.Datas) });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
};
