#!/usr/bin/env bash
# 发布前钩子的只读预检（旧服务仍在运行）：一次性内容迁移已完成时输出 pre-start: not-needed，
# 发布脚本据此跳过停服并走零停机桥接；其余任何结果都按需要冻结写入处理。
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"
cd server
exec bun run --env-file="${ORIGIN_ENV_FILE:?}" src/content/migrate-legacy-check-cli.ts
