FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund || true
COPY . .
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
