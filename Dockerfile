# syntax=docker/dockerfile:1

# ---- Build stage: compile shared, server, and client ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Toolchain for building the better-sqlite3 native module if no prebuilt is used.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install deps first (cached unless a manifest changes).
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci

# Build all three workspaces.
COPY . .
RUN npm run build

# Drop dev dependencies so the runtime image stays small.
RUN npm prune --omit=dev

# ---- Runtime stage: just the built output + production deps ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000
ENV DATABASE_PATH=/data/settlers.db
ENV CLIENT_DIST=/app/client/dist

# Pruned dependency tree (includes the @settlers/shared workspace symlink).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Built artifacts.
COPY --from=builder /app/shared/package.json ./shared/package.json
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist

# SQLite database lives on a mounted volume so games survive restarts.
RUN mkdir -p /data
VOLUME /data

EXPOSE 4000
CMD ["node", "server/dist/index.js"]
