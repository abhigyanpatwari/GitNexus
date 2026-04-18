ARG BUILDPLATFORM
ARG TARGETPLATFORM

FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

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

FROM node:22-alpine AS runtime

RUN apk add --no-cache curl

WORKDIR /app

COPY --from=builder /app/gitnexus-web/dist ./dist
COPY docker-server.mjs ./docker-server.mjs

RUN chown -R node:node /app

USER node

EXPOSE 4173

CMD ["node", "docker-server.mjs"]
