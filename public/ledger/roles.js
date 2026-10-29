// 一本账几个人一起记：每个人在账本里有一个身份，身份决定能记 / 能改哪些单据。
// 浏览器和服务器共用这一份：页面按它藏掉不能用的按钮，服务器按它真正拦下不该写的。
// 现在所有成员都能看到整本账；「看不到进价」「只看自己的客户」这类看的权限还没做。

export const RECORD_KINDS = ['purchases', 'payments', 'sales', 'receipts', 'withdrawals', 'prices', 'settings'];
export const KIND_LABEL = {
  purchases: '进货', payments: '付上游', sales: '销售', receipts: '回款', withdrawals: '提现', prices: '价目表', settings: '税率',
};

const ALL = RECORD_KINDS;
const BOOKS = ['purchases', 'payments', 'sales', 'receipts', 'withdrawals', 'prices'];

// editOthers：能不能改 / 删别人记的单据；manage：能不能邀请、移出成员，改成员的身份
export const ROLES = {
  owner: { label: '老板', note: '全部能记能改，管成员。建账本的人', write: ALL, editOthers: true, manage: true },
  admin: { label: '管理员', note: '全部能记能改，能邀请和管理成员', write: ALL, editOthers: true, manage: true },
  clerk: { label: '记账员', note: '进货、销售、回款、付款都能记，只能改自己记的', write: BOOKS, editOthers: false, manage: false },
  sales: { label: '业务员', note: '只能记销售和回款，只能改自己记的', write: ['sales', 'receipts'], editOthers: false, manage: false },
  viewer: { label: '只看', note: '能看整本账，不能记也不能改', write: [], editOthers: false, manage: false },
};
export const ROLE_ORDER = ['owner', 'admin', 'clerk', 'sales', 'viewer'];

// 身份 + 老板单独勾的（custom: { write, editOthers }）→ 实际权限
export function effectivePerms(role, custom) {
  const base = ROLES[role] || ROLES.viewer;
  const r = ROLES[role] ? role : 'viewer';
  if (r === 'owner' || r === 'admin' || !custom) return { role: r, write: [...base.write], editOthers: base.editOthers, manage: base.manage, custom: false };
  const write = RECORD_KINDS.filter((k) => k !== 'settings' && (custom.write || []).includes(k));
  return { role: r, write, editOthers: Boolean(custom.editOthers), manage: false, custom: true };
}

// 下拉单（品种 / 厂家 / 公司名）跟着记账走：能记任何一种单据就能往里加
export function canWrite(perms, kind) {
  if (!perms) return true;
  if (kind === 'lists') return perms.write.length > 0;
  return perms.write.includes(kind);
}

// 改 / 删一笔已有的单据：要能记这种单据；不是自己记的，还要能改别人的。价目表、税率是大家共用的，不分谁记的
export function canEditRecord(perms, kind, createdBy, userId) {
  if (!canWrite(perms, kind)) return false;
  if (!perms || perms.editOthers || kind === 'prices' || kind === 'settings' || kind === 'lists') return true;
  return !createdBy || createdBy === userId;
}

// 页面上「记一笔」按钮对应的单据
export const ACT_KIND = { purchase: 'purchases', sale: 'sales', receipt: 'receipts', payment: 'payments', price: 'prices', withdraw: 'withdrawals' };
export const EDIT_KIND = { purchase: 'purchases', sale: 'sales', receipt: 'receipts', payment: 'payments', price: 'prices', withdraw: 'withdrawals' };
