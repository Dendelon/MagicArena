# syntax=docker/dockerfile:1

FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
COPY shared/package.json ./shared/package.json

RUN npm ci --ignore-scripts

COPY tsconfig.base.json ./tsconfig.base.json
COPY shared/tsconfig.json ./shared/tsconfig.json
COPY shared/src ./shared/src
COPY client/tsconfig.json client/vite.config.js client/index.html ./client/
COPY client/public ./client/public
COPY client/src ./client/src

RUN npm run build -w client


FROM node:24-alpine AS prod-deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
COPY shared/package.json ./shared/package.json

RUN npm ci --omit=dev --ignore-scripts


FROM alpine:3.24 AS runtime
WORKDIR /app

RUN apk add --no-cache nodejs \
  && addgroup -g 1000 -S node \
  && adduser -u 1000 -S -G node -D node

ARG GIT_SHA=""
ARG BUILD_ID=""

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    LOG_LEVEL=info \
    GIT_SHA=${GIT_SHA} \
    BUILD_ID=${BUILD_ID}

COPY --chown=node:node package.json ./package.json
COPY --chown=node:node server/package.json ./server/package.json
COPY --chown=node:node shared/package.json ./shared/package.json
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node shared/src ./shared/src
COPY --chown=node:node server/src ./server/src
COPY --from=builder --chown=node:node /app/client/dist ./client/dist

RUN mkdir -p /app/server/logs && chown -R node:node /app/server/logs

USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "server/src/index.ts"]

