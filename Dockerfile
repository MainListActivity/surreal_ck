FROM oven/bun:1-alpine AS builder

WORKDIR /app

RUN apk add --no-cache nodejs npm
RUN npm install -g pnpm@10.32.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/package.json
COPY shared/package.json shared/package.json
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY server server
COPY shared shared
RUN pnpm --filter @surreal-ck/server typecheck
RUN pnpm --filter @surreal-ck/server deploy --prod --legacy /deploy
# Bun 直接跑 TS 源：类型声明、sourcemap、包内文档不进运行镜像
RUN find /deploy/node_modules -type f \( -name "*.d.ts" -o -name "*.map" -o -name "CHANGELOG.md" -o -name "README.md" \) -delete

FROM oven/bun:1-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /deploy ./

EXPOSE 8080
CMD ["bun", "run", "src/index.ts"]
