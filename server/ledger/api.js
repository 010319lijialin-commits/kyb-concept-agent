// 进销账服务器接口（挂在 /api/ledger 下）：注册登录、账本成员和权限、同步单据。
// 权限在这里真正生效：页面上藏掉按钮只是方便，绕过页面直接调接口也写不进没权限的单据。
import express from 'express';
import { openDb, tx } from './db.js';
import { hashPassword, checkPassword, newToken, tokenHash, newId, newCode, tempPassword, rateLimiter } from './auth.js';
import {
  sanitize, LIST_KEYS, COLLECTIONS, normSettings, emptyState, ACCOUNT, saleRates, autoAllocate, autoAllocateNet, autoAllocatePayment,
} from '../../public/ledger/core.js';
import { ROLES, OWN_LISTS, effectivePerms, canWrite } from '../../public/ledger/roles.js';

const COOKIE = 'jxz_sid';
const SESSION_DAYS = 60;
const INVITE_DAYS = 7;
const MAX_CHANGES = 500;     // 一次最多传这么多笔，多了页面会分几次传
const PULL_PAGE = 2000;
const MAX_RECORD = 64 * 1024;
// 只记收付款的人：只拿得到自己记的这两种单据
const OWN_KINDS = ['receipts', 'payments'];
// 这几项没变，就保留原来的核销（老板手动调过的不被冲掉）
const MONEY = { receipts: ['date', 'customer', 'account', 'amount'], payments: ['date', 'supplier', 'account', 'amount'] };
const noAlloc = ({ allocations, ...x }) => x;

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };
const h = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

const PHONE = /^1\d{10}$/;
const cleanName = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const maskPhone = (p) => (p && p.length === 11 ? `${p.slice(0, 3)}****${p.slice(7)}` : p);

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// 日志里一笔单据的一句话描述
function summary(kind, d) {
  if (!d) return '';
  switch (kind) {
    case 'purchases': return `${d.date} ${d.supplier} ${d.product} ${d.qty}件 × ${d.price}`;
    case 'sales': return `${d.date} ${d.customer} ${d.product}（${d.supplier || ''}）${d.qty}件 × ${d.price}`;
    case 'receipts': return `${d.date} ${d.customer} 回款 ¥${d.amount}（${d.account === 'personal' ? '个人' : '公司'}）`;
    case 'payments': return `${d.date} 付 ${d.supplier} ¥${d.amount}（${d.account === 'company' ? '公司' : '个人'}）`;
    case 'withdrawals': return `${d.date} 从公司提现 ¥${d.net}`;
    case 'prices': return `${d.supplier} ${d.product} 售价 ¥${d.price}`;
    case 'settings': return `回款税点 ${+(d.revenueRate * 100).toFixed(4)}%，差价税率 ${+(d.marginRate * 100).toFixed(4)}%`;
    default: return '';
  }
}

// 传上来的一笔先洗一遍，返回要存的 JSON；不合格返回 { err }
function normalize(kind, key, data) {
  if (typeof key !== 'string' || !key || key.length > 300) return { err: 'bad-key' };
  if (data === null) return { del: true };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { err: 'bad-data' };
  let rec;
  if (COLLECTIONS.includes(kind)) {
    rec = sanitize({ [kind]: [data] }).state[kind][0];
    if (!rec || rec.id !== key) return { err: 'bad-data' };
  } else if (kind === 'prices') {
    rec = sanitize({ prices: [data] }).state.prices[0];
    if (!rec || `${rec.supplier}\u0001${rec.product}` !== key || !(rec.price >= 0)) return { err: 'bad-data' };
  } else if (kind === 'settings') {
    const n = normSettings(data);
    if (key !== 'settings' || !(n.revenueRate >= 0 && n.revenueRate < 1 && n.marginRate >= 0 && n.marginRate < 1)) return { err: 'bad-data' };
    rec = n;
  } else if (kind === 'lists') {
    const i = key.indexOf(':');
    const name = key.slice(i + 1);
    if (i < 0 || !LIST_KEYS.includes(key.slice(0, i)) || !name.trim() || name.length > 100) return { err: 'bad-key' };
    rec = {};
  } else return { err: 'bad-kind' };
  for (const f of ['_u', '_s', '_by', '_t']) delete rec[f];
  const json = JSON.stringify(rec);
  if (json.length > MAX_RECORD) return { err: 'too-big' };
  return { json };
}

// signupsPerHour：同一个 IP 一小时最多注册几个账号（一个办公室共用一个出口 IP，20 个够用）
export function ledgerApi({ dataDir, now = Date.now, log = console, signupsPerHour = 20 } = {}) {
  const db = openDb(dataDir);
  const loginLimit = rateLimiter({ max: 8, windowMs: 15 * 60e3, now });
  const signupLimit = rateLimiter({ max: signupsPerHour, windowMs: 60 * 60e3, now });
  const q = (sql) => db.prepare(sql);

  const S = {
    userByLogin: q('SELECT * FROM users WHERE login = ?'),
    userById: q('SELECT id, login, name FROM users WHERE id = ?'),
    passById: q('SELECT pass FROM users WHERE id = ?'),
    addUser: q('INSERT INTO users (id, login, name, pass, created_at) VALUES (?, ?, ?, ?, ?)'),
    setPass: q('UPDATE users SET pass = ? WHERE id = ?'),
    addSession: q('INSERT INTO sessions (token, user_id, created_at, seen_at) VALUES (?, ?, ?, ?)'),
    session: q('SELECT s.token, s.seen_at, u.id, u.login, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
    touchSession: q('UPDATE sessions SET seen_at = ? WHERE token = ?'),
    dropSession: q('DELETE FROM sessions WHERE token = ?'),
    dropUserSessions: q('DELETE FROM sessions WHERE user_id = ?'),
    dropOtherSessions: q('DELETE FROM sessions WHERE user_id = ? AND token != ?'),
    addLedger: q('INSERT INTO ledgers (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)'),
    ledger: q('SELECT * FROM ledgers WHERE id = ?'),
    renameLedger: q('UPDATE ledgers SET name = ? WHERE id = ?'),
    setSeq: q('UPDATE ledgers SET seq = ? WHERE id = ?'),
    myLedgers: q(`SELECT l.id, l.name, l.owner_id, m.role, m.perms, u.name AS owner_name,
      (SELECT COUNT(*) FROM members x WHERE x.ledger_id = l.id) AS member_count
      FROM members m JOIN ledgers l ON l.id = m.ledger_id JOIN users u ON u.id = l.owner_id
      WHERE m.user_id = ? ORDER BY m.joined_at`),
    member: q('SELECT * FROM members WHERE ledger_id = ? AND user_id = ?'),
    members: q(`SELECT m.user_id, m.role, m.perms, m.joined_at, u.name, u.login FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.ledger_id = ? ORDER BY m.joined_at`),
    addMember: q('INSERT INTO members (ledger_id, user_id, role, perms, joined_at) VALUES (?, ?, ?, ?, ?)'),
    setMember: q('UPDATE members SET role = ?, perms = ? WHERE ledger_id = ? AND user_id = ?'),
    dropMember: q('DELETE FROM members WHERE ledger_id = ? AND user_id = ?'),
    memberships: q('SELECT ledger_id FROM members WHERE user_id = ?'),
    // 记过账、后来被移出的人：列表里还要显示是谁记的
    former: q(`SELECT u.id, u.name FROM users u WHERE u.id IN (SELECT DISTINCT created_by FROM records WHERE ledger_id = ?)
      AND u.id NOT IN (SELECT user_id FROM members WHERE ledger_id = ?)`),
    addInvite: q('INSERT INTO invites (code, ledger_id, role, perms, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    invite: q(`SELECT i.*, l.name AS ledger_name, u.name AS inviter FROM invites i JOIN ledgers l ON l.id = i.ledger_id
      JOIN users u ON u.id = i.created_by WHERE i.code = ?`),
    invites: q(`SELECT i.code, i.role, i.perms, i.created_at, i.expires_at, u.name AS inviter FROM invites i JOIN users u ON u.id = i.created_by
      WHERE i.ledger_id = ? AND i.used_by IS NULL AND i.expires_at > ? ORDER BY i.created_at DESC`),
    useInvite: q('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL'),
    dropInvite: q('DELETE FROM invites WHERE code = ? AND ledger_id = ?'),
    record: q('SELECT data, seq, created_by, updated_at FROM records WHERE ledger_id = ? AND kind = ? AND key = ?'),
    putRecord: q(`INSERT INTO records (ledger_id, kind, key, data, seq, created_by, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (ledger_id, kind, key) DO UPDATE SET data = excluded.data, seq = excluded.seq, created_by = excluded.created_by,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`),
    pull: q('SELECT kind, key, data, seq, created_by, updated_at FROM records WHERE ledger_id = ? AND seq > ? ORDER BY seq LIMIT ?'),
    pullOwn: q(`SELECT kind, key, data, seq, created_by, updated_at FROM records WHERE ledger_id = ? AND seq > ?
      AND ((kind IN (${OWN_KINDS.map((k) => `'${k}'`).join(', ')}) AND created_by = ?)
        OR (kind = 'lists' AND (${OWN_LISTS.map((k) => `key LIKE '${k}:%'`).join(' OR ')})))
      ORDER BY seq LIMIT ?`),
    allRecords: q("SELECT kind, data FROM records WHERE ledger_id = ? AND data IS NOT NULL AND kind != 'lists'"),
    addLog: q('INSERT INTO log (ledger_id, user_id, at, kind, key, action, summary) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    log: q(`SELECT g.id, g.at, g.kind, g.key, g.action, g.summary, u.name AS user_name FROM log g LEFT JOIN users u ON u.id = g.user_id
      WHERE g.ledger_id = ? AND g.id < ? ORDER BY g.id DESC LIMIT ?`),
  };

  const r = express.Router();
  r.use(express.json({ limit: '5mb' }));
  r.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // 防跨站：改数据的请求必须是 JSON，而且从同一个网站发来
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!req.is('application/json')) return res.status(415).json({ error: '请求格式不对' });
      const origin = req.get('origin');
      if (origin) {
        let host = '';
        try { host = new URL(origin).host; } catch { /* 坏的 Origin 当成跨站 */ }
        if (host !== req.get('host')) return res.status(403).json({ error: '不允许从别的网站调用' });
      }
    }
    next();
  });

  // 认出是谁
  r.use((req, _res, next) => {
    const t = readCookie(req, COOKIE);
    if (!t) return next();
    const row = S.session.get(tokenHash(t));
    if (!row) return next();
    if (now() - row.seen_at > SESSION_DAYS * 86400e3) { S.dropSession.run(row.token); return next(); }
    if (now() - row.seen_at > 3600e3) S.touchSession.run(now(), row.token);
    req.user = { id: row.id, login: row.login, name: row.name };
    req.token = row.token;
    next();
  });

  const setCookie = (req, res, token, maxAge = SESSION_DAYS * 86400) => {
    const secure = req.secure ? '; Secure' : '';
    res.set('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
  };
  const startSession = (req, res, userId) => {
    const token = newToken();
    S.addSession.run(tokenHash(token), userId, now(), now());
    setCookie(req, res, token);
  };
  const needUser = (req) => req.user || fail(401, '请先登录');
  const needMember = (req) => {
    const u = needUser(req);
    const ledger = S.ledger.get(req.params.lid);
    const m = ledger && S.member.get(ledger.id, u.id);
    if (!m) fail(403, '你不在这个账本里了');
    return { u, ledger, m, perms: effectivePerms(m.role) };
  };
  const needManager = (req) => {
    const ctx = needMember(req);
    if (!ctx.perms.manage) fail(403, '只有全部权限的人能管成员');
    return ctx;
  };

  const checkPw = (pw) => {
    const p = String(pw ?? '');
    if (p.length < 6 || p.length > 64) fail(400, '密码要 6 到 64 位');
    return p;
  };
  function me(user) {
    return {
      user: { id: user.id, phone: user.login, name: user.name },
      ledgers: S.myLedgers.all(user.id).map((l) => ({
        id: l.id, name: l.name, role: l.role, roleLabel: ROLES[l.role]?.label || l.role,
        perms: effectivePerms(l.role),
        owner: { id: l.owner_id, name: l.owner_name }, memberCount: l.member_count,
      })),
    };
  }

  function validInvite(code) {
    const inv = S.invite.get(String(code || '').trim().toUpperCase());
    if (!inv) fail(404, '邀请码不对');
    if (inv.used_by) fail(410, '这个邀请码已经用过了，请老板重新发一个');
    if (inv.expires_at < now()) fail(410, '这个邀请码过期了，请老板重新发一个');
    return inv;
  }
  function joinLedger(inv, userId) {
    if (S.member.get(inv.ledger_id, userId)) fail(409, '你已经在这个账本里了');
    if (S.useInvite.run(userId, now(), inv.code).changes !== 1) fail(410, '这个邀请码已经用过了');
    S.addMember.run(inv.ledger_id, userId, inv.role, inv.perms, now());
  }

  r.get('/ping', (_req, res) => res.json({ ok: true, app: 'jinxiaozhang' }));

  r.post('/auth/register', h(async (req, res) => {
    const phone = String(req.body.phone || '').trim();
    const name = cleanName(req.body.name);
    const pw = checkPw(req.body.password);
    if (!PHONE.test(phone)) fail(400, '手机号要 11 位数字');
    if (!name || name.length > 20) fail(400, '名字要填，最多 20 个字');
    if (signupLimit.blocked(req.ip)) fail(429, '注册太频繁，过一会儿再试');
    signupLimit.hit(req.ip);
    const inv = req.body.invite ? validInvite(req.body.invite) : null;
    if (S.userByLogin.get(phone)) fail(409, '这个手机号已经注册过了，直接登录');
    const pass = await hashPassword(pw);
    const id = newId();
    tx(db, () => {
      S.addUser.run(id, phone, name, pass, now());
      if (inv) joinLedger(inv, id);
      else {
        const lid = newId();
        S.addLedger.run(lid, `${name}的账本`, id, now());
        S.addMember.run(lid, id, 'owner', null, now());
      }
    });
    startSession(req, res, id);
    res.json(me({ id, login: phone, name }));
  }));

  r.post('/auth/login', h(async (req, res) => {
    const phone = String(req.body.phone || '').trim();
    const key = `${req.ip}|${phone}`;
    if (loginLimit.blocked(key)) fail(429, '密码错的次数太多，15 分钟后再试');
    const u = S.userByLogin.get(phone);
    const ok = await checkPassword(req.body.password, u?.pass || 's1$AAAA$AAAA');
    if (!u || !ok) { loginLimit.hit(key); fail(401, '手机号或密码不对'); }
    loginLimit.reset(key);
    startSession(req, res, u.id);
    res.json(me(u));
  }));

  r.post('/auth/logout', (req, res) => {
    if (req.token) S.dropSession.run(req.token);
    setCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  r.post('/auth/password', h(async (req, res) => {
    const u = needUser(req);
    const pw = checkPw(req.body.password);
    if (!(await checkPassword(req.body.old, S.passById.get(u.id).pass))) fail(400, '原来的密码不对');
    S.setPass.run(await hashPassword(pw), u.id);
    S.dropOtherSessions.run(u.id, req.token); // 别的设备上要重新登录
    res.json({ ok: true });
  }));

  r.get('/me', (req, res) => res.json(me(needUser(req))));

  // 打开邀请链接时先看看是哪个账本（不用登录）
  r.get('/invite/:code', (req, res) => {
    const inv = validInvite(req.params.code);
    res.json({ ledger: inv.ledger_name, inviter: inv.inviter, role: inv.role, roleLabel: ROLES[inv.role]?.label, roleNote: ROLES[inv.role]?.note });
  });

  r.post('/join', (req, res) => {
    const u = needUser(req);
    const inv = validInvite(req.body.code);
    tx(db, () => joinLedger(inv, u.id));
    res.json({ ...me(u), joined: inv.ledger_id });
  });

  // 再建一本自己的账本（比如被移出了所有账本，或者想单独记一本）
  r.post('/ledgers', (req, res) => {
    const u = needUser(req);
    const name = cleanName(req.body.name) || `${u.name}的账本`;
    if (name.length > 30) fail(400, '账本名字最多 30 个字');
    if (S.myLedgers.all(u.id).filter((l) => l.owner_id === u.id).length >= 10) fail(400, '自己建的账本最多 10 本');
    const lid = newId();
    tx(db, () => {
      S.addLedger.run(lid, name, u.id, now());
      S.addMember.run(lid, u.id, 'owner', null, now());
    });
    res.json({ ...me(u), created: lid });
  });

  r.patch('/l/:lid', (req, res) => {
    const { ledger } = needManager(req);
    const name = cleanName(req.body.name);
    if (!name || name.length > 30) fail(400, '账本名字要填，最多 30 个字');
    S.renameLedger.run(name, ledger.id);
    res.json({ ok: true });
  });

  r.get('/l/:lid/members', (req, res) => {
    const { ledger, perms, u } = needMember(req);
    const own = perms.view === 'own'; // 只记收付款的人只看得到自己
    res.json({
      members: S.members.all(ledger.id).filter((m) => !own || m.user_id === u.id).map((m) => ({
        id: m.user_id, name: m.name, role: m.role, roleLabel: ROLES[m.role]?.label || m.role,
        phone: perms.manage ? m.login : maskPhone(m.login),
        perms: effectivePerms(m.role), joinedAt: m.joined_at,
      })),
      former: own ? [] : S.former.all(ledger.id, ledger.id).map((x) => ({ id: x.id, name: x.name })),
    });
  });

  r.post('/l/:lid/invites', (req, res) => {
    const { ledger, m } = needManager(req);
    const role = String(req.body.role || '');
    if (!ROLES[role] || role === 'owner') fail(400, '选一个身份');
    if (role === 'admin' && m.role !== 'owner') fail(403, '只有老板能邀请全部权限的人');
    const code = newCode();
    S.addInvite.run(code, ledger.id, role, null, m.user_id, now(), now() + INVITE_DAYS * 86400e3);
    res.json({ code, expiresAt: now() + INVITE_DAYS * 86400e3 });
  });

  r.get('/l/:lid/invites', (req, res) => {
    const { ledger } = needManager(req);
    res.json({ invites: S.invites.all(ledger.id, now()).map((i) => ({ code: i.code, role: i.role, roleLabel: ROLES[i.role]?.label, inviter: i.inviter, expiresAt: i.expires_at })) });
  });

  r.delete('/l/:lid/invites/:code', (req, res) => {
    const { ledger } = needManager(req);
    S.dropInvite.run(req.params.code, ledger.id);
    res.json({ ok: true });
  });

  // 改成员身份。老板不能被改；「全部权限」只有老板能给、能改
  function target(req, ctx) {
    const t = S.member.get(ctx.ledger.id, req.params.uid);
    if (!t) fail(404, '这个人不在账本里');
    if (t.role === 'owner') fail(403, '老板的身份不能改');
    if (t.role === 'admin' && ctx.m.role !== 'owner') fail(403, '只有老板能改全部权限的人');
    return t;
  }
  r.patch('/l/:lid/members/:uid', (req, res) => {
    const ctx = needManager(req);
    const t = target(req, ctx);
    const role = String(req.body.role || t.role);
    if (!ROLES[role] || role === 'owner') fail(400, '选一个身份');
    if (role === 'admin' && ctx.m.role !== 'owner') fail(403, '只有老板能给全部权限');
    S.setMember.run(role, null, ctx.ledger.id, t.user_id);
    res.json({ ok: true });
  });

  r.delete('/l/:lid/members/:uid', (req, res) => {
    const u = needUser(req);
    if (req.params.uid === u.id) {
      // 自己退出
      const { m, ledger } = needMember(req);
      if (m.role === 'owner') fail(403, '老板不能退出自己的账本');
      S.dropMember.run(ledger.id, u.id);
      return res.json({ ok: true });
    }
    const ctx = needManager(req);
    const t = target(req, ctx);
    S.dropMember.run(ctx.ledger.id, t.user_id);
    res.json({ ok: true });
  });

  // 成员忘了密码：全部权限的人给一个临时密码。这个人如果还在别人的账本里，就不能这样重置（免得能登进别人的账本）
  r.post('/l/:lid/members/:uid/reset-password', h(async (req, res) => {
    const ctx = needManager(req);
    const t = target(req, ctx);
    for (const { ledger_id } of S.memberships.all(t.user_id)) {
      const mine = S.member.get(ledger_id, ctx.u.id);
      const p = mine && effectivePerms(mine.role);
      if (!p?.manage) fail(403, '这个人还在别的账本里，只能让他自己改密码，或者在服务器上重置');
    }
    const pw = tempPassword();
    S.setPass.run(await hashPassword(pw), t.user_id);
    S.dropUserSessions.run(t.user_id);
    res.json({ password: pw });
  }));

  // ---------- 同步 ----------
  // view：这个人看得到多少（'all' / 'own'）。身份变了，页面会把本机的账清掉按新的范围重新拉
  r.get('/l/:lid/pull', (req, res) => {
    const { ledger, perms, u } = needMember(req);
    const own = perms.view === 'own';
    const since = Math.max(0, parseInt(req.query.since, 10) || 0);
    if (since > ledger.seq) return res.json({ reset: true, seq: ledger.seq, view: perms.view, changes: [] });
    // 只记收付款的人：只发他自己记的回款、付款（不带核销到哪几批货），加上公司名、厂家名
    const rows = own ? S.pullOwn.all(ledger.id, since, u.id, PULL_PAGE + 1) : S.pull.all(ledger.id, since, PULL_PAGE + 1);
    const more = rows.length > PULL_PAGE;
    const page = rows.slice(0, PULL_PAGE);
    res.json({
      seq: more ? page.at(-1).seq : ledger.seq,
      more,
      view: perms.view,
      changes: page.map((x) => {
        let data = x.data == null ? null : JSON.parse(x.data);
        if (own && data && OWN_KINDS.includes(x.kind)) data = noAlloc(data);
        return { kind: x.kind, key: x.key, data, seq: x.seq, by: x.created_by, t: x.updated_at };
      }),
    });
  });

  // 整本账（核销要用）
  function loadState(lid) {
    const st = emptyState();
    for (const row of S.allRecords.all(lid)) {
      const d = JSON.parse(row.data);
      if (COLLECTIONS.includes(row.kind)) st[row.kind].push(d);
      else if (row.kind === 'prices') st.prices.push(d);
      else if (row.kind === 'settings') st.settings = d;
    }
    return st;
  }

  r.post('/l/:lid/push', (req, res) => {
    const { ledger, u, perms } = needMember(req);
    const changes = req.body.changes;
    if (!Array.isArray(changes) || changes.length > MAX_CHANGES) fail(400, `一次最多传 ${MAX_CHANGES} 笔`);
    const own = perms.view === 'own';
    // 只记收付款的人看不到销售和进货：他记的回款、付款由服务器按先进先出核销（老板之后可以改）
    let state = null, rates = null;
    const withAllocations = (kind, rec, prev) => {
      if (prev && MONEY[kind].every((f) => prev[f] === rec[f])) return { ...rec, allocations: prev.allocations || [] };
      state ||= loadState(ledger.id);
      if (kind === 'payments') return { ...rec, allocations: autoAllocatePayment(state, rec.supplier, rec.amount, rec.id) };
      rates ||= saleRates(state);
      const fn = rec.account === ACCOUNT.PERSONAL ? autoAllocateNet : autoAllocate;
      return { ...rec, allocations: fn(state, rec.customer, rec.amount, rec.id, rates) };
    };
    const track = (kind, key, rec) => {
      if (!state || !COLLECTIONS.includes(kind)) return;
      state[kind] = state[kind].filter((x) => x.id !== key);
      if (rec) state[kind].push(rec);
    };
    const out = tx(db, () => {
      let seq = S.ledger.get(ledger.id).seq;
      const t = now();
      const results = changes.map((ch) => {
        const kind = String(ch?.kind || '');
        const key = ch?.key;
        const cur = typeof key === 'string' ? S.record.get(ledger.id, kind, key) : null;
        // 拒收时带上服务器上的版本好让页面恢复；只记收付款的人只能拿到他自己记的那几笔
        const visible = cur && (!own || (OWN_KINDS.includes(kind) && cur.created_by === u.id) || (kind === 'lists' && canWrite(perms, kind, key)));
        const current = visible ? { data: cur.data == null ? null : (own && OWN_KINDS.includes(kind) ? noAlloc(JSON.parse(cur.data)) : JSON.parse(cur.data)), seq: cur.seq, by: cur.created_by, t: cur.updated_at } : null;
        const reject = (reason) => ({ ok: false, reason, current });
        const n = normalize(kind, key, ch?.data ?? null);
        if (n.err) return reject(n.err);
        if (!canWrite(perms, kind, key)) return reject('no-permission');
        const exists = cur && cur.data != null;
        // 别人记的单据：要有「能改别人记的」权限
        if (exists && COLLECTIONS.includes(kind) && cur.created_by !== u.id && !perms.editOthers) return reject('not-yours');
        if (n.del) {
          if (!exists) return { ok: true, seq: cur?.seq || 0, by: cur?.created_by, t: cur?.updated_at };
          seq++;
          S.putRecord.run(ledger.id, kind, key, null, seq, cur.created_by, u.id, t);
          track(kind, key, null);
          if (kind !== 'lists') S.addLog.run(ledger.id, u.id, t, kind, key, 'delete', summary(kind, JSON.parse(cur.data)));
          return { ok: true, seq, by: cur.created_by, t };
        }
        let json = n.json;
        if (own && OWN_KINDS.includes(kind)) {
          const rec = withAllocations(kind, JSON.parse(n.json), exists ? JSON.parse(cur.data) : null);
          json = JSON.stringify(rec);
        }
        if (exists && cur.data === json) return { ok: true, seq: cur.seq, by: cur.created_by, t: cur.updated_at };
        seq++;
        const by = exists ? cur.created_by : u.id;
        S.putRecord.run(ledger.id, kind, key, json, seq, by, u.id, t);
        track(kind, key, JSON.parse(json));
        if (kind !== 'lists') S.addLog.run(ledger.id, u.id, t, kind, key, exists ? 'update' : 'create', summary(kind, JSON.parse(json)));
        return { ok: true, seq, by, t };
      });
      S.setSeq.run(seq, ledger.id);
      return { results, seq };
    });
    res.json(out);
  });

  r.get('/l/:lid/log', (req, res) => {
    const { ledger } = needManager(req);
    const before = parseInt(req.query.before, 10) || Number.MAX_SAFE_INTEGER;
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    res.json({ log: S.log.all(ledger.id, before, limit).map((g) => ({ id: g.id, at: g.at, user: g.user_name, kind: g.kind, action: g.action, summary: g.summary })) });
  });

  r.use((req, res) => res.status(404).json({ error: '没有这个接口' }));
  // eslint-disable-next-line no-unused-vars
  r.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '请求格式不对' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: '一次传的太多了' });
    log.error?.(err);
    res.status(500).json({ error: '服务器出错了，稍后再试' });
  });

  r.db = db;
  return r;
}
