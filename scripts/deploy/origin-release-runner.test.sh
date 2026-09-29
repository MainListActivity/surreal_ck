#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT
export ORIGIN_ROOT="$test_root/origin"
export ORIGIN_ENV_FILE="$test_root/server.env"
export ORIGIN_HEALTH_URL=http://127.0.0.1:8080/health
export TEST_SERVICE_STATE="$test_root/service-state"
export HOME="$test_root/home"
export PATH="$test_root/bin:$PATH"
mkdir -p "$ORIGIN_ROOT/releases/old" "$test_root/bin" "$HOME/.bun/bin" "$test_root/payload/scripts/deploy"
ln -s "$ORIGIN_ROOT/releases/old" "$ORIGIN_ROOT/current"
printf '%s\n' 'FAKE=1' >"$ORIGIN_ENV_FILE"
printf '%s\n' running >"$TEST_SERVICE_STATE"

cat >"$test_root/bin/bunx" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat >"$test_root/bin/sudo" <<'SH'
#!/usr/bin/env bash
shift # -n
case "$1 $2" in
  'systemctl stop') printf '%s\n' stopped >"$TEST_SERVICE_STATE" ;;
  'systemctl restart') printf '%s\n' running >"$TEST_SERVICE_STATE" ;;
esac
SH
cat >"$test_root/bin/curl" <<'SH'
#!/usr/bin/env bash
[ "$(cat "$TEST_SERVICE_STATE")" = running ] || exit 7
printf '%s\n' '{"status":"ok","surrealdb":"up"}'
SH
cat >"$test_root/bin/mv" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = -T ]; then
  shift
  /bin/rm -f "$2"
  exec /bin/mv -f "$@"
fi
exec /bin/mv "$@"
SH
cat >"$test_root/payload/scripts/deploy/origin-pre-start.sh" <<'SH'
#!/usr/bin/env bash
sleep 2
printf '%s\n' done >"$ORIGIN_ROOT/hook-completed"
SH
chmod +x "$test_root/bin/"* 
ln -s "$test_root/bin/bunx" "$HOME/.bun/bin/bunx"
tar -czf "$test_root/archive.tar.gz" -C "$test_root/payload" .
cp "$script_dir/origin-release.sh" "$test_root/release.sh"

# Kill the shell representing the SSH client immediately after launch. The
# detached release must finish without that client or any reconnect action.
bash -c 'bash "$1" launch test-ci1 "$2" "$3" ""; kill -9 "$$"' \
  _ "$script_dir/origin-release-runner.sh" "$test_root/release.sh" "$test_root/archive.tar.gz" \
  >/dev/null 2>&1 || true
bash "$script_dir/origin-release-runner.sh" launch test-ci1 \
  "$test_root/release.sh" "$test_root/archive.tar.gz" '' >/dev/null

for _ in $(seq 1 40); do
  result=$(bash "$script_dir/origin-release-runner.sh" status test-ci1)
  [ "$result" = success ] && break
  [ "$result" = running ] || {
    echo "unexpected result: $result" >&2
    cat "$ORIGIN_ROOT/deploy-jobs/test-ci1/output.log" >&2
    exit 1
  }
  sleep 0.25
done
[ "$result" = success ]
[ "$(cat "$ORIGIN_ROOT/hook-completed")" = done ]
[ "$(cat "$TEST_SERVICE_STATE")" = running ]
[ "$(readlink "$ORIGIN_ROOT/current")" = "$ORIGIN_ROOT/releases/test-ci1" ]
[ "$(ls -1 "$ORIGIN_ROOT/releases" | wc -l)" -eq 2 ]
echo 'actual release hook, switch, restart, and health check completed after launcher died'
