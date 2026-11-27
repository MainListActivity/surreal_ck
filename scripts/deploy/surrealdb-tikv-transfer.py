#!/usr/bin/env python3
"""将已停写的 RocksDB 数据逻辑导入专用 TiKV；不操作服务、流量或 RocksDB 目录。"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import re
import sys


spec = importlib.util.spec_from_file_location("upgrade", Path(__file__).with_name("surrealdb-upgrade.py"))
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)

MANIFEST = "transfer.json"
ENDPOINT = re.compile(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})/?")
MAX_DATABASE_WORKERS = 4


def check_server(endpoint, backend, git_sha):
    url = ENDPOINT.fullmatch(endpoint)
    if not url or int(url[1]) > 65535:
        raise RuntimeError("必须提供显式端口的 127.0.0.1 HTTP 地址")
    capability = upgrade.request(endpoint + "/capabilities")
    upgrade.validate_capability(capability, backend)
    if capability.get("build", {}).get("git_sha") != git_sha:
        raise RuntimeError("运行实例与核准的 Git SHA 不符")


def root_catalog(endpoint, auth):
    root = upgrade.sql(endpoint, auth, "INFO FOR ROOT;")
    supported = {"users", "namespaces", "defaults", "config", "nodes", "system"}
    if set(root["users"]) != {auth[0]} or any(value for key, value in root.items() if key not in supported):
        raise RuntimeError("存在需单独迁移的 root 级定义")
    defaults = root.get("defaults") or {}
    if defaults:
        if set(defaults) - {"namespace", "database"}:
            raise RuntimeError("存在不支持的默认命名空间配置")
        upgrade.identifier(defaults["namespace"])
        if "database" in defaults:
            upgrade.identifier(defaults["database"])
    return root["namespaces"], defaults, root.get("config", {})


def table_catalog(endpoint, auth, ns, db, tables):
    names = sorted(tables)
    statements = [f"INFO FOR TABLE {upgrade.identifier(name)};" for name in names]
    results = upgrade.sql_batch(endpoint, auth, statements, ns, db)
    return {
        name: {key: value for key, value in result.items() if key != "lives"}
        for name, result in zip(names, results, strict=True)
    }


def quota_state(endpoint, auth, ns, db):
    quota = f"INFO FOR QUOTA ON DATABASE {upgrade.identifier(db)}"
    result = upgrade.sql(endpoint, auth, quota + " STRUCTURE;", ns, db)
    if result.get("policy") is None:
        return None
    if result["ledger"]["usage_trusted"] is not True:
        raise RuntimeError("已有配额的用量账本不可信")
    return {
        "definition": upgrade.sql(endpoint, auth, quota + ";", ns, db),
        "rules": result["policy"]["rules"],
        "usage": result["usage"],
    }


def snapshot(endpoint, auth, *, include_counts=True):
    namespaces, defaults, config = root_catalog(endpoint, auth)
    if not namespaces:
        raise RuntimeError("来源没有可迁移的命名空间")
    output = {}
    entries = []
    for ns, definition in sorted(namespaces.items()):
        upgrade.identifier(ns)
        metadata = upgrade.sql(endpoint, auth, "INFO FOR NS;", ns)
        if any(value for key, value in metadata.items() if key != "databases"):
            raise RuntimeError("存在需单独迁移的命名空间级定义")
        output[ns] = {"definition": definition, "databases": {}}
        for db, ddl in sorted(metadata["databases"].items()):
            upgrade.identifier(db)
            entries.append((ns, db, ddl))
    if not entries:
        raise RuntimeError("来源没有可迁移的数据库")

    def collect(entry):
        ns, db, ddl = entry
        catalog = upgrade.sql(endpoint, auth, "INFO FOR DB;", ns, db)
        tables = catalog["tables"]
        metadata = {
            "definition": ddl,
            "catalog": catalog,
            "tables": table_catalog(endpoint, auth, ns, db, tables),
            "quota": quota_state(endpoint, auth, ns, db),
        }
        if include_counts:
            metadata["counts"] = upgrade.database_counts(endpoint, auth, ns, db, tables)
        return ns, db, metadata

    with ThreadPoolExecutor(max_workers=MAX_DATABASE_WORKERS) as pool:
        for ns, db, metadata in pool.map(collect, entries):
            output[ns]["databases"][db] = metadata
    return {"namespaces": output, "defaults": defaults, "config": config}


def without_counts(catalog):
    return {
        **catalog,
        "namespaces": {
            ns: {
                **namespace,
                "databases": {
                    db: {key: value for key, value in metadata.items() if key != "counts"}
                    for db, metadata in namespace["databases"].items()
                },
            }
            for ns, namespace in catalog["namespaces"].items()
        },
    }


def databases(catalog):
    return ((ns, db, meta) for ns, cfg in catalog.items() for db, meta in cfg["databases"].items())


def private_workspace(path):
    if path.is_symlink() or not path.is_dir():
        raise RuntimeError("数据包必须位于非符号链接目录")
    if path.stat().st_uid != os.geteuid() or path.stat().st_mode & 0o077:
        raise RuntimeError("数据包目录必须由当前操作用户独占")


def export_bundle(endpoint, auth, path):
    path.mkdir(mode=0o700)
    private_workspace(path)
    catalog = snapshot(endpoint, auth)

    def export_entry(entry):
        i, (ns, db, _) = entry
        raw = path / f"{i}.surql"
        restore = path / f"{i}.import.surql"
        upgrade.export_database(endpoint, auth, ns, db, raw)
        access = upgrade.transform_export(raw, restore)
        return {
            "sha256": upgrade.digest(restore),
            "access_key_replacements": access["replacements"],
        }

    with ThreadPoolExecutor(max_workers=MAX_DATABASE_WORKERS) as pool:
        artifacts = list(pool.map(export_entry, enumerate(databases(catalog["namespaces"]))))
    # 来源已围栏。保留导出前的完整计数供恢复核对，导出后只重查目录和可信用量。
    if snapshot(endpoint, auth, include_counts=False) != without_counts(catalog):
        raise RuntimeError("导出期间数据目录或配额状态发生变化")
    with upgrade.private_file(path / MANIFEST) as f:
        f.write(json.dumps({"version": 1, "catalog": catalog, "artifacts": artifacts}).encode())
    return {"namespaces": len(catalog["namespaces"]), "databases": len(artifacts)}


def read_bundle(path):
    private_workspace(path)
    manifest = path / MANIFEST
    private_artifact(manifest)
    data = json.loads(manifest.read_text())
    if data.get("version") != 1:
        raise RuntimeError("不支持的数据包版本")
    return data


def private_artifact(path):
    if not path.is_file() or path.is_symlink():
        raise RuntimeError("数据包只接受普通文件")
    info = path.stat()
    if info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise RuntimeError("数据包文件必须由当前操作用户独占")


def restore_bundle(endpoint, auth, path, allow_key_rotation):
    data = read_bundle(path)
    catalog, artifacts = data["catalog"], data["artifacts"]
    entries = list(databases(catalog["namespaces"]))
    if not entries or len(entries) != len(artifacts):
        raise RuntimeError("数据包不完整")
    if not allow_key_rotation and any(x["access_key_replacements"] for x in artifacts):
        raise RuntimeError("数据包需要明确授权轮换现有 access 签发密钥")
    for i, artifact in enumerate(artifacts):
        restore = path / f"{i}.import.surql"
        private_artifact(restore)
        if upgrade.digest(restore) != artifact["sha256"]:
            raise RuntimeError("数据包文件校验失败")
    namespaces, defaults, config = root_catalog(endpoint, auth)
    if namespaces or defaults:
        raise RuntimeError("恢复目标必须为空")
    if config != catalog["config"]:
        raise RuntimeError("恢复目标的实例配置与来源不符")
    for ns, cfg in catalog["namespaces"].items():
        upgrade.identifier(ns)
        upgrade.sql(endpoint, auth, cfg["definition"])
    for i, (ns, db, meta) in enumerate(entries):
        upgrade.identifier(db)
        upgrade.sql(endpoint, auth, meta["definition"], ns)
        upgrade.http_transfer(endpoint, auth, ns, db, path / f"{i}.import.surql", importing=True)
        if meta["quota"] is not None:
            upgrade.sql(endpoint, auth, meta["quota"]["definition"], ns, db)
            upgrade.sql(endpoint, auth, f"REBUILD QUOTA IF NEEDED ON DATABASE {upgrade.identifier(db)};", ns, db)
    defaults = catalog["defaults"]
    if defaults:
        definition = f"DEFINE CONFIG DEFAULT NAMESPACE {upgrade.identifier(defaults['namespace'])}"
        if "database" in defaults:
            definition += f" DATABASE {upgrade.identifier(defaults['database'])}"
        upgrade.sql(endpoint, auth, definition + ";")
    return verify_bundle(endpoint, auth, path)


def verify_bundle(endpoint, auth, path):
    expected = read_bundle(path)["catalog"]
    if snapshot(endpoint, auth) != expected:
        raise RuntimeError("命名空间、目录定义、记录数或配额状态校验失败")
    namespaces = expected["namespaces"]
    return {"namespaces": len(namespaces), "databases": sum(1 for _ in databases(namespaces))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["export", "restore", "verify"])
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--git-sha", required=True)
    parser.add_argument("--confirm-isolated-and-fenced", action="store_true")
    parser.add_argument("--allow-access-key-rotation", action="store_true")
    args = parser.parse_args()
    if os.geteuid() != 0 or not args.confirm_isolated_and_fenced:
        raise RuntimeError("必须由 root 确认可写流量已隔离、目标集群专用且未接入应用")
    if not re.fullmatch(r"[0-9a-f]{40}", args.git_sha):
        raise RuntimeError("必须提供核准的完整 Git SHA")
    endpoint = args.endpoint.rstrip("/")
    check_server(endpoint, "rocksdb" if args.mode == "export" else "tikv", args.git_sha)
    auth = upgrade.credentials()
    if args.mode == "export":
        result = export_bundle(endpoint, auth, args.bundle)
    elif args.mode == "restore":
        result = restore_bundle(endpoint, auth, args.bundle, args.allow_access_key_rotation)
    else:
        result = verify_bundle(endpoint, auth, args.bundle)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as exc:
        sys.exit(str(exc))
    except (ValueError, OSError, KeyError, TypeError):
        sys.exit("迁移失败；检查受保护的本机证据和运行实例，不要启用业务写入")
