// 这次是怎么打开的，boot.js 定好以后 app.js 照着用：
// mode：'claude'（claude.ai 页面）/ 'server'（进销账服务器，要登录）/ 'local'（只存本机）
// me：服务器模式下登录的人和他所在的账本；ledger：现在打开的那本
export const env = { mode: 'local', me: null, ledger: null };
