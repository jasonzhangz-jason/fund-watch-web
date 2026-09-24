/**
 * 文档一致性测试：README 的数据层章节 vs 真实建表语句
 *   node scripts/test-docs.mjs
 *
 * 校验：
 *   1. README 中 mermaid erDiagram 的语法结构
 *   2. ER 图实体/字段与 server/db.cjs 的建表语句逐项比对（图里不能有 schema 中不存在的字段）
 *   3. 每张表的字段说明表覆盖 schema 的全部字段（避免字段加了文档没跟上）
 *   4. 关系线语义：实线必须是真实外键，行情表用虚线逻辑关联
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 统一行尾：仓库在 Windows 检出时是 CRLF，解析必须与行尾无关 */
const normalize = (s) => s.replace(/\r\n/g, '\n');
const readme = normalize(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'));
const dbSrc = normalize(fs.readFileSync(path.join(ROOT, 'server', 'db.cjs'), 'utf8'));

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

/* ---------- 1. 从 db.cjs 解析真实 schema ---------- */
const schema = new Map();
for (const m of dbSrc.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\s*\);/g)) {
  const [, table, body] = m;
  const cols = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('--')) continue;
    const cm = line.match(/^([a-z_]+)\s+(INTEGER|TEXT|REAL)\b/i);
    if (cm) cols.push(cm[1]);
  }
  schema.set(table, cols);
}
console.log(`\n【1】从 server/db.cjs 解析到 ${schema.size} 张表：${[...schema.keys()].join(', ')}`);
check('解析到 7 张表', schema.size === 7, String(schema.size));

/* ---------- 2. mermaid 语法与实体解析 ---------- */
const block = readme.match(/```mermaid\n([\s\S]*?)```/);
check('README 含 mermaid 代码块', Boolean(block));
const lines = block[1].split('\n').map((l) => l.replace(/\s+$/, ''));
check('首行为 erDiagram', lines[0].trim() === 'erDiagram', lines[0]);

const CARD = /^(\|\||\|o|\}o|\}\|)(--|\.\.)(\|\||o\||o\{|\|\{)$/;
const entities = new Map();
const rels = [];
let current = null;
let err = null;

lines.slice(1).forEach((raw, i) => {
  const line = raw.trim();
  if (!line) return;
  if (!current) {
    const rel = line.match(/^(\w+)\s+(\S+)\s+(\w+)\s*:\s*"([^"]*)"$/);
    if (rel) {
      const [, a, card, b, label] = rel;
      if (!CARD.test(card)) err = `第 ${i + 2} 行基数非法: ${card}`;
      if (!label) err = `第 ${i + 2} 行缺少关系标签`;
      rels.push([a, card, b]);
      return;
    }
    const ent = line.match(/^(\w+)\s*\{$/);
    if (ent) {
      current = { name: ent[1], fields: [], keys: [] };
      return;
    }
    err = `第 ${i + 2} 行无法识别: ${line}`;
    return;
  }
  if (line === '}') {
    entities.set(current.name, current);
    current = null;
    return;
  }
  const attr = line.match(/^(\w+)\s+(\w+)(?:\s+(PK|FK|UK))?(?:\s+"([^"]*)")?$/);
  if (!attr) {
    err = `第 ${i + 2} 行属性格式非法: ${line}`;
    return;
  }
  const [, type, name, key] = attr;
  if (!/^(INTEGER|TEXT|REAL|BLOB|NUMERIC|VARCHAR|STRING|INT|FLOAT|BOOLEAN|DATE|DATETIME)$/i.test(type)) {
    err = `第 ${i + 2} 行类型可疑: ${type}`;
  }
  current.fields.push(name);
  if (key) current.keys.push(`${name}:${key}`);
});

check('mermaid 语法结构可解析', err === null, err || '');
check('实体块闭合', current === null);
check(
  `解析到 ${entities.size} 个实体 / ${rels.length} 条关系`,
  entities.size === schema.size && rels.length >= 5,
  `实体 ${entities.size} 关系 ${rels.length}`,
);

/* ---------- 3. ER 图 vs 真实 schema ---------- */
console.log('\n【2】ER 图实体与字段 vs 真实建表');
for (const [table, cols] of schema) {
  const ent = entities.get(table);
  check(`表 ${table} 出现在 ER 图`, Boolean(ent));
  if (!ent) continue;
  const missing = ent.fields.filter((f) => !cols.includes(f));
  check(`  ${table} 图字段均存在于 schema`, missing.length === 0, `多余: ${missing.join(',')}`);
}
check('ER 图无多余实体', [...entities.keys()].every((e) => schema.has(e)), [...entities.keys()].filter((e) => !schema.has(e)).join(','));

/* ---------- 4. 字段说明覆盖度 ---------- */
console.log('\n【3】字段业务含义说明覆盖度');
for (const [table, cols] of schema) {
  const section = readme.split(new RegExp(`### \\d+\\. \`${table}\``))[1];
  check(`存在 ${table} 的字段说明小节`, Boolean(section));
  if (!section) continue;
  const body = section.split('###')[0];
  const documented = cols.filter((c) => new RegExp(`\\\`${c}\\\``).test(body));
  check(`  ${table} 全部字段有说明`, documented.length === cols.length, `未覆盖: ${cols.filter((c) => !documented.includes(c)).join(',')}`);
}

/* ---------- 5. 关系语义 ---------- */
console.log('\n【4】关系线语义（实线=真实外键 / 虚线=逻辑关联）');
const fkTargets = new Set();
for (const m of dbSrc.matchAll(/REFERENCES (\w+)\(id\)/g)) fkTargets.add(m[1]);
for (const [a, card, b] of rels) {
  const solid = card.includes('--');
  if (solid) check(`${a} → ${b} 有真实外键支撑`, fkTargets.has(a), `${a} 未被任何外键引用`);
  else check(`${a} → ${b} 为逻辑关联（无外键）`, !fkTargets.has(a), `${a} 其实有外键，应改为实线`);
}

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
