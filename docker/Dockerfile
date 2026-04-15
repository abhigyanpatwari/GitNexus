FROM node:20-alpine AS builder

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

FROM nginx:1.27-alpine AS runtime

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/gitnexus-web/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
