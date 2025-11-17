FROM node:20-slim AS builder

WORKDIR /app

# Copy root tsconfig.base.json for extends to work
COPY tsconfig.base.json /tsconfig.base.json

# Copy package files
COPY packages/firehose/package.json packages/firehose/package-lock.json ./
RUN npm ci

# Copy package source
COPY packages/firehose/tsconfig.json ./
COPY packages/firehose/src ./src

RUN npm run build


FROM node:20-slim AS runner

ENV NODE_ENV=production \
    STATE_FILE=/data/aggregator-db \
    SNAPSHOT_DIR=/data/aggregator-snapshot

WORKDIR /app

# Copy package files and install production dependencies
COPY packages/firehose/package.json packages/firehose/package-lock.json ./
RUN npm ci --omit=dev

# Copy built application from builder
COPY --from=builder /app/dist ./dist

RUN mkdir -p /data && chown node:node /data

VOLUME ["/data"]

USER node

CMD ["node", "dist/aggregator.js", "--state", "/data/aggregator-db", "--top", "30"]
