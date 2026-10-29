// 进销账服务器：注册登录、几个人一起记一本账、每人权限不同。
//   npm run ledger            本地跑，打开 http://localhost:3100
//   DATA_DIR=/data PORT=80 npm run ledger
// 数据都在 DATA_DIR/ledger.db 一个文件里，部署时一定要放在不会被清掉的磁盘上。
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`进销账服务器要 Node.js 22.5 以上（现在是 ${process.versions.node}）`);
  process.exit(1);
}
const { ledgerApi } = await import('./server/ledger/api.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3100;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // 部署在 HTTPS 反向代理后面时，用它判断要不要给 cookie 加 Secure
app.use((_req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
  next();
});
app.use('/api/ledger', ledgerApi({ dataDir: DATA_DIR }));
app.get('/', (_req, res) => res.redirect('/ledger/'));
// 离线缓存脚本每次都要取最新的，不然更新发不出去
app.get('/ledger/sw.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public/ledger/sw.js'));
});
app.use('/ledger', express.static(path.join(__dirname, 'public/ledger'), { index: 'index.html' }));

app.listen(PORT, () => console.log(`进销账 http://localhost:${PORT}/ledger/  数据：${path.join(DATA_DIR, 'ledger.db')}`));
