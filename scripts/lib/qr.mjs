// 自包含 QR 码编码器（零依赖）——供本地调试启动时生成手机扫码入口
// 支持：字节模式、版本 1-10、纠错等级 L/M/Q/H
// 输出：布尔矩阵 / 终端 ANSI 二维码 / SVG
// 说明：按 ISO/IEC 18004 实现（GF(256) Reed-Solomon、掩码罚分、格式/版本信息）

// ---------------- GF(256) ----------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGenPoly(deg) {
  let g = [1];
  for (let i = 0; i < deg; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= gfMul(g[j], 1); next[j + 1] ^= gfMul(g[j], EXP[i]); }
    g = next;
  }
  return g;
}
function rsEncode(data, eccLen) {
  const gen = rsGenPoly(eccLen);
  const res = new Uint8Array(data.length + eccLen);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef !== 0) for (let j = 1; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], coef);
  }
  return res.slice(data.length);
}

// ---------------- 版本/纠错表（版本 1-10）----------------
// [eccPerBlock, [blocks, dataPerBlock], [blocks, dataPerBlock]?]
const RS_TABLE = {
  L: [
    [7, [1, 19]], [10, [1, 34]], [15, [1, 55]], [20, [1, 80]], [26, [1, 108]],
    [18, [2, 68]], [20, [2, 78]], [24, [2, 97]], [30, [2, 116]], [18, [2, 68], [2, 69]],
  ],
  M: [
    [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]],
    [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]],
  ],
  Q: [
    [13, [1, 13]], [22, [1, 22]], [18, [2, 17]], [26, [2, 24]], [18, [2, 15], [2, 16]],
    [24, [4, 19]], [18, [2, 14], [4, 15]], [22, [4, 18], [2, 19]], [20, [4, 16], [4, 17]], [24, [6, 19], [2, 20]],
  ],
  H: [
    [17, [1, 9]], [28, [1, 16]], [22, [2, 13]], [16, [4, 9]], [22, [2, 11], [2, 12]],
    [28, [4, 15]], [26, [4, 13], [1, 14]], [26, [4, 14], [2, 15]], [24, [4, 12], [4, 13]], [28, [6, 15], [2, 16]],
  ],
};
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};
const ECC_BITS = { L: 1, M: 0, Q: 3, H: 2 }; // 格式信息中的纠错等级编码

const totalBlocks = (v, e) => RS_TABLE[e][v - 1].slice(1).reduce((s, [n]) => s + n, 0);
const dataCodewords = (v, e) => RS_TABLE[e][v - 1].slice(1).reduce((s, [n, d]) => s + n * d, 0);

// ---------------- 位缓冲 ----------------
class BitBuffer {
  constructor() { this.bits = []; }
  put(value, length) { for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1); }
  get length() { return this.bits.length; }
}

// ---------------- 编码数据 ----------------
function encodeData(bytes, version, ecc) {
  const ccBits = version <= 9 ? 8 : 16;
  const buf = new BitBuffer();
  buf.put(0b0100, 4);              // 字节模式
  buf.put(bytes.length, ccBits);   // 字符计数
  for (const b of bytes) buf.put(b, 8);
  const capacityBits = dataCodewords(version, ecc) * 8;
  if (buf.length > capacityBits) throw new Error('内容过长，超出该版本容量');
  // 终止符 + 补位
  buf.put(0, Math.min(4, capacityBits - buf.length));
  while (buf.length % 8 !== 0) buf.bits.push(0);
  const data = new Uint8Array(dataCodewords(version, ecc));
  for (let i = 0; i < buf.length / 8; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | buf.bits[i * 8 + j];
    data[i] = byte;
  }
  const padBytes = [0xec, 0x11];
  for (let i = buf.length / 8, k = 0; i < data.length; i++, k++) data[i] = padBytes[k % 2];
  return data;
}

function buildCodewords(bytes, version, ecc) {
  const data = encodeData(bytes, version, ecc);
  const spec = RS_TABLE[ecc][version - 1];
  const eccLen = spec[0];
  const groups = spec.slice(1).map(([blocks, dLen]) => ({ blocks, dLen }));
  const dataBlocks = [];
  let offset = 0;
  for (const g of groups) for (let i = 0; i < g.blocks; i++) { dataBlocks.push(data.slice(offset, offset + g.dLen)); offset += g.dLen; }
  const eccBlocks = dataBlocks.map((b) => rsEncode(b, eccLen));
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  const out = [];
  for (let i = 0; i < maxData; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < eccLen; i++) for (const b of eccBlocks) out.push(b[i]);
  return out;
}

// ---------------- 矩阵构建 ----------------
function buildMatrix(codewords, version, ecc, mask) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < size && y < size) m[y][x] = v; };

  // 定位图案 + 分隔符
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let y = -1; y <= 7; y++) for (let x = -1; x <= 7; x++) {
      const inOuter = x >= 0 && x <= 6 && y >= 0 && y <= 6;
      const dark = inOuter && (x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4));
      if (inOuter || (x >= -1 && x <= 7 && y >= -1 && y <= 7)) set(ox + x, oy + y, dark);
    }
  }
  // 定时图案
  for (let i = 8; i < size - 8; i++) { if (m[6][i] === null) set(i, 6, i % 2 === 0); if (m[i][6] === null) set(6, i, i % 2 === 0); }
  // 校正图案
  const ap = ALIGN[version];
  for (const cy of ap) for (const cx of ap) {
    if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
      const dark = Math.max(Math.abs(x), Math.abs(y)) !== 1;
      set(cx + x, cy + y, dark);
    }
  }
  // 固定暗模块
  set(8, size - 8, true);

  // 格式信息占位（先预留，最后写入真实值）
  const reserve = (x, y) => { if (m[y][x] === null) m[y][x] = false; };
  for (let i = 0; i <= 8; i++) { reserve(i, 8); reserve(8, i); }
  for (let i = 0; i < 8; i++) { reserve(size - 1 - i, 8); reserve(8, size - 1 - i); }
  // 版本信息占位（v>=7）
  if (version >= 7) {
    for (let i = 0; i < 18; i++) { reserve(size - 11 + (i % 3), Math.floor(i / 3)); reserve(Math.floor(i / 3), size - 11 + (i % 3)); }
  }

  // 数据填充（右下起，之字形）
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  const bitAt = (i) => (codewords[i >> 3] >> (7 - (i & 7))) & 1;
  let upward = true;
  for (let x = size - 1; x > 0; x -= 2) {
    if (x === 6) x--; // 跳过定时列
    for (let k = 0; k < size; k++) {
      const y = upward ? size - 1 - k : k;
      for (const xx of [x, x - 1]) {
        if (m[y][xx] !== null) continue;
        const bit = bitIdx < totalBits ? bitAt(bitIdx) : 0;
        bitIdx++;
        // 掩码
        let invert = false;
        switch (mask) {
          case 0: invert = (xx + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = xx % 3 === 0; break;
          case 3: invert = (xx + y) % 3 === 0; break;
          case 4: invert = (Math.floor(y / 2) + Math.floor(xx / 3)) % 2 === 0; break;
          case 5: invert = ((xx * y) % 2) + ((xx * y) % 3) === 0; break;
          case 6: invert = (((xx * y) % 2) + ((xx * y) % 3)) % 2 === 0; break;
          case 7: invert = (((xx + y) % 2) + ((xx * y) % 3)) % 2 === 0; break;
        }
        m[y][xx] = (bit ^ (invert ? 1 : 0)) === 1;
      }
    }
    upward = !upward;
  }

  // 格式信息（BCH 15,5）：dataBits(5) + BCH(10)，再异或 0x5412
  const dataBits = (ECC_BITS[ecc] << 3) | mask;
  let rem = dataBits;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const fbits = ((dataBits << 10) | (rem & 0x3ff)) ^ 0x5412;
  const bit = (i) => ((fbits >>> i) & 1) === 1;
  // 格式信息摆放（第一副本：第8列上段 + 第8行左段；第二副本：第8行右段 + 第8列下段）
  for (let i = 0; i <= 5; i++) m[i][8] = bit(i);          // (x=8, y=0..5)
  m[7][8] = bit(6);                                        // (x=8, y=7)
  m[8][8] = bit(7);                                        // (x=8, y=8)
  m[8][7] = bit(8);                                        // (x=7, y=8)
  for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);      // (x=5..0, y=8)
  for (let i = 0; i < 8; i++) m[8][size - 1 - i] = bit(i); // (x=size-1..size-8, y=8)
  for (let i = 8; i < 15; i++) m[size - 15 + i][8] = bit(i); // (x=8, y=size-7..size-1)
  m[size - 8][8] = true;                                   // 固定暗模块 (x=8, y=size-8)

  // 版本信息（BCH 18,6，v>=7）
  if (version >= 7) {
    let vrem = version << 12;
    for (let i = 17; i >= 12; i--) if ((vrem >>> i) & 1) vrem ^= 0x1f25 << (i - 12);
    const vbits = (version << 12) | vrem;
    for (let i = 0; i < 18; i++) {
      const b = ((vbits >>> i) & 1) === 1;
      m[Math.floor(i / 3)][size - 11 + (i % 3)] = b;
      m[size - 11 + (i % 3)][Math.floor(i / 3)] = b;
    }
  }
  return m;
}

// 掩码罚分
function penalty(m) {
  const size = m.length;
  let score = 0;
  // 规则1：连续同色
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (m[y][x] === m[y][x - 1]) run++; else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (m[y][x] === m[y - 1][x]) run++; else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  // 规则2：2x2 同色块
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
  }
  // 规则3：类似定位图案
  const pat = [true, false, true, true, true, false, true, false, false, false, false];
  const pat2 = [false, false, false, false, true, false, true, true, true, false, true];
  const match = (arr, i, p) => p.every((v, k) => arr[i + k] === v);
  for (let y = 0; y < size; y++) {
    const row = m[y];
    for (let x = 0; x + 11 <= size; x++) { if (match(row, x, pat) || match(row, x, pat2)) score += 40; }
  }
  for (let x = 0; x < size; x++) {
    const col = m.map((r) => r[x]);
    for (let y = 0; y + 11 <= size; y++) { if (match(col, y, pat) || match(col, y, pat2)) score += 40; }
  }
  // 规则4：暗模块占比
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

/**
 * 生成 QR 矩阵
 * @param {string} text 内容
 * @param {{ecc?: 'L'|'M'|'Q'|'H', version?: number, mask?: number}} opts
 * @returns {{size:number, modules:boolean[][], version:number, ecc:string}}
 */
export function qrMatrix(text, opts = {}) {
  const ecc = opts.ecc || 'M';
  const bytes = new TextEncoder().encode(text);
  let version = opts.version;
  if (!version) {
    for (let v = 1; v <= 10; v++) {
      const need = 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;
      if (need <= dataCodewords(v, ecc) * 8) { version = v; break; }
    }
    if (!version) throw new Error('内容过长（最大支持版本 10）');
  }
  const codewords = buildCodewords(bytes, version, ecc);
  let best = null, bestScore = Infinity, bestMask = 0;
  const masks = opts.mask !== undefined ? [opts.mask] : [0, 1, 2, 3, 4, 5, 6, 7];
  for (const mask of masks) {
    const m = buildMatrix(codewords, version, ecc, mask);
    const s = opts.mask !== undefined ? -1 : penalty(m);
    if (s < bestScore) { bestScore = s; best = m; bestMask = mask; }
  }
  return { size: best.length, modules: best, version, ecc, mask: bestMask };
}

/** 终端二维码（半块字符，深色模块为黑） */
export function toTerminal(text, opts = {}) {
  const { size, modules } = qrMatrix(text, opts);
  const quiet = 2;
  const n = size + quiet * 2;
  const get = (x, y) => (x >= quiet && y >= quiet && x < size + quiet && y < size + quiet) ? modules[y - quiet][x - quiet] : false;
  const lines = [];
  for (let y = 0; y < n; y += 2) {
    let line = '';
    for (let x = 0; x < n; x++) {
      const top = get(x, y);
      const bottom = y + 1 < n ? get(x, y + 1) : false;
      line += `\x1b[${top ? 30 : 37};${bottom ? 40 : 47}m▀`;
    }
    line += '\x1b[0m';
    lines.push(line);
  }
  return lines.join('\n');
}

/** SVG 二维码（放大版，便于屏幕扫码） */
export function toSVG(text, opts = {}) {
  const { size, modules } = qrMatrix(text, opts);
  const quiet = 4;
  const dim = size + quiet * 2;
  let rects = '';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (modules[y][x]) rects += `<rect x="${x + quiet}" y="${y + quiet}" width="1" height="1"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="#ffffff"/><g fill="#000000">${rects}</g></svg>`;
}
