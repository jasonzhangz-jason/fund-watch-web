#!/usr/bin/env node
/**
 * 一键启动前后端（零依赖编排脚本）
 *
 *   pnpm start                 # 后端 8787 + 前端 5173，并打印手机扫码二维码
 *   pnpm start --open          # 启动后自动打开浏览器
 *   pnpm start --no-qr         # 不打印二维码
 *   PORT=9000 WEB_PORT=5174 pnpm start   # 自定义端口
 *
 * 行为：
 *   1. 启动前检查端口占用，占用则直接给出可操作的提示
 *   2. 后端 /api 与前端页面都就绪后才打印横幅（不靠 sleep 猜时间）
 *   3. 子进程日志带 [api] / [web] 前缀，输出可区分
 *   4. Ctrl+C 或任一进程退出 → 同时结束另一个，不留残留进程
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toTerminal } from './qr.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = Number(process.env.PORT || 8787);
const WEB_PORT = Number(process.env.WEB_PORT || 5173);
const OPEN = process.argv.includes('--open');
const NO_QR = process.argv.includes('--no-qr');
const READY_TIMEOUT_MS = 30_000;

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
};

/* ---------------- 显示宽度（含中文与 emoji，保证边框对齐） ---------------- */
const isWide = (ch) =>
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}]|[\u2600-\u27BF]/u.test(
    ch,
  );
const dispWidth = (s) => [...s].reduce((w, ch) => w + (isWide(ch) ? 2 : 1), 0);
const padEnd = (s, n) => s + ' '.repeat(Math.max(0, n - dispWidth(s)));
const boxLine = (content, width = 62) => `│ ${padEnd(content, width - 4)} │`;

/* ---------------- 工具 ---------------- */
function lanIPv4() {
  const out = [];
  for (const name of Object.keys(os.networkInterfaces())) {
    for (const net of os.networkInterfaces()[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function isPortBusy(port) {
  // 用 TCP 连接探测（bind 探测在 Windows 上无法发现只监听 :: 的服务）
  const probe = (host) =>
    new Promise((resolve) => {
      const sock = net.connect({ port, host });
      const done = (busy) => {
        sock.destroy();
        resolve(busy);
      };
      sock.setTimeout(800);
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
    });
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then(([a, b]) => a || b);
}

async function waitFor(url, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return true;
    } catch {
      /* 尚未就绪 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** 把子进程输出按行加前缀，避免两个服务的日志互相穿插 */
function prefixOutput(stream, label, color) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      process.stdout.write(`${color}[${label}]${C.reset} ${line}\n`);
    }
  });
}

/* ---------------- 启动子进程 ---------------- */
const children = [];
let shuttingDown = false;
let startupFailed = false;

function startChild(label, labelColor, args, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout && prefixOutput(child.stdout, label, labelColor);
  child.stderr && prefixOutput(child.stderr, label, labelColor);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    startupFailed = true;
    console.log(
      `\n${C.red}[${label}] 进程已退出（code=${code}${signal ? `, signal=${signal}` : ''}）。` +
        `若为端口占用，请先结束占用进程或改用其它端口。${C.reset}`,
    );
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
    }
  }
  setTimeout(() => process.exit(code), 400);
}

process.on('SIGINT', () => {
  console.log(`\n${C.dim}收到 Ctrl+C，正在停止前后端…${C.reset}`);
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));

/* ---------------- 主流程 ---------------- */
const main = async () => {
  // 1. 端口预检
  const conflicts = [];
  if (await isPortBusy(API_PORT)) conflicts.push(`后端端口 ${API_PORT}`);
  if (await isPortBusy(WEB_PORT)) conflicts.push(`前端端口 ${WEB_PORT}`);
  if (conflicts.length) {
    console.error(`\n${C.red}✗ ${conflicts.join(' / ')} 已被占用。${C.reset}`);
    console.error(`  先结束占用进程，或改用其它端口：${C.bold}PORT=9000 WEB_PORT=5174 pnpm start${C.reset}\n`);
    process.exit(1);
  }

  console.log(`${C.dim}正在启动后端(${API_PORT}) 与 前端(${WEB_PORT})…${C.reset}\n`);
  startChild('api', C.blue, ['--disable-warning=ExperimentalWarning', 'scripts/dev-server.mjs', '--no-qr'], { PORT: String(API_PORT) });
  startChild('web', C.green, [path.join('node_modules', 'vite', 'bin', 'vite.js')], { PORT: String(API_PORT) });

  // 2. 等两个服务都就绪
  const [apiReady, webReady] = await Promise.all([
    waitFor(`http://127.0.0.1:${API_PORT}/api/health`),
    waitFor(`http://127.0.0.1:${WEB_PORT}/`),
  ]);
  if (!apiReady || !webReady || startupFailed) {
    if (!startupFailed) {
      console.error(`\n${C.red}✗ 启动超时：${!apiReady ? `后端(${API_PORT}) ` : ''}${!webReady ? `前端(${WEB_PORT})` : ''} 未就绪${C.reset}\n`);
    }
    shutdown(1);
    return;
  }

  // 3. 健康信息
  let health = null;
  try {
    health = await (await fetch(`http://127.0.0.1:${API_PORT}/api/health`)).json();
  } catch {
    /* 忽略 */
  }

  const lan = lanIPv4();
  const phoneURL = lan.length ? `http://${lan[0]}:${WEB_PORT}` : `http://localhost:${WEB_PORT}`;

  // 4. 横幅
  console.log('');
  console.log(`┌${'─'.repeat(62)}┐`);
  console.log(boxLine('基金助手 · fund-watch-web（前后端已启动）'));
  console.log(`├${'─'.repeat(62)}┤`);
  console.log(boxLine(`前端 React   http://localhost:${WEB_PORT}`));
  console.log(boxLine(`后端 API     http://localhost:${API_PORT}`));
  console.log(boxLine(`手机访问     ${phoneURL}`));
  if (health?.db) {
    console.log(boxLine(`数据库       ${health.db.persistent ? '✅ 持久化' : '⚠️ 临时'} · ${health.db.users} 用户 / ${health.db.watchlistItems} 条自选`));
    console.log(boxLine(`库路径       ${health.db.path.length > 46 ? '…' + health.db.path.slice(-45) : health.db.path}`));
  }
  console.log(boxLine('管理员       root / root（公开部署前请改密）'));
  console.log(boxLine('接口代理     /api/* 由前端 5173 转发到后端 8787'));
  console.log(boxLine('停止运行     Ctrl+C（前后端一起退出）'));
  console.log(`└${'─'.repeat(62)}┘`);
  console.log('');

  // 5. 手机扫码（扫码打开的是前端页面）
  if (!NO_QR) {
    if (lan.length) {
      console.log(`📱 手机扫码打开（需与电脑同一 Wi-Fi）：${C.dim}${phoneURL}${C.reset}\n`);
      try {
        console.log(toTerminal(phoneURL, { ecc: 'M' }));
      } catch (e) {
        console.log(`  (二维码生成失败: ${e.message})`);
      }
      console.log('');
    } else {
      console.log(`${C.yellow}⚠️ 未检测到局域网 IPv4 地址，手机可能无法访问${C.reset}\n`);
    }
  }

  if (OPEN) {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', `http://localhost:${WEB_PORT}`] : [`http://localhost:${WEB_PORT}`];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  }

  console.log(`${C.dim}──────── 以下为实时日志 ────────${C.reset}\n`);
};

main().catch((e) => {
  console.error(`${C.red}启动失败：${e.message}${C.reset}`);
  shutdown(1);
});
