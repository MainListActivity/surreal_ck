#!/usr/bin/env bash
# Refuse emulated/cross-target runners rather than labeling them native coverage.
set -euo pipefail
expected=${1:?expected native Rust host triple required}
case "$expected" in
  aarch64-apple-darwin) cpu=arm64; os=Darwin ;;
  x86_64-apple-darwin) cpu=x86_64; os=Darwin ;;
  x86_64-pc-windows-msvc) cpu=x86_64; os=Windows ;;
  x86_64-unknown-linux-gnu) cpu=x86_64; os=Linux ;;
  *) echo 'Unsupported native host expectation' >&2; exit 2 ;;
esac
host=$(rustc -vV | sed -n 's/^host: //p')
actual_cpu=$(uname -m)
actual_os=$(uname -s)
printf 'Expected Rust host: %s\nActual Rust host: %s\nuname CPU: %s\nuname OS: %s\n' "$expected" "$host" "$actual_cpu" "$actual_os"
[[ "$host" == "$expected" && "$actual_cpu" == "$cpu" ]] || { echo 'Native CPU/toolchain mismatch; no cross-target fallback' >&2; exit 2; }
if [[ "$os" == Windows ]]; then
  [[ "$actual_os" == MINGW* || "$actual_os" == MSYS* ]] || { echo 'Windows Git Bash host required' >&2; exit 2; }
else
  [[ "$actual_os" == "$os" ]] || { echo 'Native OS mismatch' >&2; exit 2; }
fi
if [[ "$os" == Darwin ]]; then
  translated=$(sysctl -in sysctl.proc_translated 2>/dev/null || printf 0)
  [[ "$translated" != 1 ]] || { echo 'Rosetta process is not native target execution' >&2; exit 2; }
fi
