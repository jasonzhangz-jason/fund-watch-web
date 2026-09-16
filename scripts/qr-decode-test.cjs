// QR 可扫描性验证：用真实解码器 jsQR 解码（浏览器内，需要 puppeteer + jsqr）
const puppeteer = require('puppeteer');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const { qrMatrix, toSVG } = await import(pathToFileURL(path.join(__dirname, 'qr.mjs')).href);
  const jsqrPath = require.resolve('jsqr');

  const cases = [
    'http://192.168.0.102:8787',
    'http://localhost:8787',
    'http://192.168.100.200:9000/__qr?from=phone&v=2',
    'A',
    'https://fund-watch-web.vercel.app',
  ];

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent('<canvas id="c"></canvas>');
  await page.addScriptTag({ path: jsqrPath });

  let pass = 0, fail = 0;
  for (const text of cases) {
    for (const ecc of ['L', 'M', 'Q', 'H']) {
      const svg = toSVG(text, { ecc });
      const decoded = await page.evaluate(async (svgStr) => {
        const img = new Image();
        img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));
        await new Promise((r) => { img.onload = r; img.onerror = r; });
        const scale = 8;
        const cv = document.getElementById('c');
        cv.width = img.width * scale; cv.height = img.height * scale;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        const data = ctx.getImageData(0, 0, cv.width, cv.height);
        const res = window.jsQR(data.data, cv.width, cv.height);
        return res ? res.data : null;
      }, svg);
      if (decoded === text) { pass++; }
      else { fail++; console.log(`❌ 解码失败 ecc=${ecc} 期望="${text}" 得到=${decoded === null ? 'null' : `"${decoded}"`}`); }
    }
  }
  console.log(`\n解码验证：成功 ${pass} / 失败 ${fail}`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
