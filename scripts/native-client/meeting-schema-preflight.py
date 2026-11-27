#!/usr/bin/env python3
"""为会议验收输出只读的候选提交与 workspace 模板标识。"""

import argparse
import hashlib
import json
import re
import subprocess


TEMPLATE_DIR = "shared/sql/workspace-template/"
MIGRATION_NAME = re.compile(r"([0-9]{3})-.+\.surql")
COMMIT_SHA = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?")


def git(*args: str) -> bytes:
    return subprocess.run(
        ["git", "--no-replace-objects", *args], check=True, capture_output=True,
    ).stdout


def inspect_schema(candidate: str, meeting_migration: str) -> dict[str, str | int]:
    if not COMMIT_SHA.fullmatch(candidate):
        raise ValueError("候选必须是完整 Git 提交 SHA，不能使用分支、tag 或缩写。")
    if "/" in meeting_migration or not MIGRATION_NAME.fullmatch(meeting_migration):
        raise ValueError("会议迁移必须是 workspace 模板内带版本号的文件名。")
    if git("cat-file", "-t", candidate).strip() != b"commit":
        raise ValueError("候选 SHA 必须指向提交。")

    files: dict[int, str] = {}
    entries = git("ls-tree", "-z", "--full-tree", candidate, "--", TEMPLATE_DIR)
    for entry in entries.split(b"\0")[:-1]:
        metadata, path = entry.split(b"\t", 1)
        name = path.decode("utf-8").removeprefix(TEMPLATE_DIR)
        if not name.endswith(".surql"):
            continue
        match = MIGRATION_NAME.fullmatch(name)
        if metadata.split()[0] not in (b"100644", b"100755") or not match:
            raise ValueError("workspace 模板包含非法迁移文件。")
        version = int(match[1])
        if version in files:
            raise ValueError(f"workspace 模板版本重复：{version:03d}。")
        files[version] = name
    if sorted(files) != list(range(1, len(files) + 1)):
        raise ValueError("workspace 模板版本不从 001 连续递增。")
    if meeting_migration not in files.values():
        raise ValueError("候选提交缺少指定的会议迁移。")

    sql = git("cat-file", "blob", f"{candidate}:{TEMPLATE_DIR}{meeting_migration}")
    if not sql.strip():
        raise ValueError("会议迁移为空。")
    return {
        "candidate_sha": candidate,
        "meeting_migration": meeting_migration,
        "meeting_migration_sha256": hashlib.sha256(sql).hexdigest(),
        "workspace_template_version": max(files),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True, help="本地 Git 中的完整提交 SHA")
    parser.add_argument("--migration", required=True, help="会议迁移 .surql 文件名")
    args = parser.parse_args()
    try:
        receipt = inspect_schema(args.candidate, args.migration)
    except (OSError, subprocess.CalledProcessError):
        parser.error("无法读取本地 Git 对象；请在仓库中确认候选 SHA 已获取。")
    except ValueError as error:
        parser.error(str(error))
    print(json.dumps(receipt, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
