#!/usr/bin/env python3
import argparse
import hashlib
import hmac
import json
import re
import sys
from pathlib import Path


def verify(directory: Path, trusted_root: str) -> int:
    if not re.fullmatch(r"[a-fA-F0-9]{64}", trusted_root):
        raise ValueError("可信根 SHA-256 必须为 64 位十六进制")
    manifest = (directory / "manifest.json").read_bytes()
    if not hmac.compare_digest(hashlib.sha256(manifest).hexdigest(), trusted_root.lower()):
        raise ValueError("清单 SHA-256 不匹配")
    decoded = json.loads(manifest)
    if not isinstance(decoded, dict) or decoded.get("version") != 1 or not isinstance(decoded.get("files"), list):
        raise ValueError("不支持的清单格式")
    seen = set()
    for item in decoded["files"]:
        name = item["path"]
        if not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}", name) or name in seen:
            raise ValueError("清单产物名称无效或重复")
        seen.add(name)
        file = directory / name
        if file.is_symlink() or not file.is_file():
            raise ValueError(f"缺少存证产物或产物类型无效: {name}")
        digest = hashlib.sha256()
        size = 0
        with file.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                size += len(chunk)
                digest.update(chunk)
        if size != item["bytes"] or not hmac.compare_digest(digest.hexdigest(), item["sha256"]):
            raise ValueError(f"产物 SHA-256 或长度不匹配: {name}")
    if "ledger.json" not in seen:
        raise ValueError("清单缺少权威账本")
    return len(seen)


def main() -> int:
    parser = argparse.ArgumentParser(description="使用独立取得的可信根，离线校验解包后的会议存证。")
    parser.add_argument("directory", type=Path)
    parser.add_argument("--trusted-root", required=True, help="独立存证域提供的可信 SHA-256，不信任包内根")
    options = parser.parse_args()
    try:
        count = verify(options.directory, options.trusted_root)
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(f"会议存证校验失败: {error}", file=sys.stderr)
        return 1
    print(f"会议存证校验通过: {count} 项产物")
    return 0


if __name__ == "__main__":
    sys.exit(main())
