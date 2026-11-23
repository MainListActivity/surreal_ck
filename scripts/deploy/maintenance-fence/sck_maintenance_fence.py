"""生产 DB 维护围栏；只改写 data.maplayer.top 的直接兜底 handle。"""

from collections import namedtuple
import fcntl
from http.client import HTTPConnection
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time


CONFIG = Path("/etc/caddy/Caddyfile")
STATE = Path("/var/lib/surreal-ck/maintenance-fence")
CADDY = "/usr/bin/caddy"
SYSTEMCTL = "/usr/bin/systemctl"
FIREWALLS = ("/usr/sbin/iptables", "/usr/sbin/ip6tables")
SS = "/usr/bin/ss"
ORIGIN = "surreal-ck-hono.service"
MCP = "sck-company-mcp.service"
RULE = ("!", "-i", "lo", "-p", "tcp", "--dport", "8000",
        "-m", "comment", "--comment", "surreal-ck-maintenance-8000", "-j", "DROP")
HONO_PREFIX = "/__surreal_ck_hono"
HONO_ACCEPTANCE_PATHS = (
    "/health", "/api/ops/mcp", "/api/ops/.well-known/oauth-protected-resource",
    "/api/ops/mcp/.well-known/oauth-protected-resource",
)
Token = namedtuple("Token", "value start end literal")


def tokens(source):
    result = []
    i = 0
    while i < len(source):
        if source[i].isspace():
            i += 1
        elif source[i] == "#":
            end = source.find("\n", i)
            i = len(source) if end < 0 else end
        elif source[i] in ('"', "`"):
            start, quote = i, source[i]
            i += 1
            while i < len(source) and source[i] != quote:
                i += 2 if source[i] == "\\" and quote == '"' else 1
            if i >= len(source):
                raise RuntimeError("unterminated Caddyfile string")
            i += 1
            result.append(Token(source[start:i], start, i, True))
        else:
            start = i
            while i < len(source) and not source[i].isspace() and source[i] != "#":
                i += 1
            value = source[start:i]
            if value.startswith("<<"):
                raise RuntimeError("Caddyfile heredoc requires operator review")
            result.append(Token(value, start, i, False))
    return result


def fenced_config(original):
    source = original.decode("utf-8")
    items = tokens(source)
    stack, pairs, parents = [], {}, {}
    for i, token in enumerate(items):
        parents[i] = stack[-1] if stack else None
        if not token.literal and token.value == "{":
            stack.append(i)
        elif not token.literal and token.value == "}":
            if not stack:
                raise RuntimeError("unbalanced Caddyfile")
            pairs[stack.pop()] = i
    if stack:
        raise RuntimeError("unbalanced Caddyfile")

    def header(index):
        start = source.rfind("\n", 0, items[index].start) + 1
        return [i for i in range(index) if items[i].start >= start]

    def args(index):
        return [items[i].value for i in header(index)]

    sites = [i for i in pairs if parents[i] is None
             and args(i) == ["data.maplayer.top"]]
    if len(sites) != 1:
        raise RuntimeError("expected exactly one explicit data.maplayer.top site")
    handles = [i for i in pairs if parents[i] == sites[0] and header(i)
               and items[header(i)[0]].value in ("handle", "handle_path")]
    fallback = [i for i in handles if args(i) == ["handle"]]
    if len(fallback) != 1 or fallback[0] != max(handles):
        raise RuntimeError("expected exactly one final unmatched handle")
    block = fallback[0]
    proxies = [i for i, token in enumerate(items) if parents[i] == block and token.value == "reverse_proxy"]
    if len(proxies) != 1:
        raise RuntimeError("fallback must contain one direct database reverse_proxy")
    proxy = proxies[0]
    if proxy + 1 >= len(items) or items[proxy + 1].value != "127.0.0.1:8000":
        raise RuntimeError("unexpected fallback upstream")
    after = items[proxy + 2] if proxy + 2 < len(items) else None
    if after and after.value != "{" and "\n" not in source[items[proxy + 1].end:after.start]:
        raise RuntimeError("unexpected extra fallback upstream")
    start = items[header(block)[0]].start
    line = source.rfind("\n", 0, start) + 1
    indent = source[line:start]
    if indent.strip():
        raise RuntimeError("unsupported inline fallback")
    replacement = "handle {\n" + indent + "    respond 503\n" + indent + "}"

    hono_matchers = [i for i in pairs if parents[i] == sites[0] and args(i) == ["@hono_secret"]]
    hono_handlers = [i for i in handles if args(i) == ["handle", "@hono_secret"]]
    hono_ports = [i for i, token in enumerate(items) if token.value == "127.0.0.1:8080"]
    if (len(hono_matchers) != 1 or len(hono_handlers) != 1 or len(hono_ports) != 1
            or parents[hono_ports[0]] != hono_handlers[0]
            or items[hono_ports[0] - 1].value != "reverse_proxy"):
        raise RuntimeError("expected one authenticated Hono origin route")
    matcher = hono_matchers[0]
    if not any(parents[i] == matcher and not token.literal and token.value == "header" and not header(i)
               for i, token in enumerate(items)):
        raise RuntimeError("expected Hono edge authentication header matcher")
    path = [i for i, token in enumerate(items) if parents[i] == matcher and not token.literal
            and token.value == "path" and not header(i)]
    if len(path) != 1:
        raise RuntimeError("expected one Hono path matcher")
    path_index = path[0] + 1
    prefix = items[path_index]
    if prefix.literal or prefix.value != f"{HONO_PREFIX}/*" or header(path_index + 1):
        raise RuntimeError("unexpected Hono path matcher")
    allowlist = " ".join(HONO_PREFIX + route for route in HONO_ACCEPTANCE_PATHS)

    proxy = hono_ports[0] - 1
    proxy_start = items[proxy].start
    proxy_indent = source[source.rfind("\n", 0, proxy_start) + 1:proxy_start]
    if proxy_indent.strip():
        raise RuntimeError("unsupported inline Hono proxy")
    marker = "request_header X-Surreal-CK-Maintenance test-kit\n" + proxy_indent
    edits = (
        (start, items[pairs[block]].end, replacement),
        (prefix.start, prefix.end, allowlist),
        (proxy_start, proxy_start, marker),
    )
    for begin, end, value in sorted(edits, reverse=True):
        source = source[:begin] + value + source[end:]
    return source.encode("utf-8")


def secure(path, directory=False):
    info = path.lstat()
    valid_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not valid_type or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError("root-owned non-writable paths are required")
    return info


def secure_parents(path):
    for parent in reversed(path.parents):
        secure(parent, directory=True)


def atomic_write(path, data):
    fd, name = tempfile.mkstemp(prefix=".sck-fence-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as destination:
            os.fchmod(destination.fileno(), stat.S_IMODE(path.stat().st_mode) & 0o644 if path.exists() else 0o600)
            os.fchown(destination.fileno(), 0, path.stat().st_gid if path.exists() else 0)
            destination.write(data)
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(name, path)
        descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def executable(path):
    source = Path(path)
    secure_parents(source)
    if source.lstat().st_uid != 0:
        raise RuntimeError("host executable link must be root-owned")
    resolved = source.resolve(strict=True)
    secure_parents(resolved)
    secure(resolved)
    if not os.access(resolved, os.X_OK):
        raise RuntimeError("required host executable is unavailable")
    return str(resolved)


def command(*args, allowed=(0,)):
    result = subprocess.run(args, executable=executable(args[0]), capture_output=True, text=True, check=False,
                            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root"}, timeout=60)
    if result.returncode not in allowed:
        raise RuntimeError(f"{Path(args[0]).name} failed (exit {result.returncode})")
    return result


def firewall(enable):
    for binary in FIREWALLS:
        if enable:
            result = command(binary, "--wait", "10", "-C", "INPUT", *RULE, allowed=(0, 1))
            if result.returncode == 1:
                command(binary, "--wait", "10", "-I", "INPUT", "1", *RULE)
        else:
            for _ in range(100):
                result = command(binary, "--wait", "10", "-C", "INPUT", *RULE, allowed=(0, 1))
                if result.returncode == 1:
                    break
                command(binary, "--wait", "10", "-D", "INPUT", *RULE)
            else:
                raise RuntimeError("too many duplicate maintenance firewall rules")


def endpoint(value):
    address, separator, port = value.rpartition(":")
    if not separator or not port.isdigit():
        raise RuntimeError("unrecognized ss endpoint")
    parsed = ipaddress.ip_address(address.strip("[]").split("%", 1)[0])
    mapped = getattr(parsed, "ipv4_mapped", None)
    return mapped or parsed, int(port)


def connections_closed(output):
    for line in output.splitlines():
        fields = line.split()
        if len(fields) < 4 or not fields[0].isdigit() or not fields[1].isdigit():
            raise RuntimeError("unrecognized ss output")
        _, local_port = endpoint(fields[2])
        peer, peer_port = endpoint(fields[3])
        if local_port == 8000 and not peer.is_loopback:
            return False
        if peer_port == 8000 and re.search(r'\(\("caddy"[,)]', " ".join(fields[4:])):
            return False
    return True


def verify_connections():
    for attempt in range(30):
        output = command(SS, "-Hntp", "state", "established", "( sport = :8000 or dport = :8000 )").stdout
        if connections_closed(output):
            return
        if attempt < 29:
            time.sleep(1)
    raise RuntimeError("database connections remain; maintenance fence is not verified")


def origin_ready():
    command(SYSTEMCTL, "is-active", "--quiet", ORIGIN)
    connection = HTTPConnection("127.0.0.1", 8080, timeout=5)
    try:
        connection.request("GET", "/health")
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError("origin health must return HTTP 200")
        value = json.load(response)
    finally:
        connection.close()
    if not isinstance(value, dict) or value.get("status") != "ok" or value.get("surrealdb") != "up":
        raise RuntimeError("compatible origin must be healthy before unfencing")


def apply_config(desired, allowed):
    secure(CONFIG)
    previous = CONFIG.read_bytes()
    if previous not in allowed:
        raise RuntimeError("Caddyfile changed before replacement")
    atomic_write(CONFIG, desired)
    try:
        command(CADDY, "validate", "--config", str(CONFIG), "--adapter", "caddyfile")
        if CONFIG.read_bytes() != desired:
            raise RuntimeError("Caddyfile changed during validation")
    except BaseException:
        if CONFIG.read_bytes() == desired:
            atomic_write(CONFIG, previous)
        raise
    command(SYSTEMCTL, "reload", "caddy.service")


def load_session(mode):
    record = STATE / "state.json"
    state = None
    if record.exists():
        secure(record)
        state = json.loads(record.read_bytes())
        if (not isinstance(state, dict) or state.get("phase") not in ("active", "released")
                or not re.fullmatch(r"session-[a-z0-9_]+", state.get("session", ""))):
            raise RuntimeError("invalid maintenance session")
        if state["phase"] == "active" and type(state.get("mcp_was_active")) is not bool:
            raise RuntimeError("active fence must be released by the hook that created it")
    if mode == "fence" and (state is None or state["phase"] == "released"):
        original = CONFIG.read_bytes()
        candidate = fenced_config(original)
        mcp_state = command(SYSTEMCTL, "show", "--property=ActiveState", "--value", MCP).stdout.strip()
        if mcp_state not in ("active", "inactive"):
            raise RuntimeError("company MCP must be active or inactive before fencing")
        directory = Path(tempfile.mkdtemp(prefix="session-", dir=STATE))
        atomic_write(directory / "original.Caddyfile", original)
        atomic_write(directory / "fenced.Caddyfile", candidate)
        state = {"phase": "active", "session": directory.name, "mcp_was_active": mcp_state == "active"}
        atomic_write(record, json.dumps(state).encode())
    if state is None:
        raise RuntimeError("no recorded fence session; refusing to guess the original configuration")
    directory = STATE / state["session"]
    secure(directory, directory=True)
    for name in ("original.Caddyfile", "fenced.Caddyfile"):
        secure(directory / name)
    original = (directory / "original.Caddyfile").read_bytes()
    candidate = (directory / "fenced.Caddyfile").read_bytes()
    if CONFIG.read_bytes() not in (original, candidate):
        raise RuntimeError("Caddyfile changed outside the recorded fence; operator review required")
    return state, original, candidate


def operate(mode):
    if mode not in ("fence", "unfence") or os.geteuid() != 0:
        raise RuntimeError("root and an explicit fence/unfence mode are required")
    secure_parents(Path(__file__))
    secure(Path(__file__))
    secure_parents(CONFIG)
    secure(CONFIG)
    if stat.S_IMODE(CONFIG.stat().st_mode) & 0o133:
        raise RuntimeError("Caddyfile must be root-owned and not writable or executable by others")
    for binary in (CADDY, SYSTEMCTL, SS, *FIREWALLS):
        executable(binary)
    secure_parents(STATE)
    STATE.mkdir(mode=0o700, exist_ok=True)
    secure(STATE, directory=True)
    if stat.S_IMODE(STATE.stat().st_mode) != 0o700:
        raise RuntimeError("maintenance state must be root-only (0700)")
    fd = os.open(STATE / "lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as lock:
        secure(STATE / "lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state, original, candidate = load_session(mode)
        if mode == "fence":
            command(SYSTEMCTL, "stop", ORIGIN, MCP)
            for service in (ORIGIN, MCP):
                command(SYSTEMCTL, "is-active", "--quiet", service, allowed=(3,))
            apply_config(candidate, (original, candidate))
            firewall(True)
            verify_connections()
        else:
            origin_ready()
            apply_config(original, (original, candidate))
            firewall(False)
            if state["phase"] == "active" and state["mcp_was_active"]:
                command(SYSTEMCTL, "start", MCP)
                command(SYSTEMCTL, "is-active", "--quiet", MCP)
            state["phase"] = "released"
            atomic_write(STATE / "state.json", json.dumps(state).encode())


def main(mode):
    os.umask(0o077)
    try:
        operate(mode)
        print(f"SurrealDB maintenance {mode}: verified")
    except BaseException:
        print(f"SurrealDB maintenance {mode}: failed; keep maintenance closed and inspect protected host state", file=sys.stderr)
        sys.exit(1)
