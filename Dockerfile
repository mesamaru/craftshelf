FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 MIGRATIONS_DIR=/app/drizzle
COPY --from=build /src/.output ./.output
COPY --from=build /src/drizzle ./drizzle
COPY VERSION ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/api/auth/ok >/dev/null || exit 1
CMD ["node", ".output/server/index.mjs"]
