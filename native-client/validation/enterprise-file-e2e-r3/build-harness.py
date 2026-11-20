#!/usr/bin/env python3
"""仅组合原样生产源码和cfg(test)夹具；此脚本不编译、不启动数据库。"""
import argparse
import hashlib
import json
import pathlib
import re

PACKAGE = "surreal-ck-enterprise-file-e2e-r3"
HERE = pathlib.Path(__file__).resolve().parent
p = argparse.ArgumentParser(description=__doc__)
p.add_argument("--repo", required=True, type=pathlib.Path)
p.add_argument("--refresh-receipt-only", action="store_true")
a = p.parse_args()
repo = a.repo.resolve(strict=True)
identity = repo / "native-identity"
root = (identity / "src/lib.rs").read_text()
root = re.sub(
    r"(?m)^mod (\w+);$",
    lambda m: f'#[path = {json.dumps(str(identity / "src" / (m[1] + ".rs")))}]\nmod {m[1]};',
    root,
)
root += '''
#[cfg(not(all(target_os = "linux", feature = "experimental-enterprise-files")))]
compile_error!("此夹具仅支持Linux真实UDP文件验收，需显式experimental-enterprise-files");
#[cfg(any(feature = "experimental-enterprise-media", feature = "android-auto-update"))]
compile_error!("此夹具不包含媒体、Android宿主或系统文件选择器验收");
extern crate self as surreal_ck_native_identity;
extern crate self as surreal_ck_native_signaling;
'''
for name, path in [
    ("protocol", "native-signaling/src/protocol.rs"),
    ("session", "native-signaling/src/session.rs"),
    ("enterprise_peer", "native-client/src/enterprise_peer.rs"),
    ("enterprise_files", "native-client/src/enterprise_files.rs"),
    ("file_dialogs", "native-client/src/file_dialogs.rs"),
]:
    root += f'#[path = {json.dumps(str(repo / path))}]\npub mod {name};\n'
root += 'pub use session::Signaling;\npub use protocol::Error;\n'
root += (HERE / "real_files.rs").read_text()
manifest = (identity / "Cargo.toml").read_text()
manifest = manifest.replace('name = "surreal-ck-native-identity"', f'name = "{PACKAGE}"')
manifest = manifest.replace('edition = "2021"', 'edition = "2024"')
manifest = manifest.replace(
    "[dependencies]",
    '[lib]\npath = "lib.rs"\n\n[features]\ndefault = []\n'
    'experimental-enterprise-signaling = []\n'
    'experimental-enterprise-files = ["experimental-enterprise-signaling"]\n'
    'experimental-enterprise-media = []\nandroid-auto-update = []\n\n'
    '[dependencies]\nnsh-core = "0.4.0"\n'
    'surreal-ck-peer-transport = { path = '
    + json.dumps(str(repo / "native-transport")) + ' }',
)
for name, content in [("lib.rs", root), ("Cargo.toml", manifest)]:
    target = HERE / name
    if a.refresh_receipt_only:
        if not target.exists() or target.read_text() != content:
            raise SystemExit(f"拒绝绑定不匹配的生成文件：{target}；需先重新生成并重新编译")
    else:
        target.write_text(content)

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

inputs = set()
for directory in [
    "native-identity/src", "native-identity/sql", "native-signaling/src",
    "native-transport/src", "shared/sql/workspace-template",
]:
    inputs.update(f for f in (repo / directory).rglob("*") if f.is_file())
for path in [
    "AGENTS.md", "native-identity/Cargo.toml", "native-signaling/Cargo.toml",
    "native-transport/Cargo.toml", "native-client/Cargo.toml",
    "native-client/src/enterprise_peer.rs", "native-client/src/enterprise_files.rs",
    "native-client/src/file_dialogs.rs",
]:
    inputs.add(repo / path)
harness_inputs = [
    "build-harness.py", "verify-inputs.py", "run-real-udp.sh", "real_files.rs",
    "lib.rs", "Cargo.toml", "README.md",
]
if (HERE / "Cargo.lock").exists():
    harness_inputs.append("Cargo.lock")
receipt = {
    "schema": 1,
    "scope": "source-only; not build or test evidence",
    "package": PACKAGE,
    "fork_version_contains": "3.3.0-native-quota.1+sha.f30704bce914",
    "features": ["experimental-enterprise-files"],
    "lock_present": (HERE / "Cargo.lock").exists(),
    "repo_inputs": {str(f.relative_to(repo)): sha(f) for f in sorted(inputs)},
    "harness_inputs": {name: sha(HERE / name) for name in sorted(harness_inputs)},
}
(HERE / "source-receipt.json").write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + "\n")
print(f"已生成源码与摘要：{HERE}；未编译、未运行。")
