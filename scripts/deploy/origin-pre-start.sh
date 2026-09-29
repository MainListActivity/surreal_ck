#!/usr/bin/env bash
# 发布前钩子（旧服务已停止，写入已冻结）：把 _system 里的平台内容复制到隔离内容库并校验。
# 只复制不删除，重复执行结果一致（已存在的记录只做一致性断言）。
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"
cd server
exec bun run --env-file="${ORIGIN_ENV_FILE:?}" src/content/migrate-legacy-cli.ts --writes-frozen
