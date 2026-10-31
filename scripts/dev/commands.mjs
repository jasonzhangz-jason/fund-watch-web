#!/usr/bin/env node
/**
 * 列出 package.json 的全部命令及作用
 *   pnpm commands            # 全部
 *   pnpm commands cf         # 只看 cf: 前缀
 *   pnpm commands test       # 只看 test: 前缀
 *
 * 说明来自 package.json 的 "scriptsInfo"；test:docs 会校验两者是否一一对应，
 * 因此新增命令时忘了写说明会直接让测试失败。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const info = pkg.scriptsInfo || {};
const filter = process.argv[2] || '';

/** 分组顺序：按前缀归类，未命中的归到「其他」 */
const GROUPS = [
  { key: 'start', title: '本地启动' },
  { key: 'dev', title: '本地启动' },
  { key: 'dev:', title: '本地启动' },
  { key: 'build', title: '构建与检查' },
  { key: 'preview', title: '构建与检查' },
  { key: 'typecheck', title: '构建与检查' },
  { key: 'help', title: '构建与检查' },
  { key: 'shoot', title: '构建与检查' },
  { key: 'db:', title: '本地数据库' },
  { key: 'cf:check', title: 'Cloudflare 部署' },
  { key: 'cf:doctor', title: 'Cloudflare 部署' },
  { key: 'cf:', title: 'Cloudflare 部署' },
  { key: 'd1:', title: 'Cloudflare 部署' },
  { key: 'deploy', title: '其他' },
  { key: 'test:', title: '测试' },
];

const groupOf = (name) => {
  for (const g of GROUPS) if (name === g.key || (g.key.endsWith(':') && name.startsWith(g.key))) return g.title;
  return '其他';
};

const rows = Object.entries(pkg.scripts)
  .filter(([name]) => !filter || name.startsWith(filter))
  .map(([name, cmd]) => ({ name, cmd, desc: info[name] || '', group: groupOf(name) }));

if (!rows.length) {
  console.error(`没有匹配 "${filter}" 的命令`);
  process.exit(1);
}

const ORDER = ['本地启动', '构建与检查', '本地数据库', 'Cloudflare 部署', '测试', '其他'];
const byGroup = new Map(ORDER.map((g) => [g, []]));
for (const r of rows) byGroup.get(r.group).push(r);

const width = Math.max(...rows.map((r) => r.name.length));
const dim = '\x1b[2m';
const bold = '\x1b[1m';
const cyan = '\x1b[36m';
const reset = '\x1b[0m';

console.log(`\n${bold}${pkg.name} v${pkg.version}${reset}  ${dim}— 共 ${Object.keys(pkg.scripts).length} 条命令${filter ? `（筛选：${filter}）` : ''}${reset}`);
for (const g of ORDER) {
  const list = byGroup.get(g);
  if (!list.length) continue;
  console.log(`\n${cyan}${g}${reset}`);
  for (const r of list) {
    const pad = ' '.repeat(Math.max(0, width - r.name.length));
    console.log(`  ${bold}${r.name}${reset}${pad}  ${r.desc}`);
    console.log(`  ${' '.repeat(width)}  ${dim}$ ${r.cmd}${reset}`);
  }
}
console.log(`\n${dim}提示：命令说明维护在 package.json 的 "scriptsInfo"，缺失会被 pnpm test:docs 拦下。${reset}\n`);
