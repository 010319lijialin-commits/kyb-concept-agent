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
  const inv = await boss.post(`/l/${lid}/invites`, { role: 'cashier' });
  assert.equal(inv.status, 200);
  const info = await client().get(`/invite/${inv.body.code}`);
  assert.equal(info.body.ledger, '老板的账本');
  assert.equal(info.body.roleLabel, '只记收付款');
  const s = await signup('小王', { invite: inv.body.code.toLowerCase() });
  assert.equal(s.me.ledgers.length, 1, '用邀请码注册的不另建账本');
  assert.equal(s.me.ledgers[0].id, lid);
  assert.equal(s.me.ledgers[0].role, 'cashier');
  assert.equal(s.me.ledgers[0].perms.view, 'own');
  const third = client();
  const r = await third.post('/auth/register', { phone: nextPhone(), name: '小李', password: 'secret12', invite: inv.body.code });
  assert.equal(r.status, 410);
  // 已经有账号的人用邀请码加入
  const inv2 = await boss.post(`/l/${lid}/invites`, { role: 'cashier' });
  const other = await signup('别家老板');
  const j = await other.post('/join', { code: inv2.body.code });
  assert.equal(j.status, 200);
  assert.equal(j.body.ledgers.length, 2);
  assert.equal((await other.post('/join', { code: inv2.body.code })).status, 410);
});

test('同步：两个人记同一本账，互相拉得到；删掉的也同步', async () => {
  const boss = await signup('老板A');
  const lid = boss.me.ledgers[0].id;
  const inv = await boss.post(`/l/${lid}/invites`, { role: 'admin' });
  const clerk = await signup('全部权限A', { invite: inv.body.code });
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

const receipt = (id, extra = {}) => ({ kind: 'receipts', key: id, data: { id, date: '2026-10-05', customer: 'C', account: 'company', amount: 1, allocations: [], ...extra } });
const payment = (id, extra = {}) => ({ kind: 'payments', key: id, data: { id, date: '2026-10-05', supplier: 'S', account: 'personal', amount: 1, allocations: [], ...extra } });
const purchase = (id, extra = {}) => ({ kind: 'purchases', key: id, data: { id, date: '2026-10-01', supplier: 'S', product: '甲', qty: 100, price: 1, ...extra } });

async function bossAndCashier(tag) {
  const boss = await signup(`老板${tag}`);
  const lid = boss.me.ledgers[0].id;
  const c = await signup(`出纳${tag}`, { invite: (await boss.post(`/l/${lid}/invites`, { role: 'cashier' })).body.code });
  return { boss, c, lid };
}

test('只记收付款：只能记回款和付上游，别的写不进；只能改自己记的', async () => {
  const { boss, c, lid } = await bossAndCashier('B');
  await boss.post(`/l/${lid}/push`, { changes: [rec('boss-sale'), receipt('boss-r')] });
  const r = await c.post(`/l/${lid}/push`, { changes: [
    purchase('p1'),
    rec('my-sale'),
    { kind: 'prices', key: 'S\u0001甲', data: { supplier: 'S', product: '甲', price: 9 } },
    { kind: 'settings', key: 'settings', data: { revenueRate: 0.5, marginRate: 0.5 } },
    { kind: 'lists', key: 'products:新药', data: {} },
    receipt('boss-r', { amount: 99 }),
    { kind: 'receipts', key: 'boss-r', data: null },
    { kind: 'sales', key: 'boss-sale', data: null },
    receipt('my-r'),
    payment('my-p'),
    { kind: 'lists', key: 'customers:新医院', data: {} },
    { kind: 'lists', key: 'suppliers:新厂家', data: {} },
  ] });
  assert.deepEqual(r.body.results.map((x) => (x.ok ? 'ok' : x.reason)), [
    'no-permission', 'no-permission', 'no-permission', 'no-permission', 'no-permission',
    'not-yours', 'not-yours', 'no-permission', 'ok', 'ok', 'ok', 'ok']);
  // 拒收时不把别人的单据内容带回去
  assert.ok(r.body.results.slice(0, 8).every((x) => x.current === null), '拒收结果里不能有别人的数据');
  assert.ok((await c.post(`/l/${lid}/push`, { changes: [receipt('my-r', { amount: 2 })] })).body.results[0].ok, '改自己记的可以');
  assert.ok((await c.post(`/l/${lid}/push`, { changes: [{ kind: 'payments', key: 'my-p', data: null }] })).body.results[0].ok, '删自己记的可以');
});

test('只记收付款：拉下来的只有自己记的回款付款 + 公司名厂家名，看不到核销到哪几批', async () => {
  const { boss, c, lid } = await bossAndCashier('C');
  await boss.post(`/l/${lid}/push`, { changes: [
    purchase('p1'), rec('s1', { qty: 10, price: 2 }), receipt('boss-r'), payment('boss-p'),
    { kind: 'prices', key: 'S\u0001甲', data: { supplier: 'S', product: '甲', price: 2 } },
    { kind: 'settings', key: 'settings', data: { revenueRate: 0.01, marginRate: 0.13 } },
    { kind: 'lists', key: 'customers:C', data: {} }, { kind: 'lists', key: 'suppliers:S', data: {} }, { kind: 'lists', key: 'products:甲', data: {} },
    { kind: 'withdrawals', key: 'w1', data: { id: 'w1', date: '2026-10-06', net: 1 } },
  ] });
  await c.post(`/l/${lid}/push`, { changes: [receipt('my-r', { amount: 5 })] });
  const all = (await c.get(`/l/${lid}/pull?since=0`)).body;
  assert.equal(all.view, 'own');
  assert.deepEqual(all.changes.map((x) => `${x.kind}:${x.key}`).sort(), ['lists:customers:C', 'lists:suppliers:S', 'receipts:my-r']);
  assert.equal(all.changes.find((x) => x.key === 'my-r').data.allocations, undefined, '核销明细不发给他');
  // 老板之后记的、改的，他都收不到；老板删了他记的，他收得到删除
  const seq = all.seq;
  await boss.post(`/l/${lid}/push`, { changes: [rec('s2'), { kind: 'receipts', key: 'my-r', data: null }] });
  const inc = (await c.get(`/l/${lid}/pull?since=${seq}`)).body;
  assert.deepEqual(inc.changes.map((x) => [x.key, x.data]), [['my-r', null]]);
  // 成员列表只有自己；操作记录、邀请都看不到
  const ms = (await c.get(`/l/${lid}/members`)).body;
  assert.deepEqual(ms.members.map((m) => m.id), [c.me.user.id]);
  assert.deepEqual(ms.former, []);
  assert.equal((await c.get(`/l/${lid}/log`)).status, 403);
  assert.equal((await c.get(`/l/${lid}/invites`)).status, 403);
  // 老板拉得到全部，包括核销
  const b = (await boss.get(`/l/${lid}/pull?since=0`)).body;
  assert.equal(b.view, 'all');
  assert.ok(b.changes.some((x) => x.key === 's1'));
});

test('只记收付款记的回款 / 付款：服务器按先进先出核销；只改备注不动老板调过的核销', async () => {
  const { boss, c, lid } = await bossAndCashier('D');
  await boss.post(`/l/${lid}/push`, { changes: [
    purchase('p1', { qty: 100, price: 1, date: '2026-09-01' }), purchase('p2', { qty: 100, price: 1, date: '2026-09-02' }),
    rec('s1', { qty: 100, price: 1.5, date: '2026-09-03', lots: [{ purchaseId: 'p1', qty: 100 }] }),
    rec('s2', { qty: 100, price: 1.5, date: '2026-09-04', lots: [{ purchaseId: 'p2', qty: 100 }] }),
  ] });
  await c.post(`/l/${lid}/push`, { changes: [
    receipt('r1', { amount: 200 }),                                     // 回到公司 200：s1 回清 150，s2 回 50
    receipt('r2', { amount: 50, account: 'personal' }),                 // 回到个人 50（扣完税的）：接着核销 s2
    payment('pay1', { amount: 150 }),                                    // 付上游 150：p1 付清，p2 付 50
  ] });
  const get = async (kind, key) => (await boss.get(`/l/${lid}/pull?since=0`)).body.changes.find((x) => x.kind === kind && x.key === key).data;
  assert.deepEqual((await get('receipts', 'r1')).allocations, [{ saleId: 's1', amount: 150 }, { saleId: 's2', amount: 50 }]);
  const r2 = await get('receipts', 'r2');
  assert.equal(r2.allocations[0].saleId, 's2');
  assert.ok(r2.allocations[0].amount > 50, '个人账户到账是扣完税的，核销的应收要比到账多');
  assert.deepEqual((await get('payments', 'pay1')).allocations, [{ purchaseId: 'p1', amount: 100 }, { purchaseId: 'p2', amount: 50 }]);
  // 他传上来的核销一律不算（s1 已经回清，服务器按先进先出核到还欠着的 s2）
  await c.post(`/l/${lid}/push`, { changes: [receipt('r3', { amount: 1, allocations: [{ saleId: 's1', amount: 1 }] })] });
  assert.deepEqual((await get('receipts', 'r3')).allocations, [{ saleId: 's2', amount: 1 }]);
  // 老板手动把 r1 全核到 s2；出纳只改备注，核销不变；出纳改金额，重新按先进先出
  await boss.post(`/l/${lid}/push`, { changes: [receipt('r1', { amount: 200, allocations: [{ saleId: 's2', amount: 100 }, { saleId: 's1', amount: 100 }] })] });
  await c.post(`/l/${lid}/push`, { changes: [receipt('r1', { amount: 200, note: '补个备注' })] });
  assert.deepEqual((await get('receipts', 'r1')).allocations, [{ saleId: 's2', amount: 100 }, { saleId: 's1', amount: 100 }]);
  await c.post(`/l/${lid}/push`, { changes: [receipt('r1', { amount: 10, note: '补个备注' })] });
  assert.equal((await get('receipts', 'r1')).allocations.reduce((t, a) => t + a.amount, 0), 10);
});

test('身份改了：拉取时告诉页面能看的范围变了', async () => {
  const { boss, c, lid } = await bossAndCashier('E');
  await boss.post(`/l/${lid}/push`, { changes: [rec('s1')] });
  assert.equal((await c.get(`/l/${lid}/pull?since=0`)).body.changes.length, 0);
  await boss.patch(`/l/${lid}/members/${c.me.user.id}`, { role: 'admin' });
  const after = (await c.get(`/l/${lid}/pull?since=0`)).body;
  assert.equal(after.view, 'all');
  assert.ok(after.changes.some((x) => x.key === 's1'));
});

test('成员管理：只有全部权限的人能管；老板不能被改；全部权限只能老板给；移出后拉不到账', async () => {
  const boss = await signup('老板F');
  const lid = boss.me.ledgers[0].id;
  const adm = await signup('全部权限F', { invite: (await boss.post(`/l/${lid}/invites`, { role: 'admin' })).body.code });
  const c = await signup('出纳F', { invite: (await adm.post(`/l/${lid}/invites`, { role: 'cashier' })).body.code });
  assert.equal((await adm.post(`/l/${lid}/invites`, { role: 'admin' })).status, 403, '全部权限只能老板给');
  assert.equal((await c.post(`/l/${lid}/invites`, { role: 'cashier' })).status, 403);
  assert.equal((await adm.get(`/l/${lid}/members`)).body.members.length, 3);
  assert.equal((await adm.patch(`/l/${lid}/members/${boss.me.user.id}`, { role: 'cashier' })).status, 403);
  assert.equal((await adm.del(`/l/${lid}/members/${boss.me.user.id}`)).status, 403);
  assert.equal((await adm.patch(`/l/${lid}/members/${c.me.user.id}`, { role: 'admin' })).status, 403);
  assert.equal((await boss.patch(`/l/${lid}/members/${adm.me.user.id}`, { role: 'cashier' })).status, 200);
  assert.equal((await adm.post(`/l/${lid}/push`, { changes: [rec('x')] })).body.results[0].reason, 'no-permission', '降成只记收付款以后马上不能记销售');
  // 重置密码：旧密码不能用了，临时密码能登
  const reset = await boss.post(`/l/${lid}/members/${c.me.user.id}/reset-password`);
  assert.equal(reset.status, 200);
  assert.equal((await c.get('/me')).status, 401, '重置后原来的登录失效');
  const c2 = client();
  assert.equal((await c2.post('/auth/login', { phone: c.phone, password: reset.body.password })).status, 200);
  assert.equal((await boss.del(`/l/${lid}/members/${c.me.user.id}`)).status, 200);
  assert.equal((await c2.get(`/l/${lid}/pull?since=0`)).status, 403);
  assert.ok(Array.isArray((await boss.get(`/l/${lid}/log`)).body.log));
});

test('重置密码不能用来登进别人的账本', async () => {
  const a = await signup('老板D');
  const b = await signup('老板E');
  const lidA = a.me.ledgers[0].id;
  const lidB = b.me.ledgers[0].id;
  // E 也在 D 的账本里当记账员
  await b.post('/join', { code: (await a.post(`/l/${lidA}/invites`, { role: 'cashier' })).body.code });
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
