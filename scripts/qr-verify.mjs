// QR 编码器自检：与权威库 qrcode 逐位比对（需要可选依赖 qrcode）
// 运行：NODE_PATH=<有 qrcode 的 node_modules> node scripts/qr-verify.mjs
import { createRequire } from 'module';
import { qrMatrix } from './qr.mjs';

const require = createRequire(import.meta.url);
let QRCode;
try {
  QRCode = require('qrcode');
} catch {
  console.log('⚠️  未安装参考库 qrcode，跳过比对。安装：npm i -D qrcode');
  process.exit(0);
}

// 与 qr.mjs 保持一致的数据码字容量表（用于构造刚好放下的内容）
const DATA_CW = {
  L: [19, 34, 55, 80, 108, 136, 156, 194, 232, 274],
  M: [16, 28, 44, 64, 86, 108, 124, 154, 182, 216],
  Q: [13, 22, 34, 48, 62, 76, 88, 110, 132, 154],
  H: [9, 16, 26, 36, 46, 60, 66, 86, 100, 122],
};

let checked = 0, failed = 0;
const eccs = ['L', 'M', 'Q', 'H'];

for (const ecc of eccs) {
  for (let v = 1; v <= 10; v++) {
    const cw = DATA_CW[ecc][v - 1];
    const ccBits = v <= 9 ? 8 : 16;
    const maxBytes = Math.floor((cw * 8 - 4 - ccBits) / 8);
    // 用小写文本（无法用字母数字模式编码）强制字节模式，才能与参考库逐位比对
    const texts = ['a', 'abc', 'a'.repeat(Math.min(maxBytes, 12)), 'a'.repeat(maxBytes)];
    for (const text of texts) {
      for (let mask = 0; mask < 8; mask++) {
        const ref = QRCode.create(text, { version: v, errorCorrectionLevel: ecc, maskPattern: mask });
        const mine = qrMatrix(text, { ecc, version: v, mask });
        const size = ref.modules.size;
        let same = size === mine.size;
        if (same) {
          for (let y = 0; y < size && same; y++) {
            for (let x = 0; x < size; x++) {
              const r = ref.modules.get(y, x) ? 1 : 0;  // 注意：qrcode 库为 get(row, col)
              const m = mine.modules[y][x] ? 1 : 0;
              if (r !== m) { same = false; break; }
            }
          }
        }
        checked++;
        if (!same) {
          failed++;
          if (failed <= 5) console.log(`❌ 不一致: ecc=${ecc} version=${v} mask=${mask} len=${text.length} (mine size=${mine.size}, ref size=${size})`);
        }
      }
    }
  }
}

console.log(`\n比对组合数: ${checked}，不一致: ${failed}`);
console.log(failed === 0 ? '✅ 与参考库逐位一致' : '❌ 存在差异，需修正编码器');
process.exit(failed === 0 ? 0 : 1);
