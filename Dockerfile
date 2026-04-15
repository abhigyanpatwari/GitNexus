ARG BUILDPLATFORM
ARG TARGETPLATFORM

FROM --platform=$BUILDPLATFORM node:20-bookworm-slim AS builder

WORKDIR /app

COPY gitnexus-shared/package.json gitnexus-shared/package-lock.json ./gitnexus-shared/
RUN npm ci --prefix gitnexus-shared

COPY gitnexus-shared ./gitnexus-shared
RUN npm run build --prefix gitnexus-shared

COPY gitnexus/package.json ./gitnexus/package.json
COPY gitnexus-web/package.json gitnexus-web/package-lock.json ./gitnexus-web/
RUN npm ci --prefix gitnexus-web

COPY gitnexus-web ./gitnexus-web
RUN npm run build --prefix gitnexus-web

FROM --platform=$TARGETPLATFORM node:20-bookworm-slim AS runtime

WORKDIR /app

COPY --from=builder /app/gitnexus-web/dist ./dist
COPY docker-server.mjs ./docker-server.mjs

EXPOSE 4173

CMD ["node", "docker-server.mjs"]
