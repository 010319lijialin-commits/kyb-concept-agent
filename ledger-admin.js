// 进销账服务器的维护命令（在服务器上跑）：
//   node ledger-admin.js users                      看所有账号和账本
//   node ledger-admin.js reset-password 手机号       给这个账号一个临时密码（老板自己忘了密码时用）
//   node ledger-admin.js backup [文件名]             不停服务导出一份完整的数据库备份
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './server/ledger/db.js';
import { hashPassword, tempPassword } from './server/ledger/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = openDb(process.env.DATA_DIR || path.join(__dirname, 'data'));
const [cmd, arg] = process.argv.slice(2);

if (cmd === 'users') {
  const rows = db.prepare(`SELECT u.login, u.name, l.name AS ledger, m.role FROM users u
    LEFT JOIN members m ON m.user_id = u.id LEFT JOIN ledgers l ON l.id = m.ledger_id ORDER BY u.created_at`).all();
  for (const r of rows) console.log(`${r.login}\t${r.name}\t${r.ledger ?? '-'}\t${r.role ?? '-'}`);
} else if (cmd === 'reset-password' && arg) {
  const u = db.prepare('SELECT id, name FROM users WHERE login = ?').get(arg);
  if (!u) { console.error('没有这个手机号'); process.exit(1); }
  const pw = tempPassword();
  db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(await hashPassword(pw), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  console.log(`${u.name} 的临时密码：${pw}（登录后在「设置 → 账号」里改掉）`);
} else if (cmd === 'backup') {
  const file = path.resolve(arg || `ledger-backup-${new Date().toISOString().slice(0, 10)}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  console.log(`已备份到 ${file}`);
} else {
  console.log('用法：node ledger-admin.js users | reset-password 手机号 | backup [文件名]');
  process.exit(cmd ? 1 : 0);
}
