# 进销账服务器镜像
#   docker build -f ledger.Dockerfile -t jinxiaozhang .
#   docker run -d --name jinxiaozhang -p 3100:3100 -v jinxiaozhang-data:/data --restart unless-stopped jinxiaozhang
# 数据在 /data/ledger.db，一定要挂一个卷（上面的 -v），不然重建容器数据就没了。
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY ledger-server.js ledger-admin.js ./
COPY server ./server
COPY public/ledger ./public/ledger
ENV NODE_ENV=production PORT=3100 DATA_DIR=/data
VOLUME /data
EXPOSE 3100
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "ledger-server.js"]
