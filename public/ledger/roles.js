// 一本账几个人一起记，分两种人：
// - 全部权限：什么都能看、能记、能改，能邀请和管理成员（老板就是建账本的那个全部权限的人）
// - 只记收付款：只能记回款和付上游，只看得到自己记的这几笔，别的（销售、进货、库存、价目表、
//   两个账户的钱、扣税、别人记的）都看不到。服务器只把他自己记的发给他，不是页面藏起来。
// 浏览器和服务器共用这一份：页面按它决定显示什么，服务器按它决定发什么、收什么。

export const RECORD_KINDS = ['purchases', 'payments', 'sales', 'receipts', 'withdrawals', 'prices', 'settings'];
export const KIND_LABEL = {
  purchases: '进货', payments: '付上游', sales: '销售', receipts: '回款', withdrawals: '提现', prices: '价目表', settings: '税率',
};

// view：'all' 整本账都看得到；'own' 只看得到自己记的回款、付款（加上下游公司、上游厂家的名字，选公司要用）
// editOthers：能不能改 / 删别人记的；manage：能不能邀请、移出成员
export const ROLES = {
  owner: { label: '老板', note: '全部权限，建这本账的人', write: RECORD_KINDS, view: 'all', editOthers: true, manage: true },
  admin: { label: '全部权限', note: '什么都能看、能记、能改，能邀请和管理成员', write: RECORD_KINDS, view: 'all', editOthers: true, manage: true },
  cashier: { label: '只记收付款', note: '只能记回款和付上游，只看得到自己记的，别的都看不到', write: ['receipts', 'payments'], view: 'own', editOthers: false, manage: false },
};
export const ROLE_ORDER = ['owner', 'admin', 'cashier'];

// 只记收付款的人能拿到的下拉单：下游公司、上游厂家的名字（不带金额）
export const OWN_LISTS = ['customers', 'suppliers'];

// 身份 → 实际权限。不认识的身份（老版本留下的）按最小的「只记收付款」算
export function effectivePerms(role) {
  const r = ROLES[role] ? role : 'cashier';
  const b = ROLES[r];
  return { role: r, write: [...b.write], view: b.view, editOthers: b.editOthers, manage: b.manage };
}

// 下拉单（品种 / 厂家 / 公司名）跟着记账走：能记单据就能往里加；只记收付款的只能加公司名、厂家名
export function canWrite(perms, kind, key = '') {
  if (!perms) return true;
  if (kind === 'lists') return perms.write.length > 0 && (perms.view !== 'own' || OWN_LISTS.includes(String(key).split(':')[0]));
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
