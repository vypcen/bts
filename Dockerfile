# 1. Сборка интерфейса (web/, React + Vite) в /public
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

# 2. Сервер
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV UPLOAD_DIR=/app/data/uploads

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY scripts ./scripts
COPY --from=web /public ./public
# Папка для вложений: Docker volume при первом подключении наследует её владельца
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server/index.js"]
