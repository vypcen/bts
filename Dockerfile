# 1. Сборка интерфейса (web/, React + Vite) в /public
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

# 2. Сервер
FROM node:20-alpine
# Сборка помечается коммитом и датой: видны в «Пользователи → О системе» и в логе запуска.
#   docker build --build-arg BUILD_COMMIT=$(git rev-parse HEAD) --build-arg BUILD_DATE=$(date -u +%FT%TZ) -t …
ARG BUILD_COMMIT=""
ARG BUILD_DATE=""
ENV BUILD_COMMIT=$BUILD_COMMIT BUILD_DATE=$BUILD_DATE
LABEL org.opencontainers.image.title="TestBall QA" org.opencontainers.image.revision=$BUILD_COMMIT org.opencontainers.image.created=$BUILD_DATE

WORKDIR /app
ENV NODE_ENV=production
ENV UPLOAD_DIR=/app/data/uploads

# pg_dump/pg_restore — для резервных копий из интерфейса (версия = версии сервера PostgreSQL или новее)
RUN apk add --no-cache postgresql16-client

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY scripts ./scripts
# документация — для встроенной справки (кнопка «Справка»)
COPY docs ./docs
COPY README.md CHANGELOG.md .env.example ./
COPY --from=web /public ./public
# Папка для вложений: Docker volume при первом подключении наследует её владельца
RUN mkdir -p /app/data/uploads /app/data/backups && chown -R node:node /app/data

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server/index.js"]
