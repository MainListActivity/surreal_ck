#!/usr/bin/env python3
"""加密归档和恢复同版公司 SurrealDB fork 的逻辑数据库备份。"""

import argparse
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import time

spec = importlib.util.spec_from_file_location("transfer", Path(__file__).with_name("surrealdb-tikv-transfer.py"))
transfer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)
upgrade = transfer.upgrade

OBJECT = re.compile(r"surrealdb-[0-9]{8}T[0-9]{12}Z\.cms")
DIGEST = re.compile(r"[a-f0-9]{64}")


def run(*command):
    return subprocess.run(command, check=True, stdin=subprocess.DEVNULL,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def remote_digest(command, destination):
    with subprocess.Popen([*command, "cat", destination], stdout=subprocess.PIPE,
                          stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as process:
        digest = hashlib.sha256()
        while chunk := process.stdout.read(upgrade.TRANSFER_CHUNK):
            digest.update(chunk)
        if process.wait() != 0:
            raise RuntimeError("异地读取校验失败")
        return digest.hexdigest()


def archive(bundle, output, certificate):
    plaintext = bundle.parent / "backup.tar.gz"
    with tarfile.open(plaintext, "w:gz", compresslevel=1) as tar:
        tar.add(bundle / transfer.MANIFEST, arcname=transfer.MANIFEST)
        for artifact in sorted(bundle.glob("*.import.surql")):
            tar.add(artifact, arcname=artifact.name)
    run("openssl", "cms", "-encrypt", "-binary", "-stream", "-aes-256-gcm",
        "-outform", "DER", "-in", str(plaintext), "-out", str(output), str(certificate))


def unpack(archive_path, bundle, certificate, key):
    plaintext = bundle.parent / "restore.tar"
    run("openssl", "cms", "-decrypt", "-binary", "-inform", "DER", "-in", str(archive_path),
        "-recip", str(certificate), "-inkey", str(key), "-out", str(plaintext))
    bundle.mkdir(mode=0o700)
    with tarfile.open(plaintext, "r:*") as tar:
        for member in tar:
            if not member.isfile() or (member.name != transfer.MANIFEST and
                                       not re.fullmatch(r"[0-9]+\.import\.surql", member.name)):
                raise RuntimeError("归档成员无效")
            with tar.extractfile(member) as source, upgrade.private_file(bundle / member.name) as target:
                while chunk := source.read(1024 * 1024):
                    target.write(chunk)


def credentials(path):
    transfer.private_artifact(path)
    with path.open() as stream:
        values = json.load(stream)
    user, password = values["user"], values["password"]
    if not isinstance(user, str) or not user or not isinstance(password, str) or not password:
        raise RuntimeError("数据库凭证缺失")
    return user, password


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("backup", "restore"))
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--backend", choices=("rocksdb", "tikv"), default="rocksdb",
                        help="当前实例的存储后端（默认 rocksdb）")
    parser.add_argument("--git-sha", required=True)
    parser.add_argument("--credentials", required=True, type=Path)
    parser.add_argument("--scratch", required=True, type=Path)
    parser.add_argument("--certificate", required=True, type=Path)
    parser.add_argument("--rclone-config", required=True, type=Path)
    parser.add_argument("--remote", required=True, help="受限异地 rclone remote:bucket/prefix")
    parser.add_argument("--object")
    parser.add_argument("--sha256")
    parser.add_argument("--key", type=Path)
    parser.add_argument("--allow-access-key-rotation", action="store_true")
    parser.add_argument("--confirm-fenced-source", action="store_true")
    parser.add_argument("--confirm-isolated-target", action="store_true")
    args = parser.parse_args()
    started = time.monotonic()
    os.umask(0o077)
    transfer.private_workspace(args.scratch)
    transfer.private_artifact(args.rclone_config)
    if not re.fullmatch(r"[a-f0-9]{40}", args.git_sha):
        raise RuntimeError("需要 fork 完整 Git SHA")
    if not re.fullmatch(r"[A-Za-z0-9_-]+:[A-Za-z0-9_/-]+", args.remote):
        raise RuntimeError("异地路径无效")
    if args.mode == "backup" and not args.confirm_fenced_source:
        raise RuntimeError("备份要求已有写围栏覆盖全部数据库写入者")
    if args.mode == "restore":
        if not args.confirm_isolated_target or not args.key or not OBJECT.fullmatch(args.object or "") or not DIGEST.fullmatch(args.sha256 or ""):
            raise RuntimeError("恢复需要隔离目标、归档名、独立 SHA256 和解密密钥")
        transfer.private_artifact(args.key)
    endpoint = args.endpoint.rstrip("/")
    with (args.scratch / ".surrealdb-backup.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        transfer.check_server(endpoint, args.backend, args.git_sha)
        auth = credentials(args.credentials)
        with tempfile.TemporaryDirectory(dir=args.scratch) as temporary:
            work = Path(temporary)
            bundle = work / "bundle"
            name = args.object or datetime.datetime.now(datetime.timezone.utc).strftime("surrealdb-%Y%m%dT%H%M%S%fZ.cms")
            if not OBJECT.fullmatch(name):
                raise RuntimeError("归档名无效")
            file = work / name
            destination = f"{args.remote.rstrip('/')}/{name}"
            command = ["rclone", "--config", str(args.rclone_config)]
            if args.mode == "backup":
                result = transfer.export_bundle(endpoint, auth, bundle)
                archive(bundle, file, args.certificate)
                checksum = upgrade.digest(file)
                run(*command, "copyto", str(file), destination, "--immutable")
                if remote_digest(command, destination) != checksum:
                    raise RuntimeError("异地对象校验失败")
            else:
                run(*command, "copyto", destination, str(file))
                checksum = upgrade.digest(file)
                if checksum != args.sha256:
                    raise RuntimeError("归档校验失败")
                unpack(file, bundle, args.certificate, args.key)
                result = transfer.restore_bundle(endpoint, auth, bundle, args.allow_access_key_rotation)
            print(json.dumps({"status": "ok", "mode": args.mode, "object": name, "sha256": checksum,
                              "backend": args.backend, "fork_sha": args.git_sha,
                              "seconds": round(time.monotonic() - started, 2), **result}))


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        sys.exit(str(error))
    except (OSError, KeyError, ValueError, TypeError, subprocess.SubprocessError, tarfile.TarError):
        sys.exit("备份或恢复失败；核查受限配置、远端状态与目标实例")
