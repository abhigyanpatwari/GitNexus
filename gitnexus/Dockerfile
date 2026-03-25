FROM node:20-bookworm AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci --ignore-scripts \
    && node scripts/patch-tree-sitter-swift.cjs \
    && (npm rebuild 2>&1 || true) \
    && (cd node_modules/tree-sitter-kotlin && npx --yes node-gyp rebuild 2>&1 || true) \
    && npm run build

FROM node:20-bookworm-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json .
COPY --from=builder /app/scripts ./scripts
ENTRYPOINT ["node", "dist/cli/index.js"]
