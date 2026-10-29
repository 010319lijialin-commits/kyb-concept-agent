// 进销账服务器的数据都在一个 SQLite 文件里（DATA_DIR/ledger.db）。备份就是复制这个文件，
// 或者用 `node ledger-admin.js backup` 在不停服务的情况下导出一份。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,          -- 登录用的手机号
  name TEXT NOT NULL,                  -- 同事看到的名字
  pass TEXT NOT NULL,                  -- scrypt 哈希
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,              -- 登录凭证的 sha256，数据库泄露了也拿不到能用的凭证
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledgers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  seq INTEGER NOT NULL DEFAULT 0,      -- 每改一笔加 1，同步时按它找「上次之后改了什么」
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  perms TEXT,                          -- 老板单独勾的权限（JSON），没有就按身份
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (ledger_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  perms TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by TEXT,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS records (
  ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                  -- purchases / sales / receipts / payments / withdrawals / prices / settings / lists
  key TEXT NOT NULL,                   -- 单据编号；价目表是「厂家\\u0001药」；下拉单是「类别:名字」
  data TEXT,                           -- JSON；NULL 表示删掉了（留着这一行，别的设备才知道要删）
  seq INTEGER NOT NULL,
  created_by TEXT,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ledger_id, kind, key)
);
CREATE INDEX IF NOT EXISTS records_seq ON records(ledger_id, seq);
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  action TEXT NOT NULL,                -- create / update / delete
  summary TEXT
);
CREATE INDEX IF NOT EXISTS log_ledger ON log(ledger_id, id);
`;

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'ledger.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

// 一组写操作要么全成要么全不成
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
