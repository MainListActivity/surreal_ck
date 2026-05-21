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

FROM oven/bun:1-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/package.json package.json
COPY --from=builder /app/pnpm-workspace.yaml pnpm-workspace.yaml
COPY --from=builder /app/server server
COPY --from=builder /app/shared shared

EXPOSE 8080
CMD ["bun", "run", "server/src/index.ts"]
