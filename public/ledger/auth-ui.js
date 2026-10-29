// 登录 / 注册 / 用邀请码加入 / 不在任何账本里 这几个整页。成功以后重新打开页面，boot.js 会直接进账本。
import { api, saveSession, clearSession } from './remote.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const home = () => location.replace(location.pathname);

function mount(html) {
  document.querySelector('#app').hidden = true;
  document.querySelector('.tabbar')?.setAttribute('hidden', '');
  let box = document.querySelector('#auth');
  if (!box) {
    box = document.createElement('main');
    box.id = 'auth';
    box.className = 'auth';
    document.body.prepend(box);
  }
  box.innerHTML = `<div class="auth-hd"><div class="auth-logo" aria-hidden="true">账</div><h1>进销账</h1>
    <p class="sub">进货、销售、回款、扣税，几个人一起记一本账</p></div>${html}`;
  return box;
}

// 按钮点了先变灰，防止连点；出错写在表单下面
async function busy(btn, errBox, fn) {
  btn.disabled = true;
  errBox.textContent = '';
  try { await fn(); } catch (e) { errBox.textContent = e.message || '出错了'; } finally { btn.disabled = false; }
}

async function inviteInfo(code) {
  if (!code) return { html: '' };
  try {
    const i = await api(`/invite/${encodeURIComponent(code)}`);
    return { ok: true, info: i, html: `<div class="auth-invite"><b>${esc(i.inviter)}</b> 邀请你加入 <b>${esc(i.ledger)}</b><br><span>身份：${esc(i.roleLabel)}，${esc(i.roleNote)}</span></div>` };
  } catch (e) {
    return { html: `<div class="auth-invite bad">${esc(e.message)}</div>` };
  }
}

export async function showAuth({ invite = '' } = {}) {
  const inv = await inviteInfo(invite);
  let mode = inv.ok ? 'register' : 'login';
  const box = mount(`${inv.html}
    <div class="card auth-card">
      <div class="seg auth-seg"><button type="button" data-m="login">登录</button><button type="button" data-m="register">注册</button></div>
      <form id="auth-form" novalidate>
        <div class="f"><label for="a-phone">手机号</label><input class="inp" id="a-phone" type="tel" inputmode="numeric" autocomplete="username" maxlength="11" placeholder="11 位手机号"></div>
        <div class="f reg"><label for="a-name">你的名字 <span class="tip">同事看到的</span></label><input class="inp" id="a-name" autocomplete="name" maxlength="20" placeholder="比如 张三"></div>
        <div class="f"><label for="a-pw">密码</label><input class="inp" id="a-pw" type="password" autocomplete="current-password" placeholder="至少 6 位"></div>
        <div class="f reg"><label for="a-pw2">再输一次密码</label><input class="inp" id="a-pw2" type="password" autocomplete="new-password"></div>
        ${inv.ok ? '' : '<div class="f reg"><label for="a-code">邀请码 <span class="tip">选填，老板发给你的 8 位码</span></label><input class="inp" id="a-code" maxlength="8" autocapitalize="characters" placeholder="没有就空着"></div>'}
        <p class="auth-err" role="alert"></p>
        <button class="btn primary block" id="a-go" type="submit">登录</button>
      </form>
      <p class="small muted auth-note"></p>
    </div>`);
  const $ = (s) => box.querySelector(s);
  const paint = () => {
    box.querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
    box.querySelectorAll('.reg').forEach((el) => (el.hidden = mode !== 'register'));
    $('#a-go').textContent = mode === 'login' ? (inv.ok ? '登录并加入' : '登录') : inv.ok ? '注册并加入' : '注册';
    $('#a-pw').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('.auth-note').textContent = mode === 'login'
      ? '忘了密码：找账本的老板或管理员在「设置 → 成员」里重置。'
      : inv.ok ? '注册后直接进邀请你的那本账。' : '注册后会给你建一本自己的账本，可以再邀请同事一起记。';
    $('.auth-err').textContent = '';
  };
  box.querySelector('.auth-seg').onclick = (e) => { const b = e.target.closest('[data-m]'); if (b) { mode = b.dataset.m; paint(); } };
  paint();
  $('#auth-form').onsubmit = (e) => {
    e.preventDefault();
    busy($('#a-go'), $('.auth-err'), async () => {
      const phone = $('#a-phone').value.replace(/\s/g, '');
      const password = $('#a-pw').value;
      if (!/^1\d{10}$/.test(phone)) throw new Error('手机号要 11 位数字');
      if (password.length < 6) throw new Error('密码至少 6 位');
      let me, ledgerId;
      if (mode === 'register') {
        if (!$('#a-name').value.trim()) throw new Error('名字要填');
        if (password !== $('#a-pw2').value) throw new Error('两次输的密码不一样');
        const code = inv.ok ? invite : ($('#a-code')?.value || '').trim();
        me = await api('/auth/register', { method: 'POST', body: { phone, name: $('#a-name').value.trim(), password, invite: code || undefined } });
        ledgerId = me.ledgers[0]?.id;
      } else {
        me = await api('/auth/login', { method: 'POST', body: { phone, password } });
        if (inv.ok) {
          try { const j = await api('/join', { method: 'POST', body: { code: invite } }); me = j; ledgerId = j.joined; } catch (err) { if (err.status !== 409) throw err; }
        }
      }
      saveSession({ me, ledgerId });
      home();
    });
  };
}

export async function showJoin({ me, invite }) {
  const inv = await inviteInfo(invite);
  const box = mount(`${inv.html}<div class="card auth-card">
    <p style="margin-top:0">你已经登录为 <b>${esc(me.user.name)}</b>（${esc(me.user.phone)}）。</p>
    ${inv.ok ? '<button class="btn primary block" id="j-go">加入这本账</button>' : ''}
    <button class="btn block" id="j-skip" style="margin-top:8px">${inv.ok ? '先不了，' : ''}打开我的账本</button>
    <p class="auth-err" role="alert"></p></div>`);
  if (inv.ok) box.querySelector('#j-go').onclick = (e) => busy(e.target, box.querySelector('.auth-err'), async () => {
    const j = await api('/join', { method: 'POST', body: { code: invite } });
    saveSession({ me: j, ledgerId: j.joined });
    home();
  });
  box.querySelector('#j-skip').onclick = home;
}

export function showNoLedger({ me }) {
  const box = mount(`<div class="card auth-card">
    <p style="margin-top:0"><b>${esc(me.user.name)}</b>，你现在不在任何账本里（可能被移出了）。</p>
    <div class="f"><label for="n-code">有邀请码就填上</label><input class="inp" id="n-code" placeholder="8 位邀请码" autocapitalize="characters"></div>
    <button class="btn primary block" id="n-join">加入</button>
    <button class="btn block" id="n-new" style="margin-top:8px">新建一本自己的账本</button>
    <button class="btn block" id="n-out" style="margin-top:8px">退出登录</button>
    <p class="auth-err" role="alert"></p></div>`);
  const err = box.querySelector('.auth-err');
  box.querySelector('#n-join').onclick = (e) => busy(e.target, err, async () => {
    const j = await api('/join', { method: 'POST', body: { code: box.querySelector('#n-code').value.trim() } });
    saveSession({ me: j, ledgerId: j.joined });
    home();
  });
  box.querySelector('#n-new').onclick = (e) => busy(e.target, err, async () => {
    const j = await api('/ledgers', { method: 'POST', body: {} });
    saveSession({ me: j, ledgerId: j.created });
    home();
  });
  box.querySelector('#n-out').onclick = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); clearSession(); home(); };
}
