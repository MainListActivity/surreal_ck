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

退出码：0 通过；1 用法或接口错误；2 拒绝（找到绑定评论但不符合）；3 尚无绑定评论。
"""

import argparse
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
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


class UsageError(Exception):
    """参数、环境、barrier 文件或 GitHub 接口的确定性错误，退出码 1。"""


class ApiError(UsageError):
    """GitHub 接口临时失败；wait 在超时前会重试。"""


class Refused(Exception):
    """找到与 barrier 绑定的评论，但不符合要求；退出码 2，立即停止。"""


class NoEvidence(Exception):
    """尚无与 barrier 绑定的评论；退出码 3。"""


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
