#!/usr/bin/env python3
"""校验编译输入；成功仅表示文件一致，不代表二进制曾由这些源码构建。"""
import argparse
import hashlib
import json
import pathlib

p = argparse.ArgumentParser(description=__doc__)
p.add_argument("--repo", required=True, type=pathlib.Path)
p.add_argument("--require-lock", action="store_true")
a = p.parse_args()
repo = a.repo.resolve(strict=True)
here = pathlib.Path(__file__).resolve().parent
receipt = json.loads((here / "source-receipt.json").read_text())
if receipt.get("schema") != 1:
    raise SystemExit("不支持的源码回执格式")
if a.require_lock and (not receipt["lock_present"] or "Cargo.lock" not in receipt["harness_inputs"]):
    raise SystemExit("尚未固定Cargo.lock，不能用于构建/运行验收绑定")
count = 0
for group, base in [("repo_inputs", repo), ("harness_inputs", here)]:
    for name, expected in receipt[group].items():
        path = (base / name).resolve(strict=True)
        if not path.is_relative_to(base):
            raise SystemExit("回执路径超出预期源码目录")
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != expected:
            raise SystemExit(f"输入已改变，旧证据不可沿用：{name}")
        count += 1
print(f"源码摘要一致：{count}个文件；不是编译/行为测试结果。")
