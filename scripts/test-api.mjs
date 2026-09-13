// 本地功能测试：模拟 Vercel handler 调用（真实请求上游）
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

function makeRes() {
  return {
    _s: 200, _j: null,
    status(c) { this._s = c; return this; },
    json(j) { this._j = j; },
    setHeader() {},
  };
}

const cases = [
  ['search', { key: '中证A500' }],
  ['nav', { code: '161725', page: '1', size: '3' }],
  ['estimate', { codes: '161725,000001' }],
  ['detail', { code: '161725' }],
];

for (const [name, query] of cases) {
  const mod = require('../api/' + name + '.js');
  const res = makeRes();
  await mod({ query }, res);
  const j = res._j;
  const brief = j ? JSON.stringify(j).slice(0, 220) : '(no json)';
  console.log(`== ${name} -> http ${res._s} ==`);
  console.log('  ' + brief);
  if (!j || !j.ok) { console.log('  !! FAIL'); process.exitCode = 1; }
}
console.log('\nDONE');
