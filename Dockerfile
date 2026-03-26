# syntax=docker/dockerfile:1

# --- Build CLI ---
FROM node:20-bookworm AS cli-builder
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY gitnexus/ .
RUN npm ci --ignore-scripts \
    && node scripts/patch-tree-sitter-swift.cjs \
    && (npm rebuild 2>&1 || true) \
    && (cd node_modules/tree-sitter-kotlin && npx --yes node-gyp rebuild 2>&1 || true) \
    && npm run build

# --- Build Web ---
FROM node:20-bookworm AS web-builder
WORKDIR /app
COPY gitnexus-web/ .
RUN npm ci && npm run build

# --- Runtime ---
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends nginx git && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=cli-builder /app/dist ./dist
COPY --from=cli-builder /app/node_modules ./node_modules
COPY --from=cli-builder /app/package.json .
COPY --from=cli-builder /app/scripts ./scripts
COPY --from=cli-builder /app/vendor ./vendor
COPY --from=web-builder /app/dist /usr/share/nginx/html

RUN printf 'server {\n    listen 8080;\n    root /usr/share/nginx/html;\n    index index.html;\n    add_header Cross-Origin-Opener-Policy same-origin;\n    add_header Cross-Origin-Embedder-Policy require-corp;\n    location / { try_files $uri $uri/ /index.html; }\n}\n' \
    > /etc/nginx/sites-available/default

RUN printf '#!/bin/sh\nif [ "$1" = "web" ]; then\n  exec nginx -g "daemon off;"\nelse\n  exec node /app/dist/cli/index.js "$@"\nfi\n' \
    > /entrypoint.sh && chmod +x /entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
CMD ["--help"]
