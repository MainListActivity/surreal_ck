#!/usr/bin/env bash
set -euo pipefail
P=/workspace/scratch/115bfa675150/native-client-probe
cd "$P/surreal_ck"
export RUSTUP_HOME="$P/rustup" CARGO_HOME="$P/cargo"
export PATH="$CARGO_HOME/bin:$PATH" CARGO_TARGET_DIR="$PWD/native-client/target" CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1
export PKG_CONFIG_PATH="$P/sysroot/usr/lib/x86_64-linux-gnu/pkgconfig:$P/sysroot/usr/share/pkgconfig" PKG_CONFIG_SYSROOT_DIR="$P/sysroot" LIBCLANG_PATH="$P/sysroot/usr/lib/llvm-19/lib"
export LD_LIBRARY_PATH="$P/sysroot/usr/lib/x86_64-linux-gnu:$P/sysroot/usr/lib/llvm-19/lib"
D=/workspace/scratch/115bfa675150/client-cancellation-final
python - <<'PY' > "$D/pre-hashes.json"
import subprocess,pathlib,hashlib,json
paths=subprocess.check_output(['git','ls-files','native-client','native-transport','native-call','native-media-platform','native-video-view','native-identity','native-signaling','native-updater','native-updater-platform'],text=True).splitlines()
print(json.dumps({p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest() for p in paths if pathlib.Path(p).suffix in ('.rs','.toml','.lock','.h','.m') and '/validation/' not in p},indent=2))
PY
cargo test --manifest-path native-client/Cargo.toml --locked --offline --lib --test ui --features experimental-enterprise-media --config 'profile.test.package.nsh-app-native-client.debug=0' --config 'profile.test.package.nsh-app-native-client.strip="debuginfo"' 2>&1 | tee "$D/client-test.log"
cargo clippy --manifest-path native-client/Cargo.toml --locked --offline --lib --features experimental-enterprise-media -- -D warnings 2>&1 | tee "$D/client-clippy.log"
cargo check --manifest-path native-client/Cargo.toml --locked --offline --lib 2>&1 | tee "$D/client-default-check.log"
python - <<'PY' > "$D/post-hashes.log"
import pathlib,hashlib,json
p=pathlib.Path('/workspace/scratch/115bfa675150/client-cancellation-final/pre-hashes.json'); d=json.loads(p.read_text());bad=[]
for f,h in d.items():
 if hashlib.sha256(pathlib.Path(f).read_bytes()).hexdigest()!=h:bad.append(f)
print('Checked',len(d),'inputs; mismatches:',bad)
assert not bad
PY
