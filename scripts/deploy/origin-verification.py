#!/usr/bin/env python3
"""前端定向恢复的 origin 运行版本核定证据（锁内、只读）。

CI 读不到 origin 的运行 SHA：公开入口没有，/api/ops/runtime-version 需要运营会话。因此流程是：

1. barrier：发布作业在构建之后、任何生产写入之前生成本运行的 barrier（运行身份、受审 tooling、目标 sha、
   生成时间与随机 nonce），并写入作业摘要。
2. render / post：运营在 barrier 之后用运维工具只读核定 origin 运行 SHA，再在证据 PR 上发表一条评论；
   评论含 origin-verification-v1 代码块，逐项绑定 barrier。
3. wait / verify：发布作业有界等待绑定评论，并逐项校验：作者在白名单内、评论未编辑、位于期望的 PR、
   核定时间不早于 barrier、不超过 30 分钟、origin 与目标逐字相等、run / attempt / tooling / nonce 全部一致。
   第一次生产写入之前再次 verify。

顶层发布锁 production-release 保证 barrier 与发布之间没有其它受管 origin 变更。

运行中可读的取回通道（fetch）：发布作业在生成 barrier 之后、Wait 之前把它上传为 artifact
origin-barrier-<run_id>-<attempt>。运营在作业仍运行时经 gh API 取回，逐项核验运行身份、提交、目标、
时间与字节规范性后，才把文件交给 render / post。fetch 不构成证据：绑定评论仍须由白名单审批人发表，
CI 的 wait / verify 仍以自己生成的 barrier 逐项比对。

退出码：0 通过；1 用法或接口错误；2 拒绝（找到绑定评论或 artifact 但不符合）；
3 尚无绑定评论、artifact 尚不可读或等待超时。
"""

import argparse
import hashlib
import io
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
import zipfile
from datetime import datetime, timezone

FENCE_OPEN = "```origin-verification-v1"
FENCE_CLOSE = "```"
BLOCK_KEYS = (
    "barrier_repo",
    "barrier_run_id",
    "barrier_run_attempt",
    "barrier_workflow_ref",
    "barrier_tooling_sha",
    "barrier_target_sha",
    "barrier_generated_at",
    "barrier_nonce",
    "origin_sha",
    "origin_verified_at",
    "ops_task_id",
    "fa_audit_ref",
)
BARRIER_KEYS = ("repo", "run_id", "run_attempt", "workflow_ref", "tooling_sha", "target_sha", "generated_at", "nonce")
RUN_ENV = (
    ("repo", "GITHUB_REPOSITORY"),
    ("run_id", "GITHUB_RUN_ID"),
    ("run_attempt", "GITHUB_RUN_ATTEMPT"),
    ("workflow_ref", "GITHUB_WORKFLOW_REF"),
    ("tooling_sha", "GITHUB_SHA"),
)
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
NONCE_RE = re.compile(r"^[0-9a-f]{32}$")
UTC_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
DIGITS_RE = re.compile(r"^[0-9]{1,20}$")
IDENT_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
REF_RE = re.compile(r"^[A-Za-z0-9._/@:-]{1,300}$")
DEFAULT_MAX_AGE = 1800
FUTURE_SKEW = 60
PAGE_SIZE = 100
MAX_PAGES = 20
# barrier 有效期与 release 工作流的 wait 上限一致（1200 秒）：超过即视为过期，须整条重新派发。
BARRIER_MAX_AGE = 1200
RELEASE_WORKFLOW = ".github/workflows/release-frontend-recovery.yml"
WORKFLOW_PATH_RE = re.compile(r"^\.github/workflows/[A-Za-z0-9._-]{1,100}\.yml$")
ARTIFACT_MEMBER = "origin-barrier.json"
ARTIFACT_MAX_BYTES = 16384


class UsageError(Exception):
    """参数、环境、barrier 文件或 GitHub 接口的确定性错误，退出码 1。"""


class ApiError(UsageError):
    """GitHub 接口临时失败；wait 在超时前会重试。"""


class Refused(Exception):
    """找到与 barrier 绑定的评论，但不符合要求；退出码 2，立即停止。"""


class NoEvidence(Exception):
    """尚无与 barrier 绑定的评论；退出码 3。"""


class RunEnded(NoEvidence):
    """运行已结束却没有 barrier artifact：之后不会再出现，立即退出码 3。"""


def now_epoch():
    override = os.environ.get("NOW_EPOCH")
    if override:
        return int(override)
    return int(time.time())


def fmt_utc(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_utc(value):
    """返回 epoch 秒；格式或日期不合法时抛出 ValueError。"""
    if not isinstance(value, str) or not UTC_RE.match(value):
        raise ValueError("expected UTC YYYY-MM-DDTHH:MM:SSZ, got %r" % (value,))
    parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    return int(parsed.replace(tzinfo=timezone.utc).timestamp())


def require_env(name):
    value = os.environ.get(name, "")
    if not value:
        raise UsageError("%s is required" % name)
    return value


def validate_barrier(barrier):
    if not isinstance(barrier, dict) or set(barrier) != set(BARRIER_KEYS):
        raise UsageError("barrier must contain exactly: " + ", ".join(BARRIER_KEYS))
    rules = {
        "repo": REPO_RE,
        "run_id": DIGITS_RE,
        "run_attempt": DIGITS_RE,
        "workflow_ref": REF_RE,
        "tooling_sha": SHA_RE,
        "target_sha": SHA_RE,
        "nonce": NONCE_RE,
    }
    for key, rule in rules.items():
        if not isinstance(barrier[key], str) or not rule.match(barrier[key]):
            raise UsageError("barrier %s is malformed" % key)
    try:
        parse_utc(barrier["generated_at"])
    except ValueError as exc:
        raise UsageError("barrier generated_at: %s" % exc)


def load_barrier(path):
    try:
        with open(path, encoding="utf-8") as handle:
            barrier = json.load(handle)
    except (OSError, ValueError) as exc:
        raise UsageError("cannot read barrier file %s: %s" % (path, exc))
    validate_barrier(barrier)
    return barrier


def bind_to_run(barrier):
    """verify / wait 只接受本运行在作业内产生的 barrier。"""
    for key, env_name in RUN_ENV:
        if os.environ.get(env_name, "") != barrier[key]:
            raise UsageError("barrier %s does not belong to this run (%s)" % (key, env_name))


def parse_approvers(text):
    names = set(part.strip().lower() for part in re.split(r"[,\s]+", text or "") if part.strip())
    if not names:
        raise UsageError("approver list is empty; RELEASE_APPROVER_LOGINS must be configured (fail closed)")
    return names


def parse_block(body):
    lines = (body or "").replace("\r\n", "\n").split("\n")
    opens = [index for index, line in enumerate(lines) if line.strip() == FENCE_OPEN]
    if len(opens) != 1:
        raise Refused("evidence must contain exactly one origin-verification-v1 block (found %d)" % len(opens))
    start = opens[0]
    end = None
    for index in range(start + 1, len(lines)):
        if lines[index].strip() == FENCE_CLOSE:
            end = index
            break
    if end is None:
        raise Refused("origin-verification-v1 block is not closed")
    fields = {}
    for line in lines[start + 1:end]:
        if not line.strip():
            continue
        if ": " not in line:
            raise Refused("malformed line in origin-verification-v1 block")
        key, value = line.split(": ", 1)
        key = key.strip()
        if key in fields:
            raise Refused("duplicate key %s in origin-verification-v1 block" % key)
        fields[key] = value.strip()
    missing = [key for key in BLOCK_KEYS if key not in fields]
    extra = [key for key in fields if key not in BLOCK_KEYS]
    if missing or extra:
        raise Refused("origin-verification-v1 keys differ (missing: %s; unexpected: %s)" % (missing, extra))
    return fields


def check_binding(barrier, comment, args, now):
    expected_issue = "https://api.github.com/repos/%s/issues/%s" % (barrier["repo"], args.pr)
    if comment.get("issue_url") != expected_issue:
        raise Refused("evidence comment is not on PR #%s of %s" % (args.pr, barrier["repo"]))
    created = comment.get("created_at")
    if not created or comment.get("updated_at") != created:
        raise Refused("evidence comment was edited after it was created")
    fields = parse_block(comment.get("body"))

    def same(key, expected, label):
        if fields[key] != expected:
            raise Refused("%s does not match the barrier (%s)" % (label, key))

    same("barrier_repo", barrier["repo"], "repository")
    same("barrier_run_id", barrier["run_id"], "run id")
    same("barrier_run_attempt", barrier["run_attempt"], "run attempt")
    same("barrier_workflow_ref", barrier["workflow_ref"], "workflow ref")
    same("barrier_tooling_sha", barrier["tooling_sha"], "tooling sha")
    same("barrier_target_sha", barrier["target_sha"], "target sha")
    same("barrier_generated_at", barrier["generated_at"], "barrier time")
    same("barrier_nonce", barrier["nonce"], "barrier nonce")
    if not SHA_RE.match(fields["origin_sha"]):
        raise Refused("origin_sha is not a full lowercase commit SHA")
    if fields["origin_sha"] != args.target:
        raise Refused("origin runs %s, not the requested target %s" % (fields["origin_sha"], args.target))
    try:
        verified = parse_utc(fields["origin_verified_at"])
        created_epoch = parse_utc(created)
        generated = parse_utc(barrier["generated_at"])
    except ValueError as exc:
        raise Refused("timestamp is malformed: %s" % exc)
    if verified < generated:
        raise Refused("origin was sampled before the barrier; the sample was not taken under the lock")
    if verified > now + FUTURE_SKEW:
        raise Refused("origin_verified_at is in the future")
    age = now - verified
    if age > args.max_age:
        raise Refused(
            "origin verification expired (age %ds, allowed %ds); re-sample after the barrier" % (age, args.max_age)
        )
    if created_epoch < verified:
        raise Refused("evidence comment predates the sampling it reports")
    if not IDENT_RE.match(fields["ops_task_id"]):
        raise Refused("ops_task_id is malformed")
    if fields["fa_audit_ref"] != args.approval_ref:
        raise Refused("fa_audit_ref does not match approval_ref")
    return {
        "comment_id": comment.get("id"),
        "comment_url": comment.get("html_url"),
        "origin_sha": fields["origin_sha"],
        "origin_verified_at": fields["origin_verified_at"],
        "ops_task_id": fields["ops_task_id"],
        "fa_audit_ref": fields["fa_audit_ref"],
        "age_seconds": age,
    }


def evaluate(barrier, comments, args, now):
    approvers = parse_approvers(args.approvers)
    nonce = barrier["nonce"]
    binding = []
    ignored = 0
    for comment in comments:
        body = comment.get("body") or ""
        if nonce not in body:
            continue
        login = str((comment.get("user") or {}).get("login") or "").lower()
        if login not in approvers:
            ignored += 1
            continue
        binding.append(comment)
    if not binding:
        raise NoEvidence(
            "no approver comment on PR #%s binds barrier nonce yet (%d comment(s) by non-approvers carried it)"
            % (args.pr, ignored)
        )
    if len(binding) > 1:
        raise Refused("%d approver comments bind this barrier; refusing ambiguous evidence" % len(binding))
    return check_binding(barrier, binding[0], args, now)


def gh_api(endpoint, extra=()):
    try:
        proc = subprocess.run(
            ["gh", "api", endpoint] + list(extra),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
        )
    except OSError as exc:
        raise ApiError("cannot run gh: %s" % exc)
    if proc.returncode != 0:
        raise ApiError("gh api %s failed: %s" % (endpoint, (proc.stderr or proc.stdout).strip()[:300]))
    return proc.stdout


def fetch_comments(repo, pr):
    comments = []
    for page in range(1, MAX_PAGES + 1):
        raw = gh_api("repos/%s/issues/%s/comments?per_page=%d&page=%d" % (repo, pr, PAGE_SIZE, page))
        try:
            items = json.loads(raw)
        except ValueError:
            raise ApiError("comments response is not JSON")
        if not isinstance(items, list):
            raise ApiError("comments response is not a list")
        comments.extend(items)
        if len(items) < PAGE_SIZE:
            return comments
    raise UsageError("evidence PR has more than %d comment pages" % MAX_PAGES)


def load_comments(path):
    try:
        with open(path, encoding="utf-8") as handle:
            items = json.load(handle)
    except (OSError, ValueError) as exc:
        raise UsageError("cannot read comments file: %s" % exc)
    if not isinstance(items, list):
        raise UsageError("comments file must contain a JSON list")
    return items


def collect(args, repo):
    if getattr(args, "comments_json", None):
        return load_comments(args.comments_json)
    return fetch_comments(repo, args.pr)


def emit(status, reason, **extra):
    payload = {"status": status, "reason": reason}
    payload.update(extra)
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    if status != "ok":
        print("::error::origin verification %s: %s" % (status, reason), file=sys.stderr)


def write_result(path, result):
    if path:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False, sort_keys=True)
            handle.write("\n")


def artifact_name(run_id, run_attempt):
    return "origin-barrier-%s-%s" % (run_id, run_attempt)


def canonical_bytes(barrier):
    """barrier 文件的唯一规范字节，与 cmd_barrier 写出的内容逐字节一致。"""
    return (json.dumps(barrier, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def gh_api_bytes(endpoint):
    try:
        proc = subprocess.run(["gh", "api", endpoint], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as exc:
        raise ApiError("cannot run gh: %s" % exc)
    if proc.returncode != 0:
        raise ApiError("gh api %s failed: %s" % (endpoint, proc.stderr.decode("utf-8", "replace").strip()[:300]))
    return proc.stdout


def gh_api_json(endpoint):
    try:
        payload = json.loads(gh_api_bytes(endpoint).decode("utf-8"))
    except ValueError:
        raise ApiError("gh api %s did not return JSON" % endpoint)
    if not isinstance(payload, dict):
        raise ApiError("gh api %s did not return a JSON object" % endpoint)
    return payload


def list_named_artifacts(repo, run_id, name):
    payload = gh_api_json("repos/%s/actions/runs/%s/artifacts?name=%s&per_page=%d" % (repo, run_id, name, PAGE_SIZE))
    items = payload.get("artifacts")
    if not isinstance(items, list):
        raise ApiError("artifacts response has no artifacts list")
    total = payload.get("total_count")
    if isinstance(total, int) and total > len(items):
        raise Refused("more than one page of artifacts named %s; refusing" % name)
    return [item for item in items if isinstance(item, dict) and item.get("name") == name]


def check_artifact_entry(artifact, args, head):
    """下载之前核对 artifact 元数据：未过期、挂在本运行上、提交一致、大小在界内。"""
    if artifact.get("expired") is not False:
        raise Refused("barrier artifact is expired or its state is unknown; dispatch a new run")
    workflow_run = artifact.get("workflow_run")
    attached = workflow_run.get("id") if isinstance(workflow_run, dict) else None
    if str(attached) != args.run_id:
        raise Refused("artifact is attached to run %s, not %s" % (attached, args.run_id))
    if workflow_run.get("head_sha") != head:
        raise Refused("artifact commit does not match run %s" % args.run_id)
    size = artifact.get("size_in_bytes")
    if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= ARTIFACT_MAX_BYTES:
        raise Refused("barrier artifact size is out of bounds")


def download_artifact(repo, artifact):
    artifact_id = artifact.get("id")
    if not isinstance(artifact_id, int) or isinstance(artifact_id, bool) or artifact_id <= 0:
        raise ApiError("artifact id is malformed")
    return gh_api_bytes("repos/%s/actions/artifacts/%d/zip" % (repo, artifact_id))


def parse_barrier_artifact(data):
    """artifact 字节必须是恰好一个 origin-barrier.json：可解析、字段齐全、为规范字节。"""
    if len(data) > ARTIFACT_MAX_BYTES:
        raise Refused("barrier artifact is larger than %d bytes" % ARTIFACT_MAX_BYTES)
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise Refused("barrier artifact is not a zip archive")
    names = archive.namelist()
    if names != [ARTIFACT_MEMBER]:
        raise Refused("barrier artifact must contain exactly %s (found %s)" % (ARTIFACT_MEMBER, names))
    if archive.getinfo(ARTIFACT_MEMBER).file_size > ARTIFACT_MAX_BYTES:
        raise Refused("barrier artifact member is larger than %d bytes once decompressed" % ARTIFACT_MAX_BYTES)
    try:
        raw = archive.read(ARTIFACT_MEMBER)
    except (zipfile.BadZipFile, RuntimeError, OSError) as exc:
        raise Refused("barrier artifact cannot be read: %s" % exc)
    try:
        barrier = json.loads(raw.decode("utf-8"))
    except ValueError:
        raise Refused("barrier artifact is not JSON")
    try:
        validate_barrier(barrier)
    except UsageError as exc:
        raise Refused("barrier artifact is malformed: %s" % exc)
    if raw != canonical_bytes(barrier):
        raise Refused("barrier artifact bytes are not the canonical barrier (reformatted or tampered)")
    return barrier, raw


def check_artifact_binding(run, artifact, barrier, args, now):
    """barrier 必须属于本运行：仓库、run id、attempt、工作流路径与分支、tooling（即运行提交）、目标与时间窗口。"""
    if barrier["repo"] != args.repo:
        raise Refused("barrier repository %s is not %s" % (barrier["repo"], args.repo))
    if barrier["run_id"] != args.run_id:
        raise Refused("barrier belongs to run %s, not %s" % (barrier["run_id"], args.run_id))
    if barrier["run_attempt"] != "1":
        raise Refused("barrier run attempt %s is not 1" % barrier["run_attempt"])
    expected_ref = "%s/%s@refs/heads/%s" % (args.repo, args.workflow_path, run.get("head_branch"))
    if barrier["workflow_ref"] != expected_ref:
        raise Refused("barrier workflow ref %s does not match run %s" % (barrier["workflow_ref"], args.run_id))
    if barrier["tooling_sha"] != run.get("head_sha"):
        raise Refused("barrier tooling sha does not match the commit of run %s" % args.run_id)
    if barrier["target_sha"] != args.target:
        raise Refused("barrier target %s is not the requested target %s" % (barrier["target_sha"], args.target))
    generated = parse_utc(barrier["generated_at"])
    try:
        started = parse_utc(run.get("run_started_at") or run.get("created_at"))
        created = parse_utc(artifact.get("created_at"))
    except ValueError as exc:
        raise Refused("run or artifact timestamp is malformed: %s" % exc)
    if generated < started - FUTURE_SKEW:
        raise Refused("barrier was generated before run %s started" % args.run_id)
    if generated > now + FUTURE_SKEW:
        raise Refused("barrier generated_at is in the future")
    if now - generated > args.max_age:
        raise Refused("barrier is stale (age %ds, allowed %ds); dispatch a new run" % (now - generated, args.max_age))
    if created < generated - FUTURE_SKEW:
        raise Refused("artifact predates the barrier it carries")
    if created > now + FUTURE_SKEW:
        raise Refused("artifact created_at is in the future")


def fetch_barrier_once(args, now):
    """单次取回：返回 (规范字节, barrier, artifact 元数据)；尚不可读抛 NoEvidence，不合格抛 Refused。"""
    run = gh_api_json("repos/%s/actions/runs/%s" % (args.repo, args.run_id))
    if str(run.get("id")) != args.run_id:
        raise Refused("GitHub returned run %s, not %s" % (run.get("id"), args.run_id))
    if run.get("path") != args.workflow_path:
        raise Refused("run %s is %s, not the expected workflow %s" % (args.run_id, run.get("path"), args.workflow_path))
    if str(run.get("run_attempt")) != "1":
        raise Refused("run attempt is %s; only the first attempt is accepted" % run.get("run_attempt"))
    head = run.get("head_sha")
    if not isinstance(head, str) or not SHA_RE.match(head):
        raise Refused("run %s has no full commit sha" % args.run_id)
    name = artifact_name(args.run_id, "1")
    matches = list_named_artifacts(args.repo, args.run_id, name)
    if len(matches) > 1:
        raise Refused("%d artifacts are named %s; refusing duplicates" % (len(matches), name))
    if not matches:
        if run.get("status") == "completed":
            raise RunEnded("run %s completed without a barrier artifact; nothing to read" % args.run_id)
        raise NoEvidence("barrier artifact %s is not readable yet (run status %s)" % (name, run.get("status")))
    artifact = matches[0]
    check_artifact_entry(artifact, args, head)
    barrier, raw = parse_barrier_artifact(download_artifact(args.repo, artifact))
    check_artifact_binding(run, artifact, barrier, args, now)
    return raw, barrier, artifact


def write_bytes(path, data):
    tmp = path + ".tmp"
    try:
        with open(tmp, "wb") as handle:
            handle.write(data)
        os.replace(tmp, path)
    except OSError as exc:
        raise UsageError("cannot write %s: %s" % (path, exc))


def build_body(barrier, args, now):
    origin_sha = args.origin_sha or ""
    if not SHA_RE.match(origin_sha):
        raise UsageError("--origin-sha must be a full lowercase commit SHA")
    if origin_sha != barrier["target_sha"]:
        raise UsageError(
            "origin runs %s but the barrier target is %s; stop and report, do not post" % (origin_sha, barrier["target_sha"])
        )
    try:
        verified = parse_utc(args.origin_verified_at)
    except ValueError as exc:
        raise UsageError("--origin-verified-at: %s" % exc)
    if verified < parse_utc(barrier["generated_at"]):
        raise UsageError("--origin-verified-at predates the barrier; re-sample after the barrier")
    if verified > now + FUTURE_SKEW:
        raise UsageError("--origin-verified-at is in the future")
    if now - verified > args.max_age:
        raise UsageError("--origin-verified-at is older than %ds; re-sample" % args.max_age)
    if not IDENT_RE.match(args.ops_task_id or ""):
        raise UsageError("--ops-task-id is malformed")
    if not IDENT_RE.match(args.fa_audit_ref or ""):
        raise UsageError("--fa-audit-ref is malformed")
    lines = [
        "origin 运行版本核定（锁内只读，运营提交）。代码块由 scripts/deploy/origin-verification.py 校验，请勿改写。",
        "",
        FENCE_OPEN,
        "barrier_repo: " + barrier["repo"],
        "barrier_run_id: " + barrier["run_id"],
        "barrier_run_attempt: " + barrier["run_attempt"],
        "barrier_workflow_ref: " + barrier["workflow_ref"],
        "barrier_tooling_sha: " + barrier["tooling_sha"],
        "barrier_target_sha: " + barrier["target_sha"],
        "barrier_generated_at: " + barrier["generated_at"],
        "barrier_nonce: " + barrier["nonce"],
        "origin_sha: " + origin_sha,
        "origin_verified_at: " + args.origin_verified_at,
        "ops_task_id: " + args.ops_task_id,
        "fa_audit_ref: " + args.fa_audit_ref,
        FENCE_CLOSE,
        "",
    ]
    return "\n".join(lines)


def cmd_barrier(args):
    if not SHA_RE.match(args.target or ""):
        raise UsageError("--target must be a full lowercase commit SHA")
    if os.environ.get("GITHUB_RUN_ATTEMPT", "") != "1":
        raise UsageError("barrier refused: reruns are not allowed (run attempt must be 1); dispatch a new run")
    barrier = {
        "repo": require_env("GITHUB_REPOSITORY"),
        "run_id": require_env("GITHUB_RUN_ID"),
        "run_attempt": require_env("GITHUB_RUN_ATTEMPT"),
        "workflow_ref": require_env("GITHUB_WORKFLOW_REF"),
        "tooling_sha": require_env("GITHUB_SHA"),
        "target_sha": args.target,
        "generated_at": fmt_utc(now_epoch()),
        "nonce": secrets.token_hex(16),
    }
    validate_barrier(barrier)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(barrier, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    print(json.dumps(barrier, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


def cmd_render(args):
    barrier = load_barrier(args.barrier)
    sys.stdout.write(build_body(barrier, args, now_epoch()))
    return 0


def cmd_post(args):
    barrier = load_barrier(args.barrier)
    args.target = barrier["target_sha"]
    now = now_epoch()
    body = build_body(barrier, args, now)
    repo = barrier["repo"]
    fd, payload_path = tempfile.mkstemp(suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"body": body}, handle, ensure_ascii=False)
        created = gh_api(
            "repos/%s/issues/%s/comments" % (repo, args.pr),
            ["--method", "POST", "--input", payload_path],
        )
    finally:
        os.unlink(payload_path)
    try:
        posted_id = json.loads(created).get("id")
    except (ValueError, AttributeError):
        raise UsageError("gh did not return the created comment")
    try:
        result = evaluate(barrier, fetch_comments(repo, args.pr), args, now_epoch())
    except Refused as exc:
        emit("refused", str(exc), comment_id=posted_id)
        return 2
    except NoEvidence as exc:
        emit("no_evidence", str(exc), comment_id=posted_id)
        return 3
    emit("ok", "posted comment %s re-reads and verifies against the barrier" % posted_id, **result)
    return 0


def cmd_verify(args):
    barrier = load_barrier(args.barrier)
    bind_to_run(barrier)
    if barrier["target_sha"] != args.target:
        raise UsageError("barrier target %s is not the requested target %s" % (barrier["target_sha"], args.target))
    try:
        result = evaluate(barrier, collect(args, barrier["repo"]), args, now_epoch())
    except Refused as exc:
        emit("refused", str(exc))
        return 2
    except NoEvidence as exc:
        emit("no_evidence", str(exc))
        return 3
    write_result(args.result, result)
    emit("ok", "origin evidence verifies against the barrier", **result)
    return 0


def cmd_wait(args):
    barrier = load_barrier(args.barrier)
    bind_to_run(barrier)
    if barrier["target_sha"] != args.target:
        raise UsageError("barrier target %s is not the requested target %s" % (barrier["target_sha"], args.target))
    started = time.monotonic()
    last = "no evidence yet"
    while True:
        try:
            result = evaluate(barrier, collect(args, barrier["repo"]), args, now_epoch())
        except Refused as exc:
            emit("refused", str(exc))
            return 2
        except NoEvidence as exc:
            last = str(exc)
        except ApiError as exc:
            last = "transient GitHub API error: %s" % exc
        else:
            write_result(args.result, result)
            emit("ok", "origin evidence accepted for the barrier", **result)
            return 0
        remaining = args.timeout - (time.monotonic() - started)
        if remaining <= 0:
            emit("no_evidence", "timed out after %ds: %s" % (args.timeout, last))
            return 3
        time.sleep(min(float(args.interval), remaining))


def cmd_fetch(args):
    if not REPO_RE.match(args.repo or ""):
        raise UsageError("--repo must be owner/name")
    if not DIGITS_RE.match(args.run_id or ""):
        raise UsageError("--run-id must be a numeric run id")
    if not SHA_RE.match(args.target or ""):
        raise UsageError("--target must be a full lowercase commit SHA")
    if not WORKFLOW_PATH_RE.match(args.workflow_path or ""):
        raise UsageError("--workflow-path must be a .github/workflows/*.yml path")
    if args.max_age <= 0 or args.interval <= 0 or args.timeout < 0:
        raise UsageError("--max-age and --interval must be positive; --timeout must not be negative")
    started = time.monotonic()
    last = "barrier artifact not checked yet"
    while True:
        try:
            raw, barrier, artifact = fetch_barrier_once(args, now_epoch())
        except Refused as exc:
            emit("refused", str(exc))
            return 2
        except RunEnded as exc:
            emit("no_evidence", str(exc))
            return 3
        except NoEvidence as exc:
            last = str(exc)
        except ApiError as exc:
            last = "transient GitHub API error: %s" % exc
        else:
            write_bytes(args.out, raw)
            emit(
                "ok",
                "barrier artifact %s verified for run %s" % (artifact.get("name"), args.run_id),
                artifact_id=artifact.get("id"),
                artifact_created_at=artifact.get("created_at"),
                barrier_generated_at=barrier["generated_at"],
                barrier_sha256=hashlib.sha256(raw).hexdigest(),
            )
            return 0
        remaining = args.timeout - (time.monotonic() - started)
        if remaining <= 0:
            emit("no_evidence", "timed out after %ds: %s" % (args.timeout, last))
            return 3
        time.sleep(min(float(args.interval), remaining))


def add_barrier_arg(parser):
    parser.add_argument("--barrier", required=True, help="barrier.json 路径（发布作业生成）")


def add_evidence_args(parser):
    parser.add_argument("--origin-sha", required=True, help="运营只读核定到的 origin 运行完整 SHA")
    parser.add_argument("--origin-verified-at", required=True, help="核定时间 UTC YYYY-MM-DDTHH:MM:SSZ")
    parser.add_argument("--ops-task-id", required=True, help="执行采样的公司任务 ID")
    parser.add_argument("--fa-audit-ref", required=True, help="fa 运营 accept 审计编号")
    parser.add_argument("--max-age", type=int, default=DEFAULT_MAX_AGE, help="核定最长有效秒数")


def add_check_args(parser):
    parser.add_argument("--target", required=True, help="本次目标完整 SHA（须等于 barrier 目标）")
    parser.add_argument("--pr", required=True, help="承载证据评论的 PR 编号")
    parser.add_argument("--approvers", required=True, help="RELEASE_APPROVER_LOGINS，逗号分隔")
    parser.add_argument("--approval-ref", required=True, help="fa 运营 accept 审计编号")
    parser.add_argument("--max-age", type=int, default=DEFAULT_MAX_AGE, help="核定最长有效秒数")
    parser.add_argument("--comments-json", help="测试用：从文件读取评论列表，替代 GitHub API")
    parser.add_argument("--result", help="通过时写入结果 JSON")


def build_parser():
    parser = argparse.ArgumentParser(description="前端定向恢复的 origin 运行版本核定证据（锁内、只读）")
    sub = parser.add_subparsers(dest="command")
    sub.required = True

    p = sub.add_parser("barrier", help="发布作业内生成 barrier")
    p.add_argument("--target", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_barrier)

    p = sub.add_parser("render", help="渲染评论正文（运营本地预检，不发表）")
    add_barrier_arg(p)
    add_evidence_args(p)
    p.set_defaults(func=cmd_render)

    p = sub.add_parser("post", help="发表评论并回读校验（运营执行）")
    add_barrier_arg(p)
    add_evidence_args(p)
    p.add_argument("--pr", required=True)
    p.add_argument("--approvers", required=True)
    p.add_argument("--approval-ref", required=True)
    p.set_defaults(func=cmd_post)

    p = sub.add_parser("verify", help="校验绑定评论（发布作业内，写入前复核）")
    add_barrier_arg(p)
    add_check_args(p)
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("wait", help="有界等待绑定评论（发布作业内）")
    add_barrier_arg(p)
    add_check_args(p)
    p.add_argument("--timeout", type=int, default=1200, help="等待上限秒数")
    p.add_argument("--interval", type=int, default=30, help="轮询间隔秒数")
    p.set_defaults(func=cmd_wait)

    p = sub.add_parser("fetch", help="运行中经 artifact 取回并校验 barrier（运营执行，只读）")
    p.add_argument("--repo", required=True, help="owner/name")
    p.add_argument("--run-id", required=True, help="发布运行的 run id")
    p.add_argument("--target", required=True, help="派发的目标完整 SHA（须等于 barrier 目标）")
    p.add_argument("--out", required=True, help="校验通过后写入 barrier.json 的路径")
    p.add_argument("--workflow-path", default=RELEASE_WORKFLOW, help="期望的工作流文件路径")
    p.add_argument("--max-age", type=int, default=BARRIER_MAX_AGE, help="barrier 最长有效秒数")
    p.add_argument("--timeout", type=int, default=0, help="等待 artifact 可读的上限秒数（0 表示只查一次）")
    p.add_argument("--interval", type=int, default=15, help="轮询间隔秒数")
    p.set_defaults(func=cmd_fetch)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except UsageError as exc:
        print("::error::origin verification usage error: %s" % exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
