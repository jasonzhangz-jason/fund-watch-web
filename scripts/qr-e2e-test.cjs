// QR 端到端验证：终端二维码可解码 + /__qr 页面二维码可解码且内容正确
const puppeteer = require('puppeteer');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const { toTerminal } = await import(pathToFileURL(path.join(__dirname, 'qr.mjs')).href);
  const jsqrPath = require.resolve('jsqr');

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent('<canvas id="c"></canvas>');
  await page.addScriptTag({ path: jsqrPath });

  // 1) /__qr 页面上的二维码解码
  await page.goto('http://localhost:8787/__qr', { waitUntil: 'load', timeout: 20000 });
  await page.addScriptTag({ path: jsqrPath });
  const expected = await page.$eval('.url', (el) => el.textContent.trim());
  const svg = await page.$eval('.qr', (el) => el.innerHTML);
  const decoded = await page.evaluate(async (svgStr) => {
    const cv = document.createElement('canvas');
    document.body.appendChild(cv);
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));
    await new Promise((r) => { img.onload = r; img.onerror = r; });
    const size = 600;
    cv.width = size; cv.height = size;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, size, size);
    const d = ctx.getImageData(0, 0, size, size);
    const r = window.jsQR(d.data, size, size);
    return r ? r.data : null;
  }, svg);
  console.log('页面显示的地址:', expected);
  console.log('二维码解码结果:', decoded);
  const ok1 = decoded === expected;

  // 2) 终端二维码 → 转成 HTML 再解码（验证终端输出同样可扫）
  const target = 'http://192.168.0.102:8787';
  const term = toTerminal(target, { ecc: 'M' });
  const rows = term.split('\n');
  const grid = rows.map((line) => {
    const cells = line.replace(/\x1b\[[0-9;]*m/g, '').split('');
    const out = [];
    for (const ch of cells) {
      if (ch === '▀') out.push('T'); else if (ch === ' ') out.push('X');
    }
    return cells;
  });
  // 用 ANSI 颜色信息重建像素：解析每段色码
  const html = await page.evaluate((ansi) => {
    const lines = ansi.split('\n');
    const N = 12; // 每模块像素
    let cells = [];
    let maxW = 0;
    for (const line of lines) {
      const re = /\x1b\[(\d+);(\d+)m▀/g;
      let m; const row = [];
      while ((m = re.exec(line)) !== null) row.push([Number(m[1]), Number(m[2])]);
      maxW = Math.max(maxW, row.length);
      cells.push(row);
    }
    const cv = document.createElement('canvas');
    cv.width = maxW * N; cv.height = cells.length * 2 * N;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    cells.forEach((row, ry) => {
      row.forEach(([fg, bg], rx) => {
        ctx.fillStyle = fg === 30 ? '#000' : '#fff';
        ctx.fillRect(rx * N, ry * 2 * N, N, N);
        ctx.fillStyle = bg === 40 ? '#000' : '#fff';
        ctx.fillRect(rx * N, ry * 2 * N + N, N, N);
      });
    });
    return { data: Array.from(ctx.getImageData(0, 0, cv.width, cv.height).data), w: cv.width, h: cv.height };
  }, term);
  const decodedTerm = await page.evaluate(({ data, w, h }) => {
    const r = window.jsQR(new Uint8ClampedArray(data), w, h);
    return r ? r.data : null;
  }, html);
  console.log('终端二维码解码结果:', decodedTerm);
  const ok2 = decodedTerm === target;

  console.log(ok1 && ok2 ? '\n✅ 二维码端到端验证通过（页面 + 终端均可扫）' : '\n❌ 验证失败');
  await browser.close();
  process.exit(ok1 && ok2 ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
