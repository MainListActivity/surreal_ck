import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("meeting-schema-preflight.py").resolve()
MIGRATION = "002-native-meeting.surql"
SQL = b"-- committed fixture\n"


class MeetingSchemaPreflightTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name)
        self.git("init", "-q")
        self.template = self.repo / "shared/sql/workspace-template"
        self.template.mkdir(parents=True)
        (self.template / "001-access.surql").write_bytes(SQL)
        self.baseline = self.commit()

    def git(self, *args):
        return subprocess.check_output(
            ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", *args],
            cwd=self.repo, text=True,
        ).strip()

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def check(self, candidate, migration=MIGRATION):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--candidate", candidate, "--migration", migration],
            cwd=self.repo, capture_output=True, text=True,
        )

    def test_only_hashes_committed_candidate_even_if_head_and_worktree_differ(self):
        migration = self.template / MIGRATION
        migration.write_bytes(SQL)
        (self.template / "003-later.surql").write_bytes(SQL)
        candidate = self.commit()
        (self.template / "004-after-candidate.surql").write_bytes(SQL)
        self.commit()
        migration.write_bytes(b"-- uncommitted\n")
        result = self.check(candidate)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {
            "candidate_sha": candidate,
            "meeting_migration": MIGRATION,
            "meeting_migration_sha256": hashlib.sha256(SQL).hexdigest(),
            "workspace_template_version": 3,
        })

    def test_missing_migration_is_not_satisfied_by_uncommitted_file(self):
        (self.template / MIGRATION).write_bytes(SQL)
        result = self.check(self.baseline)
        self.assertEqual(result.returncode, 2)
        self.assertIn("候选提交缺少指定的会议迁移", result.stderr)
        self.assertFalse(result.stdout)

    def test_rejects_refs_object_ids_and_paths(self):
        blob = self.git("rev-parse", f"{self.baseline}:shared/sql/workspace-template/001-access.surql")
        for candidate, migration, error in [
            ("HEAD", MIGRATION, "完整 Git 提交 SHA"),
            (self.baseline[:7], MIGRATION, "完整 Git 提交 SHA"),
            (blob, MIGRATION, "必须指向提交"),
            (self.baseline, f"../{MIGRATION}", "带版本号的文件名"),
        ]:
            with self.subTest(candidate=candidate, migration=migration):
                result = self.check(candidate, migration)
                self.assertEqual(result.returncode, 2)
                self.assertIn(error, result.stderr)

    def test_rejects_invalid_duplicate_and_gapped_template_versions(self):
        for filename, error in [
            ("bad-name.surql", "非法迁移文件"),
            ("001-duplicate.surql", "版本重复"),
            ("003-gap.surql", "连续递增"),
        ]:
            with self.subTest(filename=filename):
                path = self.template / filename
                path.write_bytes(SQL)
                result = self.check(self.commit())
                self.assertEqual(result.returncode, 2)
                self.assertIn(error, result.stderr)
                path.unlink()

    def test_rejects_symlink_or_empty_meeting_migration(self):
        migration = self.template / MIGRATION
        migration.symlink_to("001-access.surql")
        result = self.check(self.commit())
        self.assertEqual(result.returncode, 2)
        self.assertIn("非法迁移文件", result.stderr)
        migration.unlink()
        migration.touch()
        result = self.check(self.commit())
        self.assertEqual(result.returncode, 2)
        self.assertIn("会议迁移为空", result.stderr)


if __name__ == "__main__":
    unittest.main()
