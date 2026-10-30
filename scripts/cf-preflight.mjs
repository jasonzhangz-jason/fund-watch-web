#!/usr/bin/env node
/**
 * Cloudflare 部署前自检
 *   node scripts/cf-preflight.mjs
 *
 * 依次检查：Node 版本 → wrangler 可用性 → wrangler.toml（D1 绑定 / database_id 是否已替换）
 *          → 迁移文件 → 前端构建产物 → 登录态
 * 全部通过后，打印**按顺序**可复制的部署命令。
 * 退出码：0 全部就绪（或仅有警告）；1 存在阻塞项。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'workers', 'wrangler.toml');
const PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

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

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', timeout: 60000 }).trim();
  } catch {
    return null;
  }
};

/* ---------- 1. Node ---------- */
console.log('\n【1】运行环境');
const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) ok(`Node ${process.versions.node}`);
else bad(`Node ${process.versions.node} 过低：wrangler 需要 ≥ 20`);

/* ---------- 2. wrangler ---------- */
console.log('\n【2】wrangler CLI');
let wranglerCmd = null;
const local = run(process.execPath, [path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), '--version']);
if (local) {
  wranglerCmd = 'npx wrangler';
  ok(`本地已安装：wrangler ${local.split('\n')[0]}`);
} else {
  const npxTest = run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--no-install', 'wrangler', '--version']);
  if (npxTest) {
    wranglerCmd = 'npx wrangler';
    ok(`npx 可用：wrangler ${npxTest.split('\n')[0]}`);
  } else {
    wa('本机未安装 wrangler：先执行 `npm i -g wrangler`（或 `npx wrangler@latest login`），后续命令用 npx wrangler');
  }
}

/* ---------- 3. wrangler.toml ---------- */
console.log('\n【3】Worker 配置（workers/wrangler.toml）');
let toml = '';
if (!existsSync(CONFIG)) {
  bad('找不到 workers/wrangler.toml');
} else {
  toml = readFileSync(CONFIG, 'utf8');
  ok('配置文件存在');

  const hasD1 = /\[\[d1_databases\]\]/.test(toml);
  hasD1 ? ok('已声明 D1 绑定') : bad('缺少 [[d1_databases]] 绑定');
  /binding\s*=\s*"DB"/.test(toml) ? ok('D1 绑定名为 DB（代码依赖此名）') : bad('D1 binding 必须为 "DB"');

  const idMatch = toml.match(/database_id\s*=\s*"([^"]*)"/);
  if (!idMatch) bad('缺少 database_id（先跑 `wrangler d1 create fund-watch`）');
  else if (idMatch[1] === PLACEHOLDER) bad('database_id 仍是占位符：请替换为 `wrangler d1 create fund-watch` 返回的真实 ID');
  else ok(`database_id 已填写（${idMatch[1].slice(0, 8)}…）`);

  const nameMatch = toml.match(/^name\s*=\s*"([^"]*)"/m);
  if (nameMatch) ok(`Worker 名称：${nameMatch[1]}`);

  /r2_buckets/.test(toml) ? wa('检测到 R2 绑定：本项目已不使用对象存储，可删除') : ok('未绑定对象存储（R2 已剔除）');

  if (/nodejs_compat/.test(toml)) ok('已启用 nodejs_compat');
}

/* ---------- 4. 迁移文件 ---------- */
console.log('\n【4】D1 迁移');
const migDir = path.join(ROOT, 'workers', 'migrations');
if (!existsSync(migDir)) bad('缺少 workers/migrations/ 目录');
else {
  const sqls = readdirSync(migDir).filter((f) => f.endsWith('.sql'));
  if (!sqls.length) bad('migrations/ 下没有 .sql 文件');
  else {
    ok(`迁移文件：${sqls.join(', ')}`);
    const sql = readFileSync(path.join(migDir, sqls[0]), 'utf8');
    const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    tables.length === 7 ? ok(`建表语句包含 7 张表（${tables.join(', ')}）`) : wa(`建表语句数量为 ${tables.length}，预期 7`);
  }
}

/* ---------- 5. 前端产物 ---------- */
console.log('\n【5】前端构建产物');
if (existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  ok('dist/index.html 存在');
  existsSync(path.join(ROOT, 'dist', 'admin.html')) ? ok('dist/admin.html 存在（后台页）') : wa('dist/ 缺少 admin.html：检查 vite 多入口配置');
  existsSync(path.join(ROOT, 'dist', '_headers')) ? ok('dist/_headers 存在（Pages 响应头）') : wa('dist/_headers 缺失：public/_headers 未复制？');
} else {
  bad('dist/ 未构建：先执行 `pnpm build`');
}

/* ---------- 6. 密钥与配置提醒 ---------- */
console.log('\n【6】需要你人工设置的值');
console.log('  · ADMIN_PASSWORD      → wrangler secret put ADMIN_PASSWORD（内置管理员密码，默认 root 不安全）');
console.log('  · CORS_ORIGINS        → 仅「前后端不同域」时需要，填 Pages 域名');
console.log('  · VITE_API_BASE       → 仅「前后端不同域」时，在 Pages 构建环境变量里设置');
console.log('  · PBKDF2_ITERATIONS   → 免费计划 CPU 紧张时可降到 50000（wrangler.toml [vars]）');

/* ---------- 7. 部署命令 ---------- */
console.log('\n【7】按顺序执行（同域部署，推荐）');
const w = wranglerCmd || 'npx wrangler';
console.log(`
  # 1) 登录（首次）
  ${w} login

  # 2) 建库 → 把返回的 database_id 填进 workers/wrangler.toml
  ${w} d1 create fund-watch

  # 3) 线上建表
  ${w} d1 migrations apply fund-watch --remote --config workers/wrangler.toml

  # 4) 管理员密码（务必改掉默认 root）
  ${w} secret put ADMIN_PASSWORD --config workers/wrangler.toml

  # 5) 部署后端 → 记下返回的 *.workers.dev 地址
  ${w} deploy --config workers/wrangler.toml
  curl https://fund-watch-api.<你的子域>.workers.dev/api/health

  # 6) 构建 + 发布前端到 Pages
  pnpm build
  ${w} pages project create fund-watch --production-branch main
  ${w} pages deploy dist --project-name fund-watch
`);

console.log('【8】收尾（在 Cloudflare Dashboard 操作）');
console.log('  1. Pages 项目 → Custom domains → 绑定 fund.example.com');
console.log('  2. Worker → Settings → Triggers → Add route：fund.example.com/api/*');
console.log('     （同域后前端用相对路径 /api，不需要 VITE_API_BASE，也没有跨域 Cookie 问题）');
console.log('  3. 浏览器打开 https://fund.example.com → 注册/登录 → 添加持仓验证真实行情');

console.log(`\n结果：阻塞 ${blocking} 项，警告 ${warn} 项`);
process.exit(blocking === 0 ? 0 : 1);
