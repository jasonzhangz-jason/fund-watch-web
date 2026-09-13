// 本地开发调试服务器：静态文件 + /api/* 代理（模拟 vercel dev，无需安装 vercel CLI）
// 用法：
//   node scripts/dev-server.mjs              # 启动 http://localhost:8787（终端打印手机扫码二维码）
//   node --watch scripts/dev-server.mjs      # 文件变更自动重启（api/*.js 热重载）
//   node scripts/dev-server.mjs --open       # 启动后自动打开浏览器
//   node scripts/dev-server.mjs --no-qr      # 不打印终端二维码
//   PORT=9000 node scripts/dev-server.mjs    # 自定义端口
import http from 'http';
import { createRequire } from 'module';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { toTerminal, toSVG } from './qr.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 8787;
const OPEN = process.argv.includes('--open');
const NO_QR = process.argv.includes('--no-qr');

const handlers = {
  search: require('../api/search.js'),
  nav: require('../api/nav.js'),
  estimate: require('../api/estimate.js'),
  detail: require('../api/detail.js'),
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
};

function parseQuery(u) {
  const o = {};
  const i = u.indexOf('?');
  if (i < 0) return o;
  for (const p of u.slice(i + 1).split('&')) {
    const [k, v] = p.split('=');
    if (k) o[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return o;
}

function log(method, url, status, ms) {
  const t = new Date().toISOString().slice(11, 19);
  const icon = status < 400 ? '✅' : '❌';
  console.log(`${icon} [${t}] ${method} ${url} -> ${status} (${ms}ms)`);
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const url = req.url.split('?')[0];

  // ---- /__qr ：放大版二维码页面（电脑屏幕上显示，手机直接扫） ----
  if (url === '/__qr' || url === '/qr') {
    const q = parseQuery(req.url);
    const lan = lanURLs(PORT);
    const target = q.url || lan[0] || `http://localhost:${PORT}`;
    try {
      const svg = toSVG(target, { ecc: 'M' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>扫码访问 FundWatch</title>
<style>
  body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
       background:#0f172a;color:#e2e8f0;font-family:"Microsoft YaHei","PingFang SC",sans-serif;gap:18px;padding:24px}
  h1{font-size:20px;margin:0;font-weight:700}
  .qr{background:#fff;padding:16px;border-radius:16px;width:min(70vw,420px);box-shadow:0 10px 40px rgba(0,0,0,.4)}
  .qr svg{display:block;width:100%;height:auto}
  .url{font-size:16px;color:#38bdf8;word-break:break-all;text-align:center}
  .tip{font-size:13px;color:#94a3b8;text-align:center;line-height:1.7}
</style></head><body>
<h1>📱 用手机相机扫码打开</h1>
<div class="qr">${svg}</div>
<div class="url">${target}</div>
<div class="tip">手机需与本机在同一 Wi-Fi；若打不开请检查 Windows 防火墙是否放行 Node.js<br>
<span style="opacity:.7">页面地址：/__qr?url=http://自定义地址</span></div>
</body></html>`);
      log(req.method, req.url, 200, Date.now() - t0);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('二维码生成失败: ' + e.message);
      log(req.method, req.url, 500, Date.now() - t0);
    }
    return;
  }

  // ---- /api/* 代理 ----
  const m = url.match(/^\/api\/(\w+)$/);
  if (m) {
    if (m[1] === 'health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'fund-watch-web', time: new Date().toISOString() }));
      log(req.method, req.url, 200, Date.now() - t0);
      return;
    }
    const h = handlers[m[1]];
    if (!h) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `unknown api: ${m[1]}` }));
      log(req.method, req.url, 404, Date.now() - t0);
      return;
    }
    try {
      const r = { _s: 200, _j: null, status(c) { this._s = c; return this; }, json(j) { this._j = j; }, setHeader() {} };
      await h({ query: parseQuery(req.url) }, r);
      res.writeHead(r._s, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(r._j));
      log(req.method, req.url, r._s, Date.now() - t0);
    } catch (e) {
      console.error(`💥 api ${m[1]} threw:`, e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
      log(req.method, req.url, 500, Date.now() - t0);
    }
    return;
  }

  // ---- 静态文件 ----
  const file = path.join(ROOT, url === '/' ? 'index.html' : url);
  try {
    const data = await readFile(file);
    // 开发环境禁用缓存，方便调试
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
    log(req.method, req.url, 200, Date.now() - t0);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
    log(req.method, req.url, 404, Date.now() - t0);
  }
});

function lanURLs(port) {
  const os = require('os');
  const nets = os.networkInterfaces();
  const urls = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) urls.push(`http://${net.address}:${port}`);
    }
  }
  return urls;
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n❌ 端口 ${PORT} 已被占用。可能是已有 FundWatch 服务器在运行，或换个端口：\n   PORT=9000 node scripts/dev-server.mjs\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  const lan = lanURLs(PORT);
  const mobileURL = lan[0] || `http://localhost:${PORT}`;
  console.log('');
  console.log('┌──────────────────────────────────────────────────────────┐');
  console.log(`│  📈 FundWatch 本地调试服务器                              │`);
  console.log(`│  本机   http://localhost:${PORT}                            │`);
  for (const u of lan) console.log(`│  局域网 ${u}${' '.repeat(Math.max(1, 17 - u.length))}│`);
  console.log(`│  静态   index.html（禁缓存，改完刷新即可）                 │`);
  console.log(`│  API    /api/search /api/nav /api/estimate /api/detail    │`);
  console.log(`│  健康   /api/health                                        │`);
  console.log('│  调试   浏览器 F12 → Console/Network 看请求与报错          │');
  console.log('└──────────────────────────────────────────────────────────┘');
  console.log('');

  // 📱 手机扫码入口：终端二维码 + /__qr 网页大图
  if (!NO_QR) {
    if (lan.length) {
      console.log('📱 手机扫码打开（确保手机与电脑在同一 Wi-Fi）：');
      console.log('');
      try {
        console.log(toTerminal(mobileURL, { ecc: 'M' }));
      } catch (e) {
        console.log('  (二维码生成失败:', e.message, ')');
      }
      console.log('');
    } else {
      console.log('⚠️  未检测到局域网 IPv4 地址，手机可能无法访问（检查网络连接）');
    }
    console.log(`   手机地址：${mobileURL}`);
    console.log(`   电脑上打开 http://localhost:${PORT}/__qr 可看到放大版二维码`);
    console.log('');
  }
  if (OPEN) openBrowser(`http://localhost:${PORT}`);
});

function openBrowser(target) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
  const { spawn } = require('child_process');
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.unref();
  console.log(`🌐 已尝试打开浏览器: ${target}`);
}
