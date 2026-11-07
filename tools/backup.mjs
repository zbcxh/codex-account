// 把活库一致性快照导出到 NAS/备份盘：VACUUM INTO 会带上 WAL 内容，直接拷 .sqlite3 会损坏。
// 用法：node --no-warnings tools/backup.mjs [--db server/data/quota.sqlite3] --to \\nas\codex-quota\quota.db
//       目标已存在时默认报错；加 --rotate 会写成 quota-YYYYMMDD.db 并只保留最近 14 份。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : dflt;
};

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:\/)/, '$1'));
const ROOT = path.dirname(HERE);
const dbPath = arg('--db', path.join(ROOT, 'server', 'data', 'quota.sqlite3'));
const to = arg('--to');
const rotate = process.argv.includes('--rotate');
const keep = Number(arg('--keep', 14));

if (!to) {
  console.error('必须给 --to <目标 .db 路径>，例如 --to \\\\nas\\codex-quota\\quota.db');
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  console.error(`找不到数据库：${dbPath}`);
  process.exit(1);
}

let target = to;
if (rotate) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const dir = path.dirname(to);
  target = path.join(dir, `${path.basename(to, path.extname(to))}-${stamp}${path.extname(to)}`);
}

if (fs.existsSync(target)) {
  if (!rotate) {
    console.error(`目标已存在：${target}\n要覆盖请先删除，或用 --rotate 按日期分文件。`);
    process.exit(1);
  }
  fs.rmSync(target);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
const db = new DatabaseSync(dbPath, { readOnly: true });
// VACUUM INTO 的目标必须不存在，所以先删再导。
db.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'");
db.close();

const rows = new DatabaseSync(target, { readOnly: true });
const snap = rows.prepare('SELECT COUNT(*) c FROM quota_snapshot').get().c;
const machines = rows.prepare('SELECT COUNT(*) c FROM machine').get().c;
rows.close();
console.log(`已导出 ${target}  (${Math.round(fs.statSync(target).size / 1024)} KB, ${machines} 台机器, ${snap} 条快照)`);

if (rotate) {
  const dir = path.dirname(to);
  const base = path.basename(to, path.extname(to));
  const all = fs.readdirSync(dir)
    .filter((f) => f.startsWith(base + '-') && f.endsWith(path.extname(to)))
    .sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) {
    fs.rmSync(path.join(dir, old));
    console.log(`清理旧备份 ${old}`);
  }
}
