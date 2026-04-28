FROM node:22-bookworm AS builder
WORKDIR /build
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci --ignore-scripts \
    && node scripts/patch-tree-sitter-swift.cjs \
    && (npm rebuild 2>&1 || true) \
    && npm run build \
    && npm pack

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/*.tgz /tmp/gitnexus.tgz
RUN npm install -g /tmp/gitnexus.tgz && rm /tmp/gitnexus.tgz

# Set GITNEXUS_INCREMENTAL=1 at runtime to pass --incremental after initial registration.

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /data
ENTRYPOINT ["/entrypoint.sh"]
