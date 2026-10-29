import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { ledgerApi } from '../server/ledger/api.js';

let server, base, dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxz-'));
  const app = express();
  app.use('/api/ledger', ledgerApi({ dataDir: dir, log: { error() {} }, signupsPerHour: 1000 }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/ledger`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// 一个「浏览器」：自己带 cookie
function client() {
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    return { status: res.status, body: await res.json(), setCookie: sc };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b = {}, hd) => call('POST', p, b, hd),
    patch: (p, b = {}) => call('PATCH', p, b),
    del: (p) => call('DELETE', p, {}),
    raw: call,
  };
}
let phoneN = 13800000000;
const nextPhone = () => String(phoneN++);
async function signup(name, extra = {}) {
  const c = client();
  const phone = nextPhone();
  const r = await c.post('/auth/register', { phone, name, password: 'secret12', ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  c.me = r.body; c.phone = phone;
  return c;
}
const rec = (id, extra = {}) => ({ kind: 'sales', key: id, data: { id, date: '2026-10-01', supplier: 'S', product: '甲', customer: 'C', qty: 1, price: 1.5, ...extra } });

test('注册就有一本自己的账本，是老板；登录、退出、cookie 安全属性', async () => {
  const c = await signup('张三');
  assert.equal(c.me.ledgers.length, 1);
  assert.equal(c.me.ledgers[0].name, '张三的账本');
  assert.equal(c.me.ledgers[0].role, 'owner');
  const again = client();
  const r = await again.post('/auth/login', { phone: c.phone, password: 'secret12' });
  assert.equal(r.status, 200);
  assert.match(r.setCookie, /HttpOnly/);
  assert.match(r.setCookie, /SameSite=Lax/);
  assert.equal((await again.get('/me')).body.user.name, '张三');
  await again.post('/auth/logout');
  assert.equal((await again.get('/me')).status, 401);
  assert.equal((await c.get('/me')).status, 200, '退出一台设备不影响别的');
});

test('注册 / 登录的各种错误', async () => {
  const c = client();
  assert.equal((await c.post('/auth/register', { phone: '123', name: 'a', password: 'secret12' })).status, 400);
  assert.equal((await c.post('/auth/register', { phone: nextPhone(), name: 'a', password: '123' })).status, 400);
  const u = await signup('李四');
  assert.equal((await c.post('/auth/register', { phone: u.phone, name: 'b', password: 'secret12' })).status, 409);
  assert.equal((await c.post('/auth/login', { phone: u.phone, password: 'wrong' })).status, 401);
  assert.equal((await c.post('/auth/login', { phone: '13999999999', password: 'wrong' })).status, 401);
});

test('同一个 IP 注册太多先挡住', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jxz-'));
  const app = express();
  app.use('/api/ledger', ledgerApi({ dataDir: d, signupsPerHour: 2 }));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}/api/ledger/auth/register`;
  const codes = [];
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: nextPhone(), name: 'x', password: 'secret12' }) });
    codes.push(r.status);
  }
  srv.close(); fs.rmSync(d, { recursive: true, force: true });
  assert.deepEqual(codes, [200, 200, 429]);
});

test('密码错太多次先挡住', async () => {
  const u = await signup('王五');
  const c = client();
  for (let i = 0; i < 8; i++) await c.post('/auth/login', { phone: u.phone, password: 'x' });
  const r = await c.post('/auth/login', { phone: u.phone, password: 'secret12' });
  assert.equal(r.status, 429);
});

test('跨站请求、不是 JSON 的写请求被拦下', async () => {
  const u = await signup('赵六');
  const lid = u.me.ledgers[0].id;
  const r1 = await u.post(`/l/${lid}/push`, { changes: [rec('x')] }, { Origin: 'https://evil.example' });
  assert.equal(r1.status, 403);
  const r2 = await u.raw('POST', `/l/${lid}/push`, undefined, { 'Content-Type': 'text/plain' });
  assert.equal(r2.status, 415);
});

test('邀请同事：邀请码注册就进了老板的账本；用过的码不能再用', async () => {
  const boss = await signup('老板');
  const lid = boss.me.ledgers[0].id;
  const inv = await boss.post(`/l/${lid}/invites`, { role: 'sales' });
  assert.equal(inv.status, 200);
  const info = await client().get(`/invite/${inv.body.code}`);
  assert.equal(info.body.ledger, '老板的账本');
  assert.equal(info.body.roleLabel, '业务员');
  const s = await signup('小王', { invite: inv.body.code.toLowerCase() });
  assert.equal(s.me.ledgers.length, 1, '用邀请码注册的不另建账本');
  assert.equal(s.me.ledgers[0].id, lid);
  assert.equal(s.me.ledgers[0].role, 'sales');
  const third = client();
  const r = await third.post('/auth/register', { phone: nextPhone(), name: '小李', password: 'secret12', invite: inv.body.code });
  assert.equal(r.status, 410);
  // 已经有账号的人用邀请码加入
  const inv2 = await boss.post(`/l/${lid}/invites`, { role: 'viewer' });
  const other = await signup('别家老板');
  const j = await other.post('/join', { code: inv2.body.code });
  assert.equal(j.status, 200);
  assert.equal(j.body.ledgers.length, 2);
  assert.equal((await other.post('/join', { code: inv2.body.code })).status, 410);
});

test('同步：两个人记同一本账，互相拉得到；删掉的也同步', async () => {
  const boss = await signup('老板A');
  const lid = boss.me.ledgers[0].id;
  const inv = await boss.post(`/l/${lid}/invites`, { role: 'clerk' });
  const clerk = await signup('记账员A', { invite: inv.body.code });
  const p1 = await boss.post(`/l/${lid}/push`, { changes: [rec('b1'), { kind: 'lists', key: 'customers:医院', data: {} }, { kind: 'prices', key: 'S\u0001甲', data: { supplier: 'S', product: '甲', price: 1.5 } }] });
  assert.deepEqual(p1.body.results.map((x) => x.ok), [true, true, true]);
  const p2 = await clerk.post(`/l/${lid}/push`, { changes: [rec('c1')] });
  assert.ok(p2.body.results[0].ok);
  const all = await boss.get(`/l/${lid}/pull?since=0`);
  assert.deepEqual(all.body.changes.map((x) => x.key).sort(), ['S\u0001甲', 'b1', 'c1', 'customers:医院']);
  assert.equal(all.body.changes.find((x) => x.key === 'c1').by, clerk.me.user.id);
  const seq = all.body.seq;
  await boss.post(`/l/${lid}/push`, { changes: [{ kind: 'sales', key: 'c1', data: null }] });
  const inc = await clerk.get(`/l/${lid}/pull?since=${seq}`);
  assert.deepEqual(inc.body.changes.map((x) => [x.key, x.data]), [['c1', null]]);
  // 一模一样的再传一遍：不算改动
  const again = await boss.post(`/l/${lid}/push`, { changes: [rec('b1')] });
  assert.equal(again.body.seq, inc.body.seq);
  // 没在账本里的人拉不到
  const stranger = await signup('路人');
  assert.equal((await stranger.get(`/l/${lid}/pull?since=0`)).status, 403);
  assert.equal((await stranger.post(`/l/${lid}/push`, { changes: [rec('z')] })).status, 403);
});

test('权限在服务器上生效：业务员不能记进货、不能改别人的、不能改税率；只看的什么都写不进', async () => {
  const boss = await signup('老板B');
  const lid = boss.me.ledgers[0].id;
  const s = await signup('业务员B', { invite: (await boss.post(`/l/${lid}/invites`, { role: 'sales' })).body.code });
  const v = await signup('只看B', { invite: (await boss.post(`/l/${lid}/invites`, { role: 'viewer' })).body.code });
  await boss.post(`/l/${lid}/push`, { changes: [rec('boss-sale')] });
  const r = await s.post(`/l/${lid}/push`, { changes: [
    { kind: 'purchases', key: 'p1', data: { id: 'p1', date: '2026-10-01', supplier: 'S', product: '甲', qty: 1, price: 1 } },
    rec('boss-sale', { qty: 99 }),
    { kind: 'sales', key: 'boss-sale', data: null },
    { kind: 'settings', key: 'settings', data: { revenueRate: 0.5, marginRate: 0.5 } },
    rec('my-sale'),
    { kind: 'lists', key: 'customers:新医院', data: {} },
  ] });
  assert.deepEqual(r.body.results.map((x) => x.ok ? 'ok' : x.reason), ['no-permission', 'not-yours', 'not-yours', 'no-permission', 'ok', 'ok']);
  assert.equal(r.body.results[1].current.data.qty, 1, '拒收时带上服务器上的版本，页面好恢复');
  // 改自己记的可以
  assert.ok((await s.post(`/l/${lid}/push`, { changes: [rec('my-sale', { qty: 3 })] })).body.results[0].ok);
  const rv = await v.post(`/l/${lid}/push`, { changes: [rec('v1'), { kind: 'lists', key: 'customers:X', data: {} }] });
  assert.deepEqual(rv.body.results.map((x) => x.reason), ['no-permission', 'no-permission']);
  // 老板单独给业务员加上「能改别人的」
  await boss.patch(`/l/${lid}/members/${s.me.user.id}`, { role: 'sales', perms: { write: ['sales', 'receipts'], editOthers: true } });
  assert.ok((await s.post(`/l/${lid}/push`, { changes: [rec('boss-sale', { qty: 2 })] })).body.results[0].ok);
  // 坏数据
  const bad = await boss.post(`/l/${lid}/push`, { changes: [{ kind: 'sales', key: 'k', data: { id: 'other' } }, { kind: 'nope', key: 'x', data: {} }, { kind: 'settings', key: 'settings', data: { revenueRate: 2, marginRate: 0 } }] });
  assert.deepEqual(bad.body.results.map((x) => x.reason), ['bad-data', 'bad-kind', 'bad-data']);
});

test('成员管理：只有老板 / 管理员能管；老板不能被改；管理员只能老板任免；移出后拉不到账', async () => {
  const boss = await signup('老板C');
  const lid = boss.me.ledgers[0].id;
  const adm = await signup('管理员C', { invite: (await boss.post(`/l/${lid}/invites`, { role: 'admin' })).body.code });
  const clerk = await signup('记账员C', { invite: (await adm.post(`/l/${lid}/invites`, { role: 'clerk' })).body.code });
  assert.equal((await adm.post(`/l/${lid}/invites`, { role: 'admin' })).status, 403);
  assert.equal((await clerk.post(`/l/${lid}/invites`, { role: 'viewer' })).status, 403);
  assert.equal((await clerk.get(`/l/${lid}/log`)).status, 403);
  const members = (await clerk.get(`/l/${lid}/members`)).body.members;
  assert.equal(members.length, 3);
  assert.match(members[0].phone, /\*\*\*\*/, '普通成员看不到别人完整手机号');
  assert.equal((await adm.patch(`/l/${lid}/members/${boss.me.user.id}`, { role: 'viewer' })).status, 403);
  assert.equal((await adm.del(`/l/${lid}/members/${boss.me.user.id}`)).status, 403);
  assert.equal((await adm.patch(`/l/${lid}/members/${clerk.me.user.id}`, { role: 'admin' })).status, 403);
  assert.equal((await adm.patch(`/l/${lid}/members/${clerk.me.user.id}`, { role: 'viewer' })).status, 200);
  assert.equal((await clerk.post(`/l/${lid}/push`, { changes: [rec('x')] })).body.results[0].reason, 'no-permission');
  // 重置密码：旧密码不能用了，临时密码能登
  const reset = await adm.post(`/l/${lid}/members/${clerk.me.user.id}/reset-password`);
  assert.equal(reset.status, 200);
  assert.equal((await clerk.get('/me')).status, 401, '重置后原来的登录失效');
  const c2 = client();
  assert.equal((await c2.post('/auth/login', { phone: clerk.phone, password: reset.body.password })).status, 200);
  assert.equal((await adm.del(`/l/${lid}/members/${clerk.me.user.id}`)).status, 200);
  assert.equal((await c2.get(`/l/${lid}/pull?since=0`)).status, 403);
  // 操作记录
  const log = (await boss.get(`/l/${lid}/log`)).body.log;
  assert.ok(Array.isArray(log));
});

test('重置密码不能用来登进别人的账本', async () => {
  const a = await signup('老板D');
  const b = await signup('老板E');
  const lidA = a.me.ledgers[0].id;
  const lidB = b.me.ledgers[0].id;
  // E 也在 D 的账本里当记账员
  await b.post('/join', { code: (await a.post(`/l/${lidA}/invites`, { role: 'clerk' })).body.code });
  const r = await a.post(`/l/${lidA}/members/${b.me.user.id}/reset-password`);
  assert.equal(r.status, 403);
  assert.ok(lidB);
});

test('改密码：要原密码，改完别的设备要重新登录', async () => {
  const u = await signup('改密码');
  const other = client();
  await other.post('/auth/login', { phone: u.phone, password: 'secret12' });
  assert.equal((await u.post('/auth/password', { old: 'nope', password: 'newpass1' })).status, 400);
  assert.equal((await u.post('/auth/password', { old: 'secret12', password: 'newpass1' })).status, 200);
  assert.equal((await u.get('/me')).status, 200);
  assert.equal((await other.get('/me')).status, 401);
});

test('拉取分页、服务器数据比本机旧时让本机重来', async () => {
  const u = await signup('大账本');
  const lid = u.me.ledgers[0].id;
  for (let b = 0; b < 5; b++) {
    const changes = Array.from({ length: 500 }, (_, i) => rec(`s${b}-${i}`));
    assert.equal((await u.post(`/l/${lid}/push`, { changes })).status, 200);
  }
  let since = 0, n = 0, pages = 0, more = true;
  while (more) {
    const r = (await u.get(`/l/${lid}/pull?since=${since}`)).body;
    n += r.changes.length; since = r.seq; more = r.more; pages++;
  }
  assert.equal(n, 2500);
  assert.equal(pages, 2);
  assert.equal((await u.get(`/l/${lid}/pull?since=999999`)).body.reset, true);
  assert.equal((await u.post(`/l/${lid}/push`, { changes: Array.from({ length: 501 }, (_, i) => rec(`t${i}`)) })).status, 400);
});
