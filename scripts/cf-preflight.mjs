#!/usr/bin/env node
/**
 * Cloudflare 部署前自检（配置驱动）
 *   pnpm cf:check            # 本地一致性检查（快，离线可用）
 *   pnpm cf:check --online   # 额外确认登录态、secret 列表、D1 远端表
 *
 * 依据 cloudflare.config.json 里的真实值做「配置 ↔ 文件 ↔ 产物 ↔ 云端」一致性校验，
 * 而不是给通用命令。重点拦截本项目实际踩过的坑：
 *   1. database_id 忘替换 → 部署到占位库
 *   2. 跨站部署却用 Lax Cookie → 登录后刷新就掉
 *   3. 构建时漏 VITE_API_BASE → 前端 /api 打到 Pages（405/HTML）
 *   4. 把「分支预览别名」当成生产域名（xxx.fund-watch-3o5.pages.dev）
 *   5. 没有 ADMIN_PASSWORD secret → 内置管理员是 root/root
 * 退出码：0 无阻塞；1 有阻塞项。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG_PATH = path.join(ROOT, 'cloudflare.config.json');
const TOML_PATH = path.join(ROOT, 'workers', 'wrangler.toml');
const MIG_DIR = path.join(ROOT, 'workers', 'migrations');
const DIST = path.join(ROOT, 'dist');
const PLACEHOLDER = '00000000-0000-0000-0000-000000000000';
const ONLINE = process.argv.includes('--online');

let blocking = 0;
let warn = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => {
  blocking++;
  console.log(`  ❌ ${m}`);
};
const wa = (m) => {
  warn++;
  console.log(`  ⚠️  ${m}`);
};
const info = (m) => console.log(`  ℹ️  ${m}`);

/* ---------- 0. 配置 ---------- */
console.log('\n【1】部署配置（cloudflare.config.json）');
let cfg = null;
try {
  cfg = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
  ok('配置已加载');
} catch (e) {
  bad(`无法读取 cloudflare.config.json：${e.message}`);
}
if (cfg) {
  const need = ['workerName', 'workerUrl', 'pagesProject', 'pagesUrl', 'productionBranch', 'd1Database', 'apiBaseMode'];
  const missing = need.filter((k) => !cfg[k]);
  missing.length ? bad(`缺少字段：${missing.join(', ')}`) : ok(`字段齐全（${need.length} 项）`);

  const crossSite = cfg.apiBaseMode === 'cross-site';
  if (!['cross-site', 'same-zone'].includes(cfg.apiBaseMode)) {
    bad(`apiBaseMode 只能是 cross-site 或 same-zone（当前 "${cfg.apiBaseMode}"）`);
  } else {
    info(
      crossSite
        ? '模式 cross-site（Pages 与 Worker 不同站）→ 需要 VITE_API_BASE + COOKIE_SAMESITE=None'
        : '模式 same-zone（自定义域 /api/* 路由）→ 用相对路径，COOKIE_SAMESITE=Lax',
    );
  }

  // 生产域名 vs 分支预览别名：xxxx.fund-watch-3o5.pages.dev 是预览，不是生产
  try {
    const labels = new URL(cfg.pagesUrl).hostname.split('.');
    if (labels.length > 3) {
      bad(`pagesUrl 是分支预览别名（${labels.length} 段域名），生产域名应形如 ${cfg.pagesProject}-<后缀>.pages.dev`);
    } else {
      ok(`pagesUrl 形如生产域名：${cfg.pagesUrl}`);
    }
    if (!new URL(cfg.workerUrl).hostname.endsWith('.workers.dev') && !new URL(cfg.workerUrl).hostname.includes('.')) {
      wa('workerUrl 不像 Cloudflare 地址，请确认');
    } else {
      ok(`workerUrl：${cfg.workerUrl}`);
    }
  } catch (e) {
    bad(`workerUrl / pagesUrl 不是合法 URL：${e.message}`);
  }

  if (crossSite && (cfg.previewBranches || []).length) {
    info(`存在预览分支 [${cfg.previewBranches.join(', ')}]：它们也要用同一份带 VITE_API_BASE 的构建产物`);
  }
}

/* ---------- 1. 运行环境 ---------- */
console.log('\n【2】运行环境');
const major = Number(process.versions.node.split('.')[0]);
major >= 20 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} 过低：wrangler 需要 ≥ 20`);

/* ---------- 2. wrangler ---------- */
console.log('\n【3】wrangler CLI 与登录态');
/** 统一调用 wrangler：优先直接跑 wrangler.js（Windows 下 .cmd 无法直接 spawn） */
function resolveWrangler() {
  const candidates = [
    path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    path.join(process.env.LOCALAPPDATA || '', 'npm', 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    '/usr/local/lib/node_modules/wrangler/bin/wrangler.js',
    '/usr/lib/node_modules/wrangler/bin/wrangler.js',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || '';
}
const WRANGLER_JS = resolveWrangler();
function wr(args) {
  if (!WRANGLER_JS) return { code: -1, out: '' };
  const res = spawnSync(process.execPath, [WRANGLER_JS, ...args], { encoding: 'utf8', timeout: 180000 });
  if (res.error) return { code: -1, out: '' };
  return { code: res.status === null ? -1 : res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}
let wranglerCmd = WRANGLER_JS ? 'wrangler' : 'npx wrangler';
const ver = wr(['--version']);
const verLine = (ver.out || '').trim().split(/\r?\n/)[0];
if (/^(wrangler\s+)?\d+\.\d+\.\d+/i.test(verLine)) {
  ok(
    `可用：wrangler ${verLine.replace(/^wrangler\s+/i, '')}` +
      (WRANGLER_JS.includes(ROOT) ? '（项目本地）' : '（全局安装）'),
  );
} else if (WRANGLER_JS) {
  wa(`找到 wrangler.js 但执行失败：${WRANGLER_JS}`);
  wranglerCmd = 'npx wrangler';
} else {
  wa('本机找不到 wrangler：npm i -g wrangler（下面命令用 npx wrangler）');
}

const who = wr(['whoami']);
if (/You are logged in/i.test(who.out)) {
  const email = (who.out.match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] || '未知邮箱';
  const acct = (who.out.match(/\b([0-9a-f]{32})\b/) || [])[1] || '';
  ok(`已登录：${email}${acct ? `（account ${acct.slice(0, 8)}…）` : ''}`);
  const scopes = ['workers (write)', 'd1 (write)', 'pages (write)'];
  const missScope = scopes.filter((s) => !who.out.includes(s));
  missScope.length ? wa(`令牌缺少权限：${missScope.join(', ')}（重新 wrangler login）`) : ok('令牌含 workers/d1/pages 写权限');
} else if (who.code === -1) {
  wa('无法执行 wrangler whoami（缺少 wrangler）');
} else {
  bad('未登录 Cloudflare：先执行 `wrangler login`（或设置 CLOUDFLARE_API_TOKEN）');
}

/* ---------- 3. wrangler.toml ↔ 配置 ---------- */
console.log('\n【4】Worker 配置与代码一致性');
let toml = '';
if (!existsSync(TOML_PATH)) {
  bad('找不到 workers/wrangler.toml');
} else {
  toml = readFileSync(TOML_PATH, 'utf8');
  const name = (toml.match(/^name\s*=\s*"([^"]*)"/m) || [])[1];
  if (!cfg) info(`Worker 名称：${name}`);
  else if (name === cfg.workerName) ok(`name 与配置一致：${name}`);
  else bad(`name（${name}）与 cloudflare.config.json 的 workerName（${cfg.workerName}）不一致`);

  const mainFile = (toml.match(/^main\s*=\s*"([^"]*)"/m) || [])[1];
  const mainPath = mainFile ? path.join(ROOT, 'workers', mainFile) : '';
  mainPath && existsSync(mainPath) ? ok(`main 入口存在：workers/${mainFile}`) : bad(`main 入口不存在：${mainFile || '(未声明)'}`);

  /\[\[d1_databases\]\]/.test(toml) ? ok('已声明 D1 绑定') : bad('缺少 [[d1_databases]] 绑定');
  const binding = (toml.match(/binding\s*=\s*"([^"]*)"/) || [])[1];
  binding === 'DB' ? ok('D1 binding = DB（代码依赖此名）') : bad(`D1 binding 必须是 "DB"（当前 "${binding || '无'}"）`);

  const dbName = (toml.match(/database_name\s*=\s*"([^"]*)"/) || [])[1];
  if (!cfg) info(`database_name：${dbName || '未声明'}`);
  else if (dbName === cfg.d1Database) ok(`database_name 与配置一致：${dbName}`);
  else bad(`database_name（${dbName}）与配置 d1Database（${cfg.d1Database}）不一致`);

  const id = (toml.match(/database_id\s*=\s*"([^"]*)"/) || [])[1];
  if (!id) bad('缺少 database_id：先 `wrangler d1 create ' + (cfg ? cfg.d1Database : 'fund-watch') + '`');
  else if (id === PLACEHOLDER) bad('database_id 仍是占位符，部署会指向不存在的库');
  else ok(`database_id 已填：${id.slice(0, 8)}…${id.slice(-4)}`);

  const migDirCfg = (toml.match(/migrations_dir\s*=\s*"([^"]*)"/) || [])[1];
  migDirCfg && existsSync(path.join(ROOT, 'workers', migDirCfg))
    ? ok(`migrations_dir 存在：workers/${migDirCfg}`)
    : wa(`migrations_dir 未声明或不存在（${migDirCfg || '无'}）`);

  /nodejs_compat/.test(toml) ? ok('已启用 nodejs_compat') : wa('未启用 nodejs_compat（wrangler 依赖它加载 CJS 共享模块）');
  /r2_buckets/.test(toml) ? wa('检测到 R2 绑定：本项目已剔除对象存储') : ok('未绑定对象存储（无 R2）');

  // 跨站 vs SameSite：与配置模式必须匹配
  const sameSite = (toml.match(/COOKIE_SAMESITE\s*=\s*"([^"]*)"/) || [])[1] || '(未设置→Lax)';
  if (!cfg) info(`COOKIE_SAMESITE：${sameSite}`);
  else if (cfg.apiBaseMode === 'cross-site') {
    sameSite === 'None'
      ? ok('COOKIE_SAMESITE = None（跨站部署必需）')
      : bad(`跨站部署要求 COOKIE_SAMESITE = "None"（当前 ${sameSite}）→ 登录后刷新会掉登录态`);
  } else {
    sameSite === 'None'
      ? wa('same-zone 模式建议 COOKIE_SAMESITE = "Lax"（None 会放宽第三方携带范围）')
      : ok(`COOKIE_SAMESITE = ${sameSite}（同域足够）`);
  }

  const iter = (toml.match(/PBKDF2_ITERATIONS\s*=\s*"(\d+)"/) || [])[1];
  if (!iter) wa('未配置 PBKDF2_ITERATIONS（默认 100000，免费计划 CPU 可能吃紧）');
  else if (Number(iter) > 150000) wa(`PBKDF2_ITERATIONS=${iter} 偏高：免费计划 CPU 限 10ms，建议 50000-100000`);
  else ok(`PBKDF2_ITERATIONS = ${iter}`);
}

/* ---------- 4. 迁移 ---------- */
console.log('\n【5】D1 迁移文件');
if (!existsSync(MIG_DIR)) bad('缺少 workers/migrations/');
else {
  const sqls = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  if (!sqls.length) bad('migrations/ 下没有 .sql');
  else {
    ok(`迁移文件：${sqls.join(', ')}`);
    const tables = [...readFileSync(path.join(MIG_DIR, sqls[0]), 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    tables.length === 7 ? ok(`建表语句 7 张：${tables.join(', ')}`) : wa(`建表语句 ${tables.length} 张，预期 7`);
  }
}

/* ---------- 5. 产物 ↔ 模式 ---------- */
console.log('\n【6】前端产物与 API 地址注入');
if (!existsSync(path.join(DIST, 'index.html'))) {
  bad('dist/ 未构建：先 pnpm build');
} else {
  ok('dist/index.html 存在');
  existsSync(path.join(DIST, 'admin.html')) ? ok('dist/admin.html 存在（后台页）') : wa('缺少 dist/admin.html：检查多入口配置');
  existsSync(path.join(DIST, '_headers')) ? ok('dist/_headers 存在（Pages 响应头）') : wa('缺少 dist/_headers：public/_headers 未复制');

  const assetsDir = path.join(DIST, 'assets');
  const jsFiles = existsSync(assetsDir) ? readdirSync(assetsDir).filter((f) => f.endsWith('.js')) : [];
  const host = cfg ? new URL(cfg.workerUrl).hostname : '';
  const hit = jsFiles.find((f) => readFileSync(path.join(assetsDir, f), 'utf8').includes(host));
  if (!cfg) {
    info(`扫描 ${jsFiles.length} 个 JS，跳过模式校验（缺少配置）`);
  } else if (cfg.apiBaseMode === 'cross-site') {
    hit
      ? ok(`产物已注入后端地址（${hit} 含 ${host}）`)
      : bad(`产物未注入后端地址：构建前需 $env:VITE_API_BASE="${cfg.workerUrl}"（当前 ${jsFiles.length} 个 JS 均不含该域名）`);
  } else {
    hit ? wa(`同域模式不建议把 ${host} 写死进产物（用相对路径 /api）`) : ok('产物未写死后端地址（同域用相对路径）');
  }
}

/* ---------- 6. 在线检查（可选） ---------- */
console.log('\n【7】云端状态');
if (!ONLINE) {
  info('已跳过（加 --online 可校验 secret 列表与 D1 远端表、Worker 健康）');
  info('部署后探活：pnpm cf:doctor（读取同一份配置）');
} else if (!cfg) {
  wa('缺少配置，跳过在线检查');
} else {
  const sec = wr(['secret', 'list', '--config', 'workers/wrangler.toml']);
  if (/ADMIN_PASSWORD/.test(sec.out)) {
    ok('已配置 ADMIN_PASSWORD secret（注意：改 secret 不会改已有账号密码）');
  } else {
    bad('未配置 ADMIN_PASSWORD secret：内置管理员为 root/root（公网可登录，属于严重风险）');
  }
  if (/CORS_ORIGINS/.test(sec.out)) info('CORS_ORIGINS 以 secret 形式存在（与 [vars] 同名时以 secret 为准）');

  const d1 = wr(['d1', 'execute', cfg.d1Database, '--remote', '--config', 'workers/wrangler.toml', '--command', 'SELECT COUNT(*) AS users FROM users']);
  if (/"users"\s*:\s*\d+/.test(d1.out)) {
    const n = (d1.out.match(/"users"\s*:\s*(\d+)/) || [])[1];
    ok(`远端 D1 可查询，users = ${n}`);
    if (Number(n) <= 1) wa('只有 ≤1 个账号：确认 root 密码已改，且已注册正式账号');
  } else {
    bad(`远端 D1 查询失败（表未建？先 d1 migrations apply --remote）${d1.out ? `：${d1.out.split('\n')[0].slice(0, 80)}` : ''}`);
  }

  // 资源是否存在（本项目真实发生过「Worker 与 Pages 项目同时被删」）
  const dep = wr(['deployments', 'list', '--config', 'workers/wrangler.toml']);
  if (/does not exist/i.test(dep.out)) {
    bad(`Worker "${cfg.workerName}" 在账号里不存在（被删了？）→ 重新 ${wranglerCmd} deploy --config workers/wrangler.toml`);
  } else if (dep.out.trim()) {
    ok(`Worker 存在：${cfg.workerName}`);
  } else {
    wa('无法确认 Worker 是否存在（API 无返回）');
  }

  const proj = wr(['pages', 'project', 'list']);
  if (proj.out.includes(cfg.pagesProject)) {
    ok(`Pages 项目存在：${cfg.pagesProject}`);
  } else if (proj.out.trim()) {
    bad(`Pages 项目 "${cfg.pagesProject}" 不存在 → ${wranglerCmd} pages project create ${cfg.pagesProject} --production-branch ${cfg.productionBranch}`);
  } else {
    wa('无法确认 Pages 项目是否存在（API 无返回）');
  }

  // 线上四层探活交给 cf:doctor（它自带系统代理识别与 bundle 校验），这里不重复实现
  info('线上探活：pnpm cf:doctor（Worker / 站点 / 路由 / Cookie 四层细查）');
}

/* ---------- 7. 命令 ---------- */
if (cfg) {
  const w = wranglerCmd;
  const envLine = cfg.apiBaseMode === 'cross-site' ? `$env:VITE_API_BASE="${cfg.workerUrl}"; ` : '';
  console.log('\n【8】按当前配置的部署命令');
  console.log(`
  # 后端（含 [vars] 变更）
  ${w} deploy --config workers/wrangler.toml

  # 前端（${cfg.apiBaseMode}${cfg.apiBaseMode === 'cross-site' ? '：必须带 VITE_API_BASE' : '：不要带 VITE_API_BASE'}）
  ${envLine}pnpm build
  ${w} pages deploy dist --project-name ${cfg.pagesProject} --branch ${cfg.productionBranch}
${(cfg.previewBranches || [])
  .map(
    (b) => `
  # 预览分支 ${b}（同样要带 VITE_API_BASE，否则该环境的 /api 会打到 Pages）
  ${envLine}pnpm build
  ${w} pages deploy dist --project-name ${cfg.pagesProject} --branch ${b}`,
  )
  .join('\n')}

  # 部署后验收（读取 cloudflare.config.json）
  pnpm cf:doctor
`);
}

console.log(`\n结果：阻塞 ${blocking} 项，警告 ${warn} 项`);
process.exit(blocking === 0 ? 0 : 1);
