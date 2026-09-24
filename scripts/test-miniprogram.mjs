/**
 * 微信小程序工程结构与语义校验
 *   node scripts/test-miniprogram.mjs
 *
 * 本机无法运行微信开发者工具，因此用可执行的静态校验覆盖「最容易出错、且一定能查出来」的点：
 *   1) app.json 合法；每个注册页面都有 js/json/wxml/wxss 四件套
 *   2) 所有 usingComponents 引用的组件都存在（且组件 json 声明 component: true）
 *   3) 全部 .js 通过语法解析（Page/Component/App 只解析不执行）
 *   4) **接口契约对齐**：utils/api.js 里用到的每个 /api 路径都能在真实后端路由中找到
 *   5) WXML 标签闭合平衡（含自定义组件与 block）
 *   6) 设计令牌与 Web 端 src/index.css 一致
 *   7) 不使用小程序不存在的 Web API（fetch / localStorage / document / window.*）
 *   8) tabBar 页面必须在 pages 中注册
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
};
const read = (p) => readFileSync(p, 'utf8');

/** 递归列出文件（相对 MP 的 posix 路径） */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(path.relative(MP, p).split(path.sep).join('/'));
  }
  return out;
}

const files = walk(MP);
const json = (rel) => JSON.parse(read(path.join(MP, rel)));

/* ---------- 1. app.json 与页面四件套 ---------- */
console.log('\n【1】app.json 与页面文件完整性');
let app = null;
try {
  app = json('app.json');
  check('app.json 可解析', true);
} catch (e) {
  check('app.json 可解析', false, e.message);
}
check('注册了页面', Array.isArray(app.pages) && app.pages.length >= 8, `${app.pages?.length} 个`);
check('配置了 tabBar 且 3 个 tab', app.tabBar?.list?.length === 3, JSON.stringify(app.tabBar?.list?.map((t) => t.text)));

let pageOk = 0;
const pageProblems = [];
for (const p of app.pages) {
  const missing = ['js', 'json', 'wxml', 'wxss'].filter((ext) => !existsSync(path.join(MP, `${p}.${ext}`)));
  if (missing.length) pageProblems.push(`${p} 缺少 ${missing.join('/')}`);
  else pageOk++;
}
check(`全部页面四件套齐全（${pageOk}/${app.pages.length}）`, pageProblems.length === 0, pageProblems.join('; '));

/* ---------- 8. tabBar 页面必须已注册 ---------- */
console.log('\n【2】tabBar 与页面注册一致性');
const tabProblems = (app.tabBar?.list || []).filter((t) => !app.pages.includes(t.pagePath));
check('tabBar 的页面都在 pages 中注册', tabProblems.length === 0, JSON.stringify(tabProblems));
check('tabBar 页面与 Web 端三个 Tab 对应', (app.tabBar?.list || []).map((t) => t.text).join('/') === '账本/自选/我的');

/* ---------- 2. 组件引用 ---------- */
console.log('\n【3】组件引用与声明');
const jsonFiles = files.filter((f) => f.endsWith('.json') && f !== 'app.json' && f !== 'sitemap.json' && f !== 'project.config.json');
const badRefs = [];
let compRefs = 0;
for (const f of jsonFiles) {
  let cfg = null;
  try {
    cfg = json(f);
  } catch (e) {
    badRefs.push(`${f} 不是合法 JSON`);
    continue;
  }
  const using = cfg.usingComponents || {};
  for (const [tag, target] of Object.entries(using)) {
    compRefs++;
    const rel = String(target).replace(/^\//, '');
    const missing = ['js', 'json', 'wxml', 'wxss'].filter((ext) => !existsSync(path.join(MP, `${rel}.${ext}`)));
    if (missing.length) badRefs.push(`${f} → ${tag}(${target}) 缺少 ${missing.join('/')}`);
    else {
      const cj = json(`${rel}.json`);
      if (cj.component !== true) badRefs.push(`${rel}.json 未声明 component: true`);
    }
  }
}
check(`组件引用全部可解析（共 ${compRefs} 处）`, badRefs.length === 0, badRefs.join('; '));

/* ---------- 3. JS 语法 ---------- */
console.log('\n【4】JavaScript 语法');
const jsFiles = files.filter((f) => f.endsWith('.js'));
const syntaxBad = [];
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', path.join(MP, f)], { stdio: 'pipe' });
  } catch (e) {
    syntaxBad.push(`${f}: ${String(e.stderr || e.message).split('\n').slice(0, 2).join(' ')}`);
  }
}
check(`${jsFiles.length} 个 JS 文件语法通过`, syntaxBad.length === 0, syntaxBad.slice(0, 3).join(' | '));

/* ---------- 4. 接口契约对齐 ---------- */
console.log('\n【5】接口契约对齐（小程序 ↔ 真实后端路由）');
const apiDir = path.join(ROOT, 'api');
const apiWalk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) apiWalk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
};
const routes = apiWalk(apiDir).map((p) => {
  const rel = path.relative(apiDir, p).split(path.sep).join('/').replace(/\.js$/, '');
  return `/api/${rel.replace(/\/index$/, '')}`;
});
check(`解析到后端路由 ${routes.length} 条`, routes.length >= 15, routes.join(', '));

function routeMatches(mpPath, route) {
  const a = mpPath.split('/').filter(Boolean);
  const b = route.split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  return b.every((seg, i) => (seg.startsWith('[') ? true : seg === a[i]));
}
/** 允许「前缀 + 动态段」的写法（例如 '/api/watchlist/' + code） */
function apiPathExists(mpPath) {
  if (routes.some((r) => routeMatches(mpPath, r))) return true;
  const a = mpPath.split('/').filter(Boolean);
  return routes.some((r) => {
    const b = r.split('/').filter(Boolean);
    if (b.length !== a.length + 1) return false;
    const head = b.slice(0, a.length);
    const tail = b[b.length - 1];
    return tail.startsWith('[') && head.every((seg, i) => seg === a[i]);
  });
}

const apiSrc = read(path.join(MP, 'utils/api.js'));
const used = [...apiSrc.matchAll(/'(\/api\/[A-Za-z0-9/_-]*)/g)].map((m) => m[1].replace(/\/$/, ''));
const unique = [...new Set(used)];
const notFound = unique.filter((p) => !apiPathExists(p));
check(`小程序用到的 ${unique.length} 个接口都存在于后端`, notFound.length === 0, `缺失：${notFound.join(', ')}`);
check('覆盖账号/行情/账本/穿透/相关性接口', ['/api/auth/me', '/api/portfolio', '/api/portfolio/lookthrough', '/api/portfolio/correlation', '/api/quotes', '/api/search'].every((p) => unique.includes(p)), unique.join(', '));

// 页面里直接写死 /api 的地方也必须对得上（防止绕过 utils/api.js）
const pageApiLiterals = [];
for (const f of files.filter((x) => x.startsWith('pages/') && x.endsWith('.js'))) {
  for (const m of read(path.join(MP, f)).matchAll(/'(\/api\/[A-Za-z0-9/_-]*)/g)) {
    pageApiLiterals.push({ file: f, path: m[1].replace(/\/$/, '') });
  }
}
const pageApiBad = pageApiLiterals.filter((x) => !apiPathExists(x.path));
check('页面内未出现未对齐的 /api 路径', pageApiBad.length === 0, JSON.stringify(pageApiBad));

/* ---------- 5. WXML 标签闭合 ---------- */
console.log('\n【6】WXML 标签闭合');
const wxmlFiles = files.filter((f) => f.endsWith('.wxml'));
const VOID = new Set(['image', 'input', 'icon', 'progress', 'swiper-item', 'slot', 'canvas', 'camera', 'live-player']);
const wxmlBad = [];
for (const f of wxmlFiles) {
  const src = read(path.join(MP, f)).replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let m;
  let err = '';
  while ((m = re.exec(src))) {
    const closing = m[1] === '/';
    const tag = m[2];
    const selfClose = m[4] === '/';
    if (selfClose || VOID.has(tag)) continue;
    if (closing) {
      const top = stack.pop();
      if (top !== tag) {
        err = `</${tag}> 与 <${top || '空'}> 不匹配`;
        break;
      }
    } else {
      stack.push(tag);
    }
  }
  if (!err && stack.length) err = `未闭合：${stack.join(', ')}`;
  if (err) wxmlBad.push(`${f}: ${err}`);
}
check(`${wxmlFiles.length} 个 WXML 标签闭合正确`, wxmlBad.length === 0, wxmlBad.slice(0, 3).join(' | '));

/* ---------- 6. 设计令牌一致 ---------- */
console.log('\n【7】设计令牌与 Web 端一致');
const webCss = read(path.join(ROOT, 'src/index.css'));
const mpCss = read(path.join(MP, 'app.wxss'));
const tokens = ['#1977ff', '#9dc4fd', '#e8f1ff', '#e8303c', '#1c9574', '#f5f6fa', '#f9f9f9', '#1f1f1f', '#8a8f99', '#b0b6c0', '#f0f1f5'];
const tokenBad = tokens.filter((t) => !webCss.toLowerCase().includes(t) || !mpCss.toLowerCase().includes(t));
check(`主色/涨跌色/中性色共 ${tokens.length} 个令牌两端一致`, tokenBad.length === 0, tokenBad.join(', '));
check('涨跌语义色未写反（涨红跌绿）', /--up:\s*#e8303c/i.test(mpCss) && /--down:\s*#1c9574/i.test(mpCss));

/* ---------- 7. 禁用 Web-only API ---------- */
console.log('\n【8】未使用小程序不存在的 Web API');
const webOnly = [
  { re: /(^|[^.\w])fetch\s*\(/, name: 'fetch(' },
  { re: /localStorage/, name: 'localStorage' },
  { re: /document\./, name: 'document.' },
  { re: /(^|[^.\w])window\./, name: 'window.' },
  { re: /XMLHttpRequest/, name: 'XMLHttpRequest' },
];
const webOnlyBad = [];
for (const f of jsFiles) {
  const src = read(path.join(MP, f));
  for (const rule of webOnly) {
    if (rule.re.test(src)) webOnlyBad.push(`${f} 使用了 ${rule.name}`);
  }
}
check('页面/工具代码只用小程序 API', webOnlyBad.length === 0, webOnlyBad.slice(0, 4).join(' | '));

/* ---------- 附加：会话与配置的关键实现 ---------- */
console.log('\n【9】APK/小程序共有的关键实现');
const apiSrcFull = read(path.join(MP, 'utils/api.js'));
check('wx.request 封装存在', /wx\.request\(/.test(apiSrcFull));
check('手动维护会话 Cookie（小程序不会自动带 Cookie）', /Set-Cookie/i.test(apiSrcFull) && /Cookie/.test(apiSrcFull));
check('未配置地址时给出明确错误', /未配置服务器地址/.test(apiSrcFull));
const appJs = read(path.join(MP, 'app.js'));
check('启动时读取登录态', /refreshUser/.test(appJs));
check('未配置地址时引导去「我的」页', /requireBaseUrl/.test(appJs) && /pages\/mine\/mine/.test(appJs));
const mineJs = read(path.join(MP, 'pages/mine/mine.js'));
check('「我的」页可配置服务器地址 + 测试连接', /saveBase/.test(mineJs) && /testBase/.test(mineJs));
check('「我的」页含持仓穿透与相关性入口', /goLookthrough/.test(mineJs) && /goCorrelation/.test(mineJs));

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
