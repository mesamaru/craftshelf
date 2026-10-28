FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
# 既定は自分用の版(CRAFTSHELF_MODE=self)。データは /data/v03 に置く(v02 のデータと同じ /data を使える)。
# v02 と同じくコンテナの中は 8080 番。v02 の /data は root の持ち物なので、自分用の版は root のまま動かす
# (サービス版は docker-compose.service.yml で node ユーザーにする)
ENV NODE_ENV=production PORT=8080 MIGRATIONS_DIR=/app/drizzle DATA_DIR=/data CRAFTSHELF_MODE=self
COPY --from=build /src/.output ./.output
COPY --from=build /src/drizzle ./drizzle
COPY VERSION ./
COPY docker/start.sh /usr/local/bin/craftshelf-start
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/auth/ok" >/dev/null || exit 1
# パネルで選んだ版(/data/v03/versions)があればそれを起動する
CMD ["sh", "/usr/local/bin/craftshelf-start"]
