// 数据库运维工具：查看状态 / 备份 / 强制落盘
// 用法：
//   node scripts/db-tool.mjs info        # 查看路径、是否持久化、数据量、文件大小
//   node scripts/db-tool.mjs checkpoint  # 把 WAL 合并回主库（单文件即完整数据）
//   node scripts/db-tool.mjs backup [目标路径]   # 生成一致性快照（默认 data/backups/fundwatch-<时间>.db）
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { dbInfo, checkpoint, backupTo, closeDb } = require('../server/db.cjs');

const cmd = (process.argv[2] || 'info').toLowerCase();
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

function printInfo() {
  const i = dbInfo();
  console.log('');
  console.log('📦 FundWatch 数据库状态');
  console.log('──────────────────────────────────────────────');
  console.log(`  路径      ${i.path}`);
  console.log(`  持久化    ${i.persistent ? '✅ 是（重启不丢数据）' : '⚠️  否（临时目录，重启会丢数据）'}`);
  console.log(`  主库文件  ${kb(i.fileSize)}`);
  console.log(`  WAL 文件  ${kb(i.walSize)}${i.walSize > 0 ? '（建议执行 checkpoint 合并）' : '（已合并）'}`);
  console.log(`  用户数    ${i.users}（管理员 ${i.admins}）`);
  console.log(`  自选条数  ${i.watchlistItems}`);
  console.log(`  活跃会话  ${i.activeSessions}`);
  console.log('──────────────────────────────────────────────');
  if (!i.persistent) {
    console.log('⚠️  当前库在临时目录，进程退出即可能被清理。');
    console.log('   请设置 DB_PATH 指向持久化目录后重启，例如：');
    console.log(`   DB_PATH=${path.join(ROOT, 'data', 'fundwatch.db')} node scripts/dev-server.mjs`);
  }
  console.log('');
}

try {
  if (cmd === 'info') {
    printInfo();
  } else if (cmd === 'checkpoint') {
    checkpoint();
    console.log('✅ 已执行 WAL checkpoint，数据已合并到主库文件');
    printInfo();
  } else if (cmd === 'backup') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = process.argv[3] || path.join(ROOT, 'data', 'backups', `fundwatch-${stamp}.db`);
    const saved = backupTo(target);
    console.log(`✅ 备份完成：${saved}`);
    console.log(`   大小：${kb(fs.statSync(saved).size)}（一致性快照，可直接用于恢复/迁移）`);
    console.log(`   恢复方式：停服后用该文件覆盖 DB_PATH 指向的数据库文件即可`);
  } else {
    console.log('用法：node scripts/db-tool.mjs [info|checkpoint|backup] [备份目标路径]');
    process.exitCode = 1;
  }
} catch (e) {
  console.error('❌ 执行失败：', e.message);
  process.exitCode = 1;
} finally {
  closeDb();
}
