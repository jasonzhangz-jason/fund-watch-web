// 本地开发调试服务器：静态文件 + /api/* 代理（模拟 vercel dev，无需安装 vercel CLI）
// 用法：
//   node scripts/dev-server.mjs              # 启动 http://localhost:8787
//   node --watch scripts/dev-server.mjs      # 文件变更自动重启（api/*.js 热重载）
//   node scripts/dev-server.mjs --open       # 启动后自动打开浏览器
//   PORT=9000 node scripts/dev-server.mjs    # 自定义端口
import http from 'http';
import { createRequire } from 'module';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 8787;
const OPEN = process.argv.includes('--open');

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
  console.log('');
  console.log('┌──────────────────────────────────────────────────────┐');
  console.log(`│  📈 FundWatch 本地调试服务器                          │`);
  console.log(`│  本机   http://localhost:${PORT}                        │`);
  for (const u of lan) console.log(`│  局域网 ${u}${' '.repeat(Math.max(1, 13 - u.length))}│`);
  console.log(`│  静态   index.html（禁缓存，改完刷新即可）             │`);
  console.log(`│  API    /api/search /api/nav /api/estimate            │`);
  console.log(`│  健康   /api/health                                    │`);
  console.log('│  调试   浏览器 F12 → Console/Network 看请求与报错      │');
  console.log('└──────────────────────────────────────────────────────┘');
  console.log('');
  if (lan.length) console.log(`📱 手机访问：确保手机与电脑在同一 Wi-Fi，用上面「局域网」地址打开`);
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
