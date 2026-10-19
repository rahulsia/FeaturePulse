FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json vite.config.ts index.html ./
# npm ci (not install): installs exactly what the lockfile pins, so the production build
# can't silently pick up a newly published dependency version that was never tested here.
RUN npm ci
COPY src ./src
RUN npm run build
# Runs as its own non-root "nginx" user out of the box — no extra USER/chown plumbing needed.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
