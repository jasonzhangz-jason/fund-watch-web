#!/usr/bin/env node
/**
 * Cloudflare 部署诊断（404 定位）
 *   node scripts/cf-doctor.mjs --worker=https://fund-watch-api.xxx.workers.dev --site=https://fund-watch.pages.dev
 *   （也可省略：探针会跳过未提供的地址）
 *
 * 依次探测「前端站点」「后端 Worker」「两段之间的路由」「跨域与 Cookie」四层，
 * 每项给出 ✅/❌ 与「下一步该做什么」，最后汇总成结论。
 * 退出码：0 全通；1 有失败项。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=').replace(/\/+$/, '') : '';
};
/** 默认地址来自 cloudflare.config.json，命令行/环境变量优先 */
let cfg = {};
try {
  cfg = JSON.parse(readFileSync(new URL('../../backend/cloudflare.config.json', import.meta.url), 'utf8'));
} catch {
  /* 没有配置就只认参数 */
}
const WORKER = arg('worker') || process.env.WORKER_URL || String(cfg.workerUrl || '').replace(/\/+$/, '');
const SITE = arg('site') || process.env.SITE_URL || String(cfg.pagesUrl || '').replace(/\/+$/, '');

if (!WORKER && !SITE) {
  console.error('用法：node scripts/cf-doctor.mjs --site=https://你的域名 [--worker=https://xxx.workers.dev]');
  console.error('  至少给一个地址；两个都给时能判断「站点 → Worker」的路由是否打通。');
  process.exit(1);
}

let fail = 0;
const results = [];const record = (layer, name, pass, detail, next) => {
  if (!pass) fail++;
  results.push({ layer, name, pass, detail, next });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass && next) console.log(`     → ${next}`);
};
/** 仅提示，不计入失败（例如本地 Node 后端没有 Cloudflare 专有字段） */
const note = (msg) => console.log(`  ℹ️  ${msg}`);

let usedCurl = false;

/**
 * 读取代理：--proxy > HTTPS_PROXY/HTTP_PROXY > Windows 系统代理（IE/WinINET）
 * 场景：本机开了本地代理客户端时，PowerShell/浏览器能通，而 Node/curl 直连会因为
 * DNS 污染（如 workers.dev 被解析到异常 IP）而超时 —— 诊断时必须复用同一条链路。
 */
function detectProxy() {
  if (args.find((a) => a === '--no-proxy')) return '';
  const fromArg = args.find((a) => a.startsWith('--proxy='));
  if (fromArg) return fromArg.split('=').slice(1).join('=');
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (env) return env;
  if (process.platform !== 'win32') return '';
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  try {
    const enabled = execFileSync('reg', ['query', key, '/v', 'ProxyEnable'], { encoding: 'utf8' });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enabled)) return '';
    const server = execFileSync('reg', ['query', key, '/v', 'ProxyServer'], { encoding: 'utf8' });
    const m = server.match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
    if (!m) return '';
    const raw = m[1].trim();
    const httpsPart = raw.split(';').map((s) => s.trim()).find((s) => /^https=/i.test(s));
    return httpsPart ? httpsPart.replace(/^https=/i, '') : raw;
  } catch {
    return '';
  }
}
const PROXY = detectProxy();

function curlProbe(url, init = {}) {
  const argv = ['-sS', '-i', '--max-time', '20', '-X', init.method || 'GET'];
  if (init.follow) argv.push('-L');
  if (PROXY) argv.push('-x', PROXY);
  for (const [k, v] of Object.entries(init.headers || {})) if (v) argv.push('-H', `${k}: ${v}`);
  if (init.body) argv.push('--data-raw', init.body);
  argv.push(url);
  try {
    const out = execFileSync('curl', argv, { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    // 走代理时 curl -i 会先输出一笔 `HTTP/1.1 200 Connection established` 的 CONNECT 响应，
    // 因此要**逐段消费** header，取最后一段作为真实响应。
    let rest = out;
    let status = null;
    let headerLines = null;
    for (;;) {
      const line = rest.match(/^HTTP\/[\d.]+\s+(\d{3})[^\r\n]*\r?\n/);
      if (!line) break;
      const sep = rest.search(/\r?\n\r?\n/);
      if (sep < 0) break;
      const sepLen = rest.startsWith('\r\n\r\n', sep) ? 4 : 2;
      status = Number(line[1]);
      headerLines = rest.slice(0, sep).split(/\r?\n/).slice(1);
      rest = rest.slice(sep + sepLen);
    }
    if (status === null) return null;
    const headers = new Headers();
    for (const raw of headerLines) {
      const i = raw.indexOf(':');
      if (i > 0) headers.append(raw.slice(0, i).trim(), raw.slice(i + 1).trim());
    }
    return { ok: true, status, headers, text: rest, via: 'curl' };
  } catch {
    return null;
  }
}

async function probe(url, init = {}, timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal, redirect: init.follow ? 'follow' : 'manual' });
    const text = await res.text();
    return { ok: true, status: res.status, headers: res.headers, text, via: 'fetch' };
  } catch (e) {
    const fallback = curlProbe(url, init);
    if (fallback) {
      if (!usedCurl) {
        usedCurl = true;
        note(`本机 Node 直连失败，已改用 curl 探测${PROXY ? `（走系统代理 ${PROXY}）` : ''}；结果同样可信`);
      }
      return fallback;
    }
    const cause = e && e.cause && (e.cause.code || e.cause.message);
    return { ok: false, status: 0, error: `${e && e.message}${cause ? ` (${cause})` : ''}` };
  } finally {
    clearTimeout(timer);
  }
}

const isJson = (r) => (r.headers.get('Content-Type') || '').includes('json');
const parseJson = (r) => {
  try {
    return JSON.parse(r.text);
  } catch {
    return null;
  }
};
/** Cloudflare / Pages 的 404 页面特征 */
const isHosting404 = (r) =>
  r.status === 404 &&
  !isJson(r) &&
  /(Page not found|The page you requested|could not be found|<title>404|<title>Pages)/i.test(r.text);

/**
 * 前端 bundle 里是否注入了后端地址（VITE_API_BASE 在构建时被内联）。
 * 这是判断「前端到底指向哪里」最直接的证据：Pages 永远不会服务 /api，
 * 所以不能只看站点自身的 /api 是否 404。
 */
async function siteBundleHas(site, needle) {
  const home = await probe(`${site}/`);
  if (!home.ok) return { found: false, scanned: [] };
  const refs = [...home.text.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((m) => m[1]);
  const uniq = [...new Set(refs)].slice(0, 6);
  const scanned = [];
  for (const ref of uniq) {
    const url = ref.startsWith('http') ? ref : site + ref;
    const js = await probe(url, {}, 45000);
    if (!js.ok) continue;
    scanned.push(`${ref}(${Math.round(js.text.length / 1024)}KB)`);
    if (js.text.includes(needle)) return { found: true, scanned, hit: ref };
  }
  return { found: false, scanned };
}

/* ============================ 1. 后端 Worker ============================ */
if (WORKER) {
  console.log('\n【1】后端 Worker');
  const h = await probe(`${WORKER}/api/health`);
  if (!h.ok) {
    record('worker', 'Worker 可访问', false, h.error, 'DNS 不通或被拦截：确认地址拼写、Worker 是否部署成功（wrangler deploy 输出）');
  } else if (h.status === 200 && isJson(h) && parseJson(h)?.ok) {
    const body = parseJson(h);
    record('worker', '/api/health 返回 200', true, `runtime=${body.runtime || '未声明'} database=${body.database || '未声明'}`);
    if (body.runtime && body.runtime !== 'cloudflare-workers') {
      record('worker', '运行时标识正确', false, String(body.runtime), '这个地址不是 Cloudflare Worker：是否指向了 Node/Vercel 后端？');
    } else if (!body.runtime) {
      note('响应里没有 runtime 字段：如果这是本地 Node 后端属正常；Worker 应返回 cloudflare-workers');
    }
    if (!body.db || typeof body.db.users !== 'number') {
      note('响应里没有 db 计数：D1 绑定是否生效需在 Worker 侧确认（users 应为数字）');
    } else {
      record('worker', 'D1 绑定可用', true, `users=${body.db.users} admins=${body.db.admins}`);
    }
  } else if (h.status === 404 && isJson(h)) {
    record(
      'worker',
      '/api/health 返回 200',
      false,
      `404 JSON：${parseJson(h)?.error || h.text.slice(0, 80)}`,
      'Worker 已部署但路径不对：访问的应是 <worker>/api/health（根路径 404 是预期行为）',
    );
  } else if (isHosting404(h)) {
    record(
      'worker',
      '/api/health 返回 200',
      false,
      '返回的是 404 网页而不是 JSON',
      '该地址没有指向 Worker（可能命中了 Pages 或仍是被删的旧 Worker）。用 wrangler deploy 输出的地址最可靠',
    );
  } else {
    record('worker', '/api/health 返回 200', false, `HTTP ${h.status}：${h.text.slice(0, 120)}`, '看 wrangler tail 的实时日志定位异常');
  }

  // CORS 预检（同源部署不需要跨域，只提示不判失败）
  const origin = SITE || 'https://example.com';
  const sameOrigin = SITE && WORKER && new URL(SITE).origin === new URL(WORKER).origin;
  const pre = await probe(`${WORKER}/api/auth/login`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
  });
  const corsOk = pre.ok && pre.status === 204 && Boolean(pre.headers.get('Access-Control-Allow-Origin'));
  if (sameOrigin) {
    note(`当前是**同源**部署（${origin}），不依赖 CORS：预检 ${pre.status} 属正常`);
  } else if (corsOk) {
    record('worker', 'CORS 预检通过', true, `ACAO=${pre.headers.get('Access-Control-Allow-Origin')}`);
  } else {
    record(
      'worker',
      'CORS 预检通过',
      false,
      `HTTP ${pre.ok ? pre.status : pre.error}`,
      '分域部署需要跨域：请在 Worker 设 CORS_ORIGINS=<站点域名>，并确认前端用 VITE_API_BASE 指向 Worker',
    );
  }
}

/* ============================ 2. 前端站点 ============================ */
if (SITE) {
  console.log('\n【2】前端站点（Pages）');
  const home = await probe(`${SITE}/`);
  const homeHtml = home.ok && (home.headers.get('Content-Type') || '').includes('html');
  if (!home.ok) {
    record('site', '站点首页可访问', false, home.error, '域名未绑定或 DNS 未生效：Pages → Custom domains 检查状态是否为 Active');
  } else if (home.status === 200 && homeHtml && !isHosting404(home)) {
    record('site', '站点首页返回页面', true, `HTTP 200，${home.text.length} 字节`);
    if (!/id=["']?root/i.test(home.text)) {
      note('首页没找到 <div id="root">：如果这不是 Vite 应用页面（例如本地 dev-server 的 v1 归档页），可忽略');
    }
  } else if (isHosting404(home)) {
    record(
      'site',
      '站点首页返回应用页面',
      false,
      '返回 Cloudflare 404 页面',
      '典型原因：只产生了「预览部署」，生产环境没内容。重跑 wrangler pages deploy dist --project-name <项目> --branch main（或用 Dashboard 看 Deployments 里 Production 是否为空）',
    );
  } else {
    record('site', '站点首页返回应用页面', false, `HTTP ${home.status}`, '检查 Pages 部署日志与构建输出目录是否为 dist');
  }

  // Pages 会把 /admin.html 308 重定向到 /admin（pretty URL），所以要跟随跳转
  const admin = await probe(`${SITE}/admin.html`, { follow: true });
  const adminLooksRight = admin.ok && admin.status === 200 && /<div id=["']?(admin-)?root/i.test(admin.text);
  record(
    'site',
    '后台页 /admin.html 可访问',
    adminLooksRight,
    admin.ok ? `HTTP ${admin.status}${admin.text ? `，${admin.text.length} 字节` : ''}` : admin.error,
    '构建产物缺少 admin.html：确认 vite.config.mts 的双入口配置后重新 pnpm build',
  );

  /* ---- 3. 站点 → Worker 的路由 ---- */
  console.log('\n【3】站点 → Worker 的 /api 路由');
  const viaSite = await probe(`${SITE}/api/health`);
  const siteJson = viaSite.ok && isJson(viaSite) ? parseJson(viaSite) : null;
  const viaSiteHtml = viaSite.ok && (viaSite.headers.get('Content-Type') || '').includes('html');

  // 先看前端 bundle 是否已内联后端地址：Pages 永远不服务 /api，
  // 所以「站点 /api 返回 HTML」并不必然代表前端没配好。
  let bundleHasBase = null;
  if (WORKER) {
    const host = new URL(WORKER).host;
    bundleHasBase = await siteBundleHas(SITE, host);
    if (bundleHasBase.found) {
      record('route', '前端 bundle 已注入后端地址', true, `命中 ${bundleHasBase.hit}（含 ${host}）`);
    } else {
      record(
        'route',
        '前端 bundle 已注入后端地址',
        false,
        `扫了 ${bundleHasBase.scanned.length} 个 JS，均未含 ${host}`,
        `构建时漏了环境变量：$env:VITE_API_BASE="${WORKER}"; pnpm build; 然后重新 wrangler pages deploy dist --project-name <项目> --branch main`,
      );
    }
  }

  if (siteJson && siteJson.ok === true) {
    record('route', '站点 /api/health 命中 API', true, `runtime=${siteJson.runtime || '未声明'}`);
  } else if (bundleHasBase && bundleHasBase.found) {
    note('站点自身的 /api 路径返回 HTML 属正常（Pages 不提供 API）；前端已直连 Worker');
  } else if (bundleHasBase && !bundleHasBase.found) {
    note('站点 /api 返回 HTML 属正常（Pages 不提供 API）；真正的问题在上一项：bundle 未注入后端地址');
  } else if (viaSiteHtml) {
    // 关键症状：Pages 用 index.html 兜底了 API 路径 → 前端会拿到 HTML，JSON 解析失败
    record(
      'route',
      '站点 /api/health 命中 API',
      false,
      `HTTP ${viaSite.status} 但返回的是 HTML（Pages 兜底了 /api 路径，没有转到 Worker）`,
      '前端必须在构建时指向 Worker：设置环境变量 VITE_API_BASE=<worker 地址> 后重新 pnpm build + 部署；或给自定义域加 Worker Route <域名>/api/*',
    );
  } else if (viaSite.ok && isHosting404(viaSite)) {
    record(
      'route',
      '站点 /api/health 命中 Worker',
      false,
      '404（命中 Pages，没有转到 Worker）',
      '两种修法：① Worker → Settings → Triggers → Add route: <你的域名>/api/*（推荐，需自定义域）；② 给 Pages 构建加 VITE_API_BASE=<worker 地址> 后重新部署',
    );
  } else if (viaSite.ok && viaSite.status === 404) {
    record('route', '站点 /api/health 命中 Worker', false, `HTTP 404：${viaSite.text.slice(0, 100)}`, '同上：未配置 /api/* 路由');
  } else {
    record('route', '站点 /api/health 命中 Worker', false, `HTTP ${viaSite.ok ? viaSite.status : viaSite.error}`, '看 Worker 的 Real-time Logs');
  }

  /* ---- 4. 跨域 Cookie（分域部署时的关键陷阱）---- */
  console.log('\n【4】登录 Cookie 属性');
  const target = WORKER || SITE;
  const login = await probe(`${target}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: SITE || undefined },
    body: JSON.stringify({ username: '__doctor__', password: 'x'.repeat(8) }),
  });
  const setCookie = (login.ok && login.headers ? login.headers.get('Set-Cookie') : '') || '';
  if (login.ok && setCookie) {
    record('cookie', '登录接口下发会话 Cookie', true, setCookie.split(';').slice(0, 4).join('; '));
    const hostOnly = WORKER && !WORKER.startsWith(SITE);
    if (hostOnly && /SameSite=Lax/i.test(setCookie) && !/SameSite=None/i.test(setCookie)) {
      record(
        'cookie',
        '分域部署的 SameSite 设置',
        false,
        '跨站请求下 SameSite=Lax 的 Cookie 会被浏览器丢弃 → 登录「成功」但刷新即掉登录态',
        '把两个域名放同一主域（如 fund.example.com + api.example.com）并设 COOKIE_SAMESITE=None；或改用同域路由',
      );
    }
  } else if (login.ok && login.status === 401 && !setCookie) {
    record('cookie', '登录接口下发会话 Cookie', true, '401（口令错误属预期，说明接口已通）');
  } else {
    record('cookie', '登录接口下发会话 Cookie', false, `HTTP ${login.ok ? login.status : login.error}`, '接口不通时先解决第 3 项的 /api 路由');
  }
}

/* ============================ 结论 ============================ */
console.log('\n================ 结论 ================');
const failed = results.filter((r) => !r.pass);
if (!failed.length) {
  console.log('✅ 各层都通：打开站点 → 注册/登录 → 加持仓应能看到真实行情。');
} else {
  console.log(`❌ 共 ${failed.length} 项失败，按此顺序处理：\n`);
  failed.forEach((r, i) => console.log(`  ${i + 1}. [${r.layer}] ${r.name}\n     ${r.next || ''}`));
}
process.exitCode = fail === 0 ? 0 : 1;
