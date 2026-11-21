#!/usr/bin/env python3
"""通过导出/导入升级公司 fork；旧 RocksDB 目录不交给新 binary。"""

import argparse
import base64
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tarfile
import time
import urllib.request
import urllib.parse


SOURCE = "3.3.0-native-quota.1"
TARGET = "4.0.1-native-quota.1"
CONFIRMATION = "UPGRADE 3.3 TO 4.0"
SERVICE = "surrealdb.service"
ORIGIN = "surreal-ck-hono.service"
CONTAINER = "surrealdb"
PODMAN = "/usr/bin/podman"
ENV_FILE = Path("/etc/surrealdb/surrealdb.env")
DATA = Path("/home/ubuntu/surreal_ck/data-native")
BACKUPS = Path("/home/ubuntu/surreal_ck/backups")
SOURCE_IMAGE = "ghcr.io/mainlistactivity/surrealdb-native-quota@sha256:4873ac9db79f91196f2b5e6129263d660700fcbfad0c5e1d90595bd3d384dcf8"
UNIT = Path("/etc/systemd/system/surrealdb.service")
DROPIN = Path("/etc/systemd/system/surrealdb.service.d/90-sck-upgrade.conf")
LOCK = Path("/run/lock/surrealdb-upgrade.lock")
RELEASES = Path("/opt/surrealdb/releases")
ORIGIN_CONTRACT = Path("/home/ubuntu/surreal_ck/current/shared/src/native-quota/compatibility.ts")


def run(*args, env=None):
    result = subprocess.run(args, capture_output=True, text=True, env=env, check=False)
    if result.returncode:
        # CLI 失败正文可能含查询或认证内容，不传入 CI 日志。
        raise RuntimeError(f"{Path(args[0]).name} failed (exit {result.returncode})")
    return result.stdout.strip()


def digest(path):
    sha = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def parse_version(output):
    match = re.search(r"\b(\d+\.\d+\.\d+-native-quota\.\d+)(?:\+|\s|$)", output)
    if not match:
        raise RuntimeError("unrecognized company fork version")
    return match.group(1)


def redact(argv):
    result = []
    private = False
    for value in argv:
        if private:
            result.append("[REDACTED]")
            private = False
        elif value in ("--pass", "--password", "--user", "--username", "-p", "-u"):
            result.append(value)
            private = True
        elif re.match(r"--(?:pass|password|user|username)=", value):
            result.append(value.split("=", 1)[0] + "=[REDACTED]")
        else:
            result.append(value)
    return result


def local_endpoint(argv):
    bind = "127.0.0.1:8000"
    for index, arg in enumerate(argv):
        if arg == "--bind":
            bind = argv[index + 1]
        elif arg.startswith("--bind="):
            bind = arg.split("=", 1)[1]
    if not re.fullmatch(r"(?:127\.0\.0\.1|0\.0\.0\.0|localhost):\d+", bind):
        raise RuntimeError("only a plain IPv4 local HTTP listener is supported")
    return "http://127.0.0.1:" + bind.rsplit(":", 1)[1]


def container_entrypoint(container):
    binary = container.get("Path")
    if not isinstance(binary, str) or not binary.startswith("/"):
        raise RuntimeError("container executable must be absolute")
    return binary


def inspect():
    container = json.loads(run(PODMAN, "inspect", CONTAINER))[0]
    if not container.get("State", {}).get("Running"):
        raise RuntimeError("database container must be running for inspection")
    argv = container["Config"].get("CreateCommand", [])
    database_args = container.get("Args", [])
    engines = [engine for engine in ("rocksdb", "surrealkv") if f"{engine}:/data" in database_args]
    if len(engines) != 1:
        raise RuntimeError("expected one explicit container storage engine at /data")
    mounts = [mount for mount in container.get("Mounts", []) if mount.get("Destination") == "/data"]
    if len(mounts) != 1:
        raise RuntimeError("expected a single container data mount")
    data = Path(mounts[0]["Source"])
    if (data != DATA and not (data.parent == DATA.parent and data.name.startswith("data-native-4.0-"))) or not data.is_dir() or data.is_symlink():
        raise RuntimeError("unexpected container data mount; operator review required")
    image = container.get("ImageName") or container["Config"].get("Image")
    validate_image(image)
    binary = container_entrypoint(container)
    endpoint = local_endpoint(database_args)
    exec_start = run("systemctl", "show", SERVICE, "--property=ExecStart", "--value")
    unit_path = re.search(r"\bpath=([^ ;]+)", exec_start)
    if not unit_path:
        raise RuntimeError("unable to identify systemd ExecStart executable")
    capability = request(endpoint + "/capabilities")
    version_output = run(PODMAN, "exec", CONTAINER, binary, "version")
    report = {
        "service": SERVICE, "systemd_exec_start_path": unit_path[1],
        "running_argv": redact(argv), "binary": binary, "container_image": image,
        "database_args": redact(database_args),
        "storage_engine": engines[0],
        "architecture": platform.machine(),
        "binary_sha256": container_hash(binary), "version": parse_version(version_output), "version_output": version_output,
        "data_directory": str(data), "data_bytes": int(run("du", "-sb", str(data)).split()[0]),
        "free_bytes": shutil.disk_usage(data).free,
        "service_user": "root",
        "capabilities": capability,
    }
    return report, argv, data, endpoint


def container_hash(binary):
    process = subprocess.Popen([PODMAN, "cp", f"{CONTAINER}:{binary}", "-"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    sha = hashlib.sha256()
    found = False
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
            for member in archive:
                if member.isfile():
                    if found:
                        raise RuntimeError("unexpected container binary archive")
                    found = True
                    with archive.extractfile(member) as source:
                        for chunk in iter(lambda: source.read(1024 * 1024), b""):
                            sha.update(chunk)
        if process.wait() != 0 or not found:
            raise RuntimeError("cannot hash the actual container executable")
        return sha.hexdigest()
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.kill()
            process.wait()


def validate_image(image):
    if not isinstance(image, str) or not re.fullmatch(r"ghcr\.io/mainlistactivity/surrealdb-native-quota@sha256:[0-9a-f]{64}", image):
        raise RuntimeError("only a digest-pinned company fork image is supported")


def request(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.load(response)


def trusted_file(path, forbidden=0o022):
    info = path.stat()
    if info.st_uid != 0 or info.st_mode & forbidden or path.is_symlink():
        raise RuntimeError("host configuration and maintenance hooks must be root-owned and not group/world writable")


def host_env(path):
    trusted_file(path, forbidden=0o037)
    values = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.fullmatch(r"(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)", line.strip())
        if not match:
            raise RuntimeError("unsupported host environment file syntax")
        raw = match[2]
        parts = shlex.split(raw, comments=False) if raw.startswith(("'", '"')) else [raw]
        if len(parts) > 1:
            raise RuntimeError("environment values with spaces must be quoted")
        values[match[1]] = parts[0] if parts else ""
    return values


def credentials():
    values = host_env(ENV_FILE)
    user = values.get("SURREAL_USER") or values.get("SURREAL_ROOT_USER")
    password = values.get("SURREAL_PASS") or values.get("SURREAL_ROOT_PASS")
    if not user or not password:
        raise RuntimeError("root credentials missing from existing host surrealdb.env")
    return user, password


def sql(endpoint, auth, query, namespace=None, database=None):
    token = base64.b64encode(":".join(auth).encode()).decode()
    headers = {"Authorization": "Basic " + token, "Accept": "application/json", "Content-Type": "text/plain"}
    if namespace is not None:
        headers["surreal-ns"] = namespace
    if database is not None:
        headers["surreal-db"] = database
    result = request(endpoint + "/sql", query.encode(), headers)
    if not isinstance(result, list) or len(result) != 1 or result[0].get("status") != "OK":
        raise RuntimeError("database inventory query failed")
    return result[0]["result"]


def identifier(name):
    if not re.fullmatch(r"[A-Za-z0-9_]+", name):
        raise RuntimeError("unsupported namespace/database/table identifier; operator review required")
    return "`" + name + "`"


def inventory(endpoint, auth):
    result = {}
    for namespace in sorted(sql(endpoint, auth, "INFO FOR ROOT;")["namespaces"]):
        identifier(namespace)
        for database in sorted(sql(endpoint, auth, "INFO FOR NS;", namespace)["databases"]):
            identifier(database)
            tables = sql(endpoint, auth, "INFO FOR DB;", namespace, database)["tables"]
            counts = {}
            for table, definition in sorted(tables.items()):
                if " AS SELECT " in definition.upper():
                    continue
                rows = sql(endpoint, auth, f"SELECT count() AS count FROM {identifier(table)} GROUP ALL;", namespace, database)
                counts[table] = rows[0]["count"] if rows else 0
            result[(namespace, database)] = counts
    if not result:
        raise RuntimeError("refusing to upgrade an empty/unreadable inventory")
    return result


def unit(argv):
    if any("\n" in arg or "\r" in arg or "\0" in arg for arg in argv):
        raise RuntimeError("invalid service argument")
    quoted = ['"' + arg.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%").replace("$", "$$") + '"' for arg in argv]
    return "[Service]\nExecStart=\nExecStart=" + " ".join(quoted) + "\n"


def switch(argv):
    DROPIN.parent.mkdir(parents=True, exist_ok=True)
    temporary = DROPIN.with_suffix(".pending")
    temporary.write_text(unit(argv))
    temporary.chmod(0o600)
    temporary.replace(DROPIN)
    run("systemctl", "daemon-reload")


def wait_health(endpoint, origin=False):
    for _ in range(90):
        try:
            with urllib.request.urlopen(endpoint + "/health", timeout=5) as response:
                if response.status == 200:
                    if origin:
                        health = json.load(response)
                        if health.get("status") != "ok" or health.get("surrealdb") != "up":
                            continue
                    return
        except OSError:
            pass
        time.sleep(2)
    raise RuntimeError("health check did not become ready")


def validate_capability(capability, engine="rocksdb"):
    marker = capability.get("storage", {}).get("marker") or {}
    if (capability.get("manifest_revision") != "native-quota-v2.0"
            or capability.get("fork", {}).get("release") != TARGET
            or capability.get("fork", {}).get("id") != "mainlistactivity/surrealdb-native-quota"
            or capability.get("storage", {}).get("storage_version") != 32772
            or capability.get("storage", {}).get("ready") is not True
            or capability.get("storage", {}).get("state") != "ready"
            or capability.get("storage", {}).get("migration_required") is not False
            or capability.get("storage", {}).get("backend") != engine
            or capability.get("backend", {}).get("name") != engine
            or capability.get("backend", {}).get("hard_quota_certified") is not True
            or capability.get("backend", {}).get("production") is not True
            or capability.get("backend", {}).get("persistent_restart_certified") is not True
            or capability.get("backend", {}).get("certification_revision") != "native-quota-contract-v1"
            or capability.get("quota", {}).get("contract_major") != 1
            or marker.get("upstream_storage_major") != 4
            or marker.get("minimum_compatible_fork_release") != TARGET
            or marker.get("migration_state") != "clean"):
        raise RuntimeError("post-upgrade capability/storage identity mismatch")


def copy_data(source, destination):
    if destination.exists():
        raise RuntimeError("snapshot/recovery destination must be a new path")
    run("cp", "-a", "--reflink=auto", "--", str(source), str(destination))


def restore_drill(image, binary, snapshot, destination, auth, before):
    copy_data(snapshot, destination)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    drill_endpoint = f"http://127.0.0.1:{port}"
    name = "sck-restore-drill-" + str(os.getpid())
    run(PODMAN, "run", "--detach", "--rm", "--name", name, "--user", "0", "--network", "host",
        "--env-file", str(ENV_FILE), "-v", f"{destination}:/data", "--entrypoint", binary, image,
        "start", "--bind", f"127.0.0.1:{port}", "rocksdb:/data")
    try:
        wait_health(drill_endpoint)
        if inventory(drill_endpoint, auth) != before:
            raise RuntimeError("restored snapshot row counts differ")
    finally:
        run(PODMAN, "stop", "--time", "30", name)


def target_cli(image, binary=None, data=None, snapshot=None):
    command = [PODMAN, "run", "--rm", "--user", "0", "--network", "none"]
    if binary is not None:
        command += ["-v", f"{binary}:/surreal-upgrade:ro", "--entrypoint", "/surreal-upgrade"]
    if data is not None:
        command += ["-v", f"{data}:/data"]
    if snapshot is not None:
        command += ["-v", f"{snapshot}:/snapshot:ro"]
    return [*command, image]


def service_command(image, data, binary=None, engine="rocksdb"):
    command = [PODMAN, "run", "--rm", "--replace", "--user", "0", "--name", CONTAINER,
               "--network", "host", "--env-file", str(ENV_FILE), "-v", f"{data}:/data"]
    if binary is not None:
        command += ["-v", f"{binary}:/surreal-upgrade:ro", "--entrypoint", "/surreal-upgrade"]
    return [*command, image, "start", "--bind", "0.0.0.0:8000", "--allow-all", f"{engine}:/data"]


TRANSFER_CHUNK = 1024 * 1024
TRANSFER_TIMEOUT = 1800


def private_file(path):
    stream = open(path, "xb")
    try:
        os.fchmod(stream.fileno(), 0o600)
        os.fchown(stream.fileno(), 0, 0)
    except BaseException:
        stream.close()
        raise
    return stream


REDACTED_KEY = b"[REDACTED]"
ACCESS_TOKEN = re.compile(rb"'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|`(?:\\.|[^`\\])*`|[A-Za-z0-9_]+|[^\s]")


def transform_access_line(line):
    tokens = list(ACCESS_TOKEN.finditer(line))
    values = [token[0] for token in tokens]
    if values[:2] != [b"DEFINE", b"ACCESS"] or values[-1:] != [b";"]:
        raise RuntimeError("unsupported exported access definition")
    depth = 0
    spans = []
    record = None
    for index, value in enumerate(values):
        if depth == 0:
            if value == b";" and index != len(values) - 1:
                raise RuntimeError("multiple statements in exported access definition")
            if values[index:index + 2] == [b"TYPE", b"RECORD"]:
                name_index = 2
                if values[name_index:name_index + 1] == [b"OVERWRITE"]:
                    name_index += 1
                elif values[name_index:name_index + 3] == [b"IF", b"NOT", b"EXISTS"]:
                    name_index += 3
                record = values[name_index].strip(b"`").decode("utf-8")
                identifier(record)
            end = index
            if values[index:index + 3] == [b"WITH", b"JWT", b"ALGORITHM"]:
                if (values[index + 3:index + 4] in ([b"HS256"], [b"HS384"], [b"HS512"])
                        and values[index + 4:index + 5] == [b"KEY"]):
                    end = index + 5
            elif values[index:index + 3] == [b"WITH", b"ISSUER", b"KEY"]:
                end = index + 3
            if end != index and values[end:end + 1] in ([b"'[REDACTED]'"], [b'"[REDACTED]"']):
                last = end
                if values[end + 1:end + 2] == [b"ALGORITHM"]:
                    if values[end + 2:end + 3] not in ([b"HS256"], [b"HS384"], [b"HS512"]):
                        raise RuntimeError("unsupported redacted issuer algorithm")
                    last = end + 2
                spans.append((tokens[index].start(), tokens[last].end()))
        if value in (b"{", b"(", b"["):
            depth += 1
        elif value in (b"}", b")", b"]"):
            depth -= 1
        if depth < 0:
            raise RuntimeError("unsupported exported access nesting")
    if depth:
        raise RuntimeError("multiline exported access definition refused")
    for start, end in reversed(spans):
        line = line[:start] + line[end:]
    return line, len(spans), record


def transform_export(source, destination):
    replacements = 0
    records = []
    start_of_line = True
    tail = b""
    with open(source, "rb") as original, private_file(destination) as output:
        while chunk := original.readline(TRANSFER_CHUNK):
            if start_of_line and chunk.lstrip().startswith(b"DEFINE ACCESS "):
                if len(chunk) == TRANSFER_CHUNK and not chunk.endswith(b"\n"):
                    raise RuntimeError("exported access definition exceeds streaming limit")
                chunk, count, record = transform_access_line(chunk)
                replacements += count
                if record is not None:
                    records.append(record)
            if REDACTED_KEY in tail + chunk:
                raise RuntimeError("redaction placeholder outside permitted access key clauses")
            output.write(chunk)
            tail = chunk[-(len(REDACTED_KEY) - 1):]
            start_of_line = chunk.endswith(b"\n")
    return {"replacements": replacements, "record_accesses": records}


def validate_record_accesses(endpoint, auth, namespace, database, expected):
    accesses = sql(endpoint, auth, "INFO FOR DB;", namespace, database).get("accesses")
    if not isinstance(accesses, dict):
        raise RuntimeError("trial access catalog missing")
    for name in expected:
        definition = accesses.get(name)
        if not isinstance(definition, str) or transform_access_line((definition.rstrip(";") + ";").encode())[2] != name:
            raise RuntimeError("trial RECORD access definition missing or changed")


def http_transfer(endpoint, auth, namespace, database, path, importing=False):
    url = urllib.parse.urlsplit(endpoint)
    if (url.scheme != "http" or url.hostname != "127.0.0.1" or url.username is not None
            or url.path not in ("", "/") or url.query or url.fragment):
        raise RuntimeError("database transfer requires a loopback HTTP endpoint")
    operation = "import" if importing else "export"
    suffix = ".import.stderr.log" if importing else ".stderr.log"
    headers = {"Authorization": "Basic " + base64.b64encode(":".join(auth).encode()).decode(),
               "surreal-ns": namespace, "surreal-db": database, "Accept": "application/octet-stream"}
    connection = http.client.HTTPConnection(url.hostname, url.port or 80, timeout=TRANSFER_TIMEOUT,
                                             blocksize=TRANSFER_CHUNK)
    with private_file(path.with_name(path.name + suffix)) as errors:
        try:
            if importing:
                headers.update({"Content-Type": "application/octet-stream", "Content-Length": str(path.stat().st_size)})
                with open(path, "rb") as source:
                    connection.request("POST", "/import", body=source, headers=headers)
                destination = errors
            else:
                connection.request("GET", "/export", headers=headers)
                destination = private_file(path)
            response = None
            try:
                response = connection.getresponse()
                errors.write(f"HTTP {response.status}\n".encode())
                length = response.getheader("Content-Length")
                count = 0
                valid_dump = True
                while chunk := response.read(TRANSFER_CHUNK):
                    if not importing and count == 0:
                        valid_dump = chunk.lstrip().startswith(b"--")
                    (destination if response.status == 200 and valid_dump else errors).write(chunk)
                    count += len(chunk)
                if length is not None and count != int(length):
                    raise RuntimeError("incomplete HTTP response")
                if response.status != 200 or (count != 0 if importing else not count or not valid_dump):
                    raise RuntimeError("HTTP status or response body rejected")
            finally:
                if response is not None:
                    response.close()
                if not importing:
                    destination.close()
        except Exception as error:
            errors.write(("\n" + type(error).__name__ + ": " + str(error)).encode())
            raise RuntimeError(f"database HTTP {operation} failed; inspect protected backup log") from None
        finally:
            connection.close()


def export_database(endpoint, auth, namespace, database, output):
    http_transfer(endpoint, auth, namespace, database, output)


def import_database(endpoint, auth, namespace, database, source):
    sql(endpoint, auth, f"DEFINE NAMESPACE IF NOT EXISTS {identifier(namespace)};")
    sql(endpoint, auth, f"DEFINE DATABASE IF NOT EXISTS {identifier(database)};", namespace)
    sql(endpoint, auth, "ALTER DATABASE COMPATIBILITY 3;", namespace, database)
    http_transfer(endpoint, auth, namespace, database, source, importing=True)


def restore_unit(backup):
    previous = backup / "surrealdb.dropin.original"
    if previous.exists():
        shutil.copy2(previous, DROPIN)
    elif DROPIN.exists():
        DROPIN.unlink()
    run("systemctl", "daemon-reload")


def upgrade(args):
    if args.confirmation != CONFIRMATION or not args.approval_ref.strip():
        raise RuntimeError("upgrade requires exact typed confirmation and approval reference")
    if args.storage_engine not in ("rocksdb", "surrealkv"):
        raise RuntimeError("unsupported target storage engine")
    candidate = None
    if args.image:
        validate_image(args.image)
        receipt = json.loads(Path(args.receipt).read_text())
        if (receipt.get("stage") != "production" or receipt.get("candidate", {}).get("reference") != args.image
                or receipt.get("candidate", {}).get("release") != TARGET):
            raise RuntimeError("runner-verified production receipt does not match target image")
    else:
        candidate = Path(args.binary).resolve(strict=True)
        if digest(candidate) != args.sha256:
            raise RuntimeError("staged binary checksum mismatch")
    with open(LOCK, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return upgrade_locked(args, candidate)


def upgrade_locked(args, candidate):
    report, argv, data, endpoint = inspect()
    if report["version"] == TARGET:
        validate_capability(report["capabilities"], args.storage_engine)
        return {"state": "already_target", "inspection": report}
    if report["version"] != SOURCE:
        raise RuntimeError("only the exact 3.3 native-quota release may be upgraded")
    if report["systemd_exec_start_path"] != PODMAN or report["container_image"] != SOURCE_IMAGE or report["storage_engine"] != "rocksdb":
        raise RuntimeError("unexpected source Podman unit/image; operator review required")
    if report["architecture"] not in ("aarch64", "arm64"):
        raise RuntimeError("this production maintenance path requires the ARM64 host")
    auth = credentials()
    config = host_env(Path("/etc/surreal-ck/surrealdb-upgrade.env"))
    fence = Path(config.get("SURREAL_UPGRADE_FENCE", ""))
    unfence = Path(config.get("SURREAL_UPGRADE_UNFENCE", ""))
    for hook in (fence, unfence):
        if not hook.is_absolute() or not hook.is_file():
            raise RuntimeError("root-owned maintenance fence/unfence executable paths are required")
        trusted_file(hook)
    if not args.defer_origin_start:
        current_contract = ORIGIN_CONTRACT.read_text()
        if f'forkRelease: "{TARGET}"' not in current_contract:
            raise RuntimeError("stage the compatible origin release before upgrading the database")
    if report["free_bytes"] < report["data_bytes"] * 4 + 1024 ** 3:
        raise RuntimeError("insufficient disk for exports, snapshot and recovery copy")
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    if not BACKUPS.is_dir():
        raise RuntimeError("expected existing host backups directory")
    backup = BACKUPS / ("surrealdb-" + stamp)
    backup.mkdir(mode=0o700)
    snapshot = backup / "snapshot"
    target_binary = RELEASES / TARGET / "surreal"
    image = args.image or report["container_image"]
    if args.image:
        run(PODMAN, "pull", args.image)
    else:
        target_binary.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        for directory in [target_binary.parent, target_binary.parent.parent, target_binary.parent.parent.parent]:
            trusted_file(directory)
            directory.chmod(0o755)
        if target_binary.exists() and digest(target_binary) != args.sha256:
            raise RuntimeError("versioned target binary already exists with different bytes")
        if not target_binary.exists():
            shutil.copy2(candidate, target_binary)
            target_binary.chmod(0o755)
    mounted_binary = None if args.image else target_binary
    if parse_version(run(*target_cli(image, mounted_binary), "version")) != TARGET:
        raise RuntimeError("target container/binary version differs")
    smoke = backup / "backend-smoke"
    smoke.mkdir()
    run(*target_cli(image, mounted_binary, smoke), "datastore", "status", f"{args.storage_engine}:/data")
    shutil.copy2(UNIT, backup / "surrealdb.service.original")
    if DROPIN.exists():
        shutil.copy2(DROPIN, backup / "surrealdb.dropin.original")
    (backup / "inspection.json").write_text(json.dumps(report, indent=2))
    fenced = False
    stopped = False
    database_stopped = False
    trial_started = False
    released = False
    target_data = DATA.parent / ("data-native-4.0-" + stamp)
    trial = "surrealdb-upgrade-check-" + str(os.getpid())
    try:
        fenced = True
        run(str(fence))
        run("systemctl", "stop", ORIGIN)
        stopped = True
        before = inventory(endpoint, auth)
        (backup / "before.json").write_text(json.dumps([
            {"namespace": ns, "database": db, "tables": tables}
            for (ns, db), tables in before.items()
        ], indent=2))
        checksums = []
        access_transforms = {}
        for namespace, database in before:
            output = backup / f"{namespace}--{database}.surql"
            export_database(endpoint, auth, namespace, database, output)
            output.chmod(0o600)
            checksums.append(digest(output) + "  " + output.name)
            transformed = backup / f"{namespace}--{database}.import.surql"
            access_transforms[(namespace, database)] = transform_export(output, transformed)
            checksums.append(digest(transformed) + "  " + transformed.name)
        with private_file(backup / "access-transforms.json") as summary:
            summary.write(json.dumps([{"namespace": ns, "database": db, **details}
                                      for (ns, db), details in access_transforms.items()], indent=2).encode())
        (backup / "SHA256SUMS").write_text("\n".join(checksums) + "\n")
        if inventory(endpoint, auth) != before:
            raise RuntimeError("row counts changed under maintenance fence")
        run("systemctl", "stop", SERVICE)
        database_stopped = True
        copy_data(data, snapshot)
        restore_drill(report["container_image"], report["binary"], snapshot, backup / "restore-drill", auth, before)
        target_data.mkdir(mode=0o700)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        trial_endpoint = f"http://127.0.0.1:{port}"
        command = [PODMAN, "run", "--detach", "--rm", "--name", trial, "--user", "0", "--network", "host",
                   "--env-file", str(ENV_FILE), "-v", f"{target_data}:/data"]
        if mounted_binary is not None:
            command += ["-v", f"{mounted_binary}:/surreal-upgrade:ro", "--entrypoint", "/surreal-upgrade"]
        run(*command, image, "start", "--bind", f"127.0.0.1:{port}", "--allow-all", f"{args.storage_engine}:/data")
        trial_started = True
        wait_health(trial_endpoint)
        # backend 认证在导入和切换前再核验，不能把支持打开误认为生产认证通过。
        validate_capability(request(trial_endpoint + "/capabilities"), args.storage_engine)
        for namespace, database in before:
            import_database(trial_endpoint, auth, namespace, database,
                            backup / f"{namespace}--{database}.import.surql")
            validate_record_accesses(trial_endpoint, auth, namespace, database,
                                     access_transforms[(namespace, database)]["record_accesses"])
        if inventory(trial_endpoint, auth) != before:
            raise RuntimeError("imported row counts differ")
        run(PODMAN, "stop", "--time", "30", trial)
        trial_started = False
        switch(service_command(image, target_data, mounted_binary, args.storage_engine))
        run("systemctl", "start", SERVICE)
        wait_health(endpoint)
        observed, _, _, _ = inspect()
        if (observed["version"] != TARGET or observed["container_image"] != image
                or (mounted_binary is not None and observed["binary_sha256"] != args.sha256)):
            raise RuntimeError("running binary differs from verified target")
        validate_capability(observed["capabilities"], args.storage_engine)
        if inventory(endpoint, auth) != before:
            raise RuntimeError("post-upgrade row counts differ")
        if args.defer_origin_start:
            return {"state": "database_ready_origin_stopped", "approval_ref": args.approval_ref,
                    "write_fence": "retained", "backup": str(backup), "inspection": observed}
        run("systemctl", "start", ORIGIN)
        wait_health("http://127.0.0.1:8080", origin=True)
        released = True
        run(str(unfence))
        return {"state": "healthy", "approval_ref": args.approval_ref, "backup": str(backup), "inspection": observed}
    except BaseException:
        if stopped:
            run("systemctl", "stop", ORIGIN)
        if trial_started:
            run(PODMAN, "stop", "--time", "30", trial)
        if database_stopped and not released:
            run("systemctl", "stop", SERVICE)
            restore_unit(backup)
            run("systemctl", "start", SERVICE)
            wait_health(endpoint)
        if released:
            run(str(fence))
        # 围栏保持开启；旧 origin 可能已与目标契约绑定，不自动重启或开放写入。
        raise RuntimeError(f"upgrade failed; maintenance fence retained={fenced}; inspect host backup {backup}") from None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["check", "upgrade"])
    parser.add_argument("--binary")
    parser.add_argument("--sha256")
    parser.add_argument("--image", default="")
    parser.add_argument("--receipt")
    parser.add_argument("--storage-engine", choices=["rocksdb", "surrealkv"], default="surrealkv")
    parser.add_argument("--defer-origin-start", action="store_true")
    parser.add_argument("--approval-ref", required=True)
    parser.add_argument("--confirmation", default="")
    args = parser.parse_args()
    os.umask(0o077)
    if args.mode == "check":
        print(json.dumps(inspect()[0], indent=2))
    else:
        print(json.dumps(upgrade(args), indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"SurrealDB maintenance refused/failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
