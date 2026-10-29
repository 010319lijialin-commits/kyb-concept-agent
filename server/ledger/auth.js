// 登录：手机号 + 密码。密码用 scrypt 加盐哈希存；登录凭证是随机串，放在 HttpOnly cookie 里，
// 数据库只存它的 sha256。没有短信验证码（要另外接短信服务），忘了密码由老板 / 管理员重置，
// 老板自己忘了，在服务器上跑 `node ledger-admin.js reset-password 手机号`。
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(pw), salt, 64, SCRYPT);
  return `s1$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function checkPassword(pw, stored) {
  const [v, salt, hash] = String(stored || '').split('$');
  if (v !== 's1' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(String(pw), Buffer.from(salt, 'base64'), want.length, SCRYPT);
  return crypto.timingSafeEqual(got, want);
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('base64url');
export const newId = () => crypto.randomBytes(9).toString('base64url');

// 邀请码：去掉容易看错的 0/O、1/I/L
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newCode(len = 8) {
  const b = crypto.randomBytes(len);
  return Array.from(b, (x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
}

// 老板重置成员密码时给的临时密码
export function tempPassword() {
  return newCode(4).toLowerCase() + String(crypto.randomInt(1000, 10000));
}

// 失败次数太多先挡一会儿：同一个 IP + 手机号 15 分钟内最多错 8 次
export function rateLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  return {
    blocked(key) {
      const h = hits.get(key);
      if (!h) return false;
      if (now() - h.start > windowMs) { hits.delete(key); return false; }
      return h.count >= max;
    },
    hit(key) {
      const h = hits.get(key);
      if (!h || now() - h.start > windowMs) hits.set(key, { start: now(), count: 1 });
      else h.count++;
      if (hits.size > 10000) for (const [k, v] of hits) if (now() - v.start > windowMs) hits.delete(k);
    },
    reset(key) { hits.delete(key); },
  };
}
