FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build


FROM node:20-slim AS runner

ENV NODE_ENV=production \
    STATE_FILE=/data/aggregator-db
    SNAPSHOT_DIR=/data/aggregator-snapshot

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

RUN mkdir -p /data && chown node:node /data

VOLUME ["/data"]

USER node

CMD ["node", "dist/aggregator.js", "--state", "/data/aggregator-db"]
