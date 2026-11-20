import argparse
from contextlib import ExitStack
import importlib.util
import json
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("upgrade", Path(__file__).with_name("surrealdb-upgrade.py"))
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


def capability():
    return {
        "manifest_revision": "native-quota-v2.0",
        "fork": {"id": "mainlistactivity/surrealdb-native-quota", "release": upgrade.TARGET},
        "quota": {"contract_major": 1},
        "storage": {"storage_version": 32772, "ready": True, "state": "ready", "migration_required": False,
                    "backend": "rocksdb", "marker": {"upstream_storage_major": 4, "migration_state": "clean",
                    "minimum_compatible_fork_release": upgrade.TARGET}},
        "backend": {"name": "rocksdb", "hard_quota_certified": True, "production": True,
                    "persistent_restart_certified": True, "certification_revision": "native-quota-contract-v1"},
    }


class SafetyTests(unittest.TestCase):
    def test_container_entrypoint_requires_an_inspected_absolute_path(self):
        self.assertEqual(upgrade.container_entrypoint({"Path": "/opt/source-db"}), "/opt/source-db")
        for value in ({}, {"Path": None}, {"Path": ""}, {"Path": "surreal"}, {"Path": 42}):
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, "absolute"):
                upgrade.container_entrypoint(value)

    def test_export_uses_inspected_binary_and_private_stderr_without_disclosure(self):
        for code, content in ((0, b"fixture export"), (1, b"partial export"), (0, b"")):
            with self.subTest(code=code, content=content), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "company--main.surql"
                error_log = output.with_name(output.name + ".stderr.log")

                def execute(argv, **kwargs):
                    self.assertEqual(argv[argv.index(upgrade.CONTAINER) + 1], "/opt/source-db")
                    self.assertNotIn("fixture-password", argv)
                    self.assertEqual(kwargs["env"]["SURREAL_PASS"], "fixture-password")
                    kwargs["stdout"].write(content)
                    kwargs["stderr"].write(b"private diagnostic fixture-password")
                    return subprocess.CompletedProcess(argv, code)

                with patch.object(upgrade.subprocess, "run", side_effect=execute), \
                        patch.object(upgrade.os, "fchown") as chown:
                    args = ("/opt/source-db", "http://fixture", ("fixture", "fixture-password"), "company", "main", output)
                    if code or not content:
                        with self.assertRaisesRegex(RuntimeError, "^container database export failed$"):
                            upgrade.export_database(*args)
                    else:
                        upgrade.export_database(*args)
                    self.assertEqual(chown.call_count, 2)
                    self.assertTrue(all(call.args[1:] == (0, 0) for call in chown.call_args_list))
                self.assertEqual(output.stat().st_mode & 0o777, 0o600)
                self.assertEqual(error_log.stat().st_mode & 0o777, 0o600)
                self.assertEqual(output.read_bytes(), content)
                self.assertEqual(error_log.read_bytes(), b"private diagnostic fixture-password")
                with self.assertRaises(FileExistsError):
                    upgrade.export_database(*args)

    def test_restore_drill_uses_source_entrypoint_and_always_stops(self):
        for matches in (True, False):
            with self.subTest(matches=matches), patch.object(upgrade, "copy_data"), \
                    patch.object(upgrade, "run") as command, patch.object(upgrade, "wait_health"), \
                    patch.object(upgrade, "inventory", return_value={"fixture": 1} if matches else {}):
                args = (upgrade.SOURCE_IMAGE, "/opt/source-db", Path("/snapshot"), Path("/restore"),
                        ("fixture", "fixture-password"), {"fixture": 1})
                if matches:
                    upgrade.restore_drill(*args)
                else:
                    with self.assertRaisesRegex(RuntimeError, "row counts differ"):
                        upgrade.restore_drill(*args)
                launch = command.call_args_list[0].args
                self.assertEqual(launch[launch.index("--entrypoint") + 1], "/opt/source-db")
                self.assertIn(upgrade.SOURCE_IMAGE, launch)
                self.assertEqual(launch[-1], "rocksdb:/data")
                self.assertEqual(command.call_args.args[:4], (upgrade.PODMAN, "stop", "--time", "30"))

    def test_private_env_allows_root_group_read_but_no_group_write_or_other_access(self):
        path = unittest.mock.Mock()
        path.is_symlink.return_value = False
        path.read_text.return_value = 'SURREAL_USER=root\nSURREAL_PASS="fixture password"\n'
        for mode in (0o600, 0o640):
            path.stat.return_value = SimpleNamespace(st_uid=0, st_gid=1000, st_mode=stat.S_IFREG | mode)
            self.assertEqual(upgrade.host_env(path)['SURREAL_PASS'], 'fixture password')
        for uid, mode in ((1000, 0o640), (0, 0o660), (0, 0o644), (0, 0o641), (0, 0o650)):
            path.stat.return_value = SimpleNamespace(st_uid=uid, st_mode=stat.S_IFREG | mode)
            with self.assertRaises(RuntimeError):
                upgrade.host_env(path)

    def test_inventory_quotes_numeric_leading_namespace_database_and_table(self):
        name = '953lb2sli64ha56neo25'
        with patch.object(upgrade, 'sql', side_effect=[{'namespaces': {name: ''}},
                {'databases': {name: ''}}, {'tables': {name: 'DEFINE TABLE fixture'}}, [{'count': 2}]]) as sql:
            self.assertEqual(upgrade.inventory('http://fixture', ('test', 'test')), {(name, name): {name: 2}})
            self.assertIn('FROM `' + name + '` GROUP ALL', sql.call_args.args[2])
        for invalid in ('', 'db`', 'a.b', 'a\nb', 'db; DELETE data;'):
            with self.assertRaises(RuntimeError):
                upgrade.identifier(invalid)

    def test_capabilities_require_clean_certified_storage(self):
        upgrade.validate_capability(capability())
        for value in ({}, {"storage": {}}, {**capability(), "backend": {"name": "surrealkv"}}):
            with self.assertRaises(RuntimeError):
                upgrade.validate_capability(value)

    def test_no_credentials_in_report_or_unit_expansion(self):
        self.assertEqual(upgrade.redact(["surreal", "--pass", "fixture-secret", "--user=fixture"]),
                         ["surreal", "--pass", "[REDACTED]", "--user=[REDACTED]"])
        rendered = upgrade.unit(["/opt/bin/surreal", "$DOLLAR", "100%", 'a"b'])
        self.assertIn('"$$DOLLAR"', rendered)
        self.assertIn('"100%%"', rendered)
        with self.assertRaises(RuntimeError):
            upgrade.unit(["surreal\nstart"])

    def test_dispatch_without_confirmation_never_inspects_host(self):
        with patch.object(upgrade, "inspect") as inspect:
            with self.assertRaises(RuntimeError):
                upgrade.upgrade(argparse.Namespace(confirmation="", approval_ref="approval"))
            inspect.assert_not_called()

    def test_empty_inventory_and_tagged_image_are_refused(self):
        with patch.object(upgrade, "sql", return_value={"namespaces": {}}):
            with self.assertRaisesRegex(RuntimeError, "empty"):
                upgrade.inventory("http://fixture", ("test", "test"))
        with self.assertRaisesRegex(RuntimeError, "digest-pinned"):
            upgrade.validate_image("ghcr.io/mainlistactivity/surrealdb-native-quota:latest")

    def test_import_uses_container_binary_and_readonly_mounted_file(self):
        with patch.object(upgrade, "sql"), patch.object(upgrade.subprocess, "run") as command:
            command.return_value.returncode = 0
            upgrade.import_database("trial", "/surreal-upgrade", "http://fixture", ("test", "secret"),
                                    "main", "_system", Path("/backup/main--_system.surql"))
            argv = command.call_args.args[0]
            self.assertEqual(argv[0:2], [upgrade.PODMAN, "exec"])
            self.assertIn("/surreal-upgrade", argv)
            self.assertEqual(argv[-1], "/upgrade-exports/main--_system.surql")
            self.assertNotIn("secret", argv)
            command.return_value.returncode = 1
            with self.assertRaisesRegex(RuntimeError, "import failed"):
                upgrade.import_database("trial", "/surreal-upgrade", "http://fixture", ("test", "secret"),
                                        "main", "_system", Path("/backup/main--_system.surql"))

    def test_check_has_no_host_writes(self):
        with patch.object(upgrade, "inspect", return_value=({"version": upgrade.SOURCE}, [], None, "local")), \
                patch("sys.argv", ["upgrade", "check", "--approval-ref", "test"]), \
                patch("builtins.print") as output, patch("builtins.open", side_effect=AssertionError("write")), \
                patch.object(upgrade, "switch", side_effect=AssertionError("switch")):
            upgrade.main()
            self.assertEqual(json.loads(output.call_args.args[0]), {"version": upgrade.SOURCE})


class SandboxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sck-db-upgrade-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / "data"
        self.data.mkdir()
        (self.data / "old-records").write_text("unchanged")
        self.candidate = self.root / "candidate"
        self.candidate.write_bytes(b"test binary")
        self.contract = self.root / "compatibility.ts"
        self.contract.write_text(f'forkRelease: "{upgrade.TARGET}"')
        self.backups = self.root / "backups"
        self.backups.mkdir()
        self.unit = self.root / "surrealdb.service"
        self.unit.write_text("[Service]\nExecStart=/usr/bin/podman run fixture\n")
        self.fence = self.root / "fence"
        self.unfence = self.root / "unfence"
        self.fence.touch()
        self.unfence.touch()
        self.args = argparse.Namespace(confirmation=upgrade.CONFIRMATION, approval_ref="sandbox-only",
                                       binary=str(self.candidate), sha256=upgrade.digest(self.candidate), image="", receipt=None,
                                       storage_engine="rocksdb", defer_origin_start=False)
        self.report = {"version": upgrade.SOURCE, "binary": "/surreal", "systemd_exec_start_path": upgrade.PODMAN,
                       "container_image": upgrade.SOURCE_IMAGE, "architecture": "aarch64", "storage_engine": "rocksdb",
                       "free_bytes": 10 ** 12, "data_bytes": 10, "capabilities": capability(), "service_user": "test"}
        self.argv = ["/old/surreal", "start", "rocksdb://" + str(self.data)]
        self.counts = {("main", "_system"): {"workspace": 1}, ("main", "ws_one"): {},
                       ("main", "platform_content"): {"article": 2}}
        self.calls = []
        stack = ExitStack()
        self.addCleanup(stack.close)
        for key, value in {"LOCK": self.root / "lock", "DROPIN": self.root / "systemd" / "override.conf",
                           "RELEASES": self.root / "bin" / "releases", "ORIGIN_CONTRACT": self.contract,
                           "BACKUPS": self.backups, "UNIT": self.unit, "DATA": self.data}.items():
            stack.enter_context(patch.object(upgrade, key, value))
        self.inspect = stack.enter_context(patch.object(upgrade, "inspect", side_effect=[
            (self.report, self.argv, self.data, "http://local"),
            ({**self.report, "version": upgrade.TARGET, "binary_sha256": self.args.sha256}, self.argv, self.data, "http://local")]))
        stack.enter_context(patch.object(upgrade, "credentials", return_value=("fixture", "fixture-password")))
        stack.enter_context(patch.object(upgrade, "trusted_file"))
        stack.enter_context(patch.object(upgrade, "host_env", return_value={"SURREAL_UPGRADE_FENCE": str(self.fence),
                                                                          "SURREAL_UPGRADE_UNFENCE": str(self.unfence)}))
        self.inventory = stack.enter_context(patch.object(upgrade, "inventory", return_value=self.counts))
        self.restore_drill = stack.enter_context(patch.object(upgrade, "restore_drill"))
        stack.enter_context(patch.object(upgrade, "export_database", side_effect=self.export_database))
        stack.enter_context(patch.object(upgrade, "import_database", side_effect=self.import_database))
        self.request = stack.enter_context(patch.object(upgrade, "request", return_value=capability()))
        stack.enter_context(patch.object(upgrade, "wait_health"))
        stack.enter_context(patch.object(upgrade, "run", side_effect=self.fake_run))

    def fake_run(self, *args, env=None):
        self.calls.append(args)
        if args[0] == "cp":
            shutil.copytree(args[-2], args[-1])
        if "inspect" in args:
            return json.dumps([{"Path": "/surreal-upgrade"}])
        return upgrade.TARGET + "+sha.fixture" if "version" in args else ""

    def export_database(self, binary, endpoint, auth, namespace, database, output):
        self.assertEqual(binary, self.report["binary"])
        self.calls.append(("export_database", namespace, database))
        output.write_text("fixture export")

    def import_database(self, container, binary, endpoint, auth, namespace, database, source):
        self.assertEqual(source.read_text(), "fixture export")
        self.calls.append(("import_database", namespace, database))

    def test_success_exports_all_databases_then_imports_into_new_directory(self):
        result = upgrade.upgrade(self.args)
        self.assertEqual(result["state"], "healthy")
        self.assertEqual(len(list(Path(result["backup"]).glob("*.surql"))), 3)
        imports = [i for i, args in enumerate(self.calls) if args[0] == "import_database"]
        self.assertEqual(len(imports), 3)
        self.assertLess(self.calls.index(("systemctl", "stop", upgrade.SERVICE)), imports[0])
        self.assertIn("data-native-4.0-", upgrade.DROPIN.read_text())
        self.assertNotIn(f"{self.data}:/data", upgrade.DROPIN.read_text())
        self.assertEqual((Path(result["backup"]) / "surrealdb.service.original").read_text(), self.unit.read_text())
        self.assertEqual(self.calls[-1], (str(self.unfence),))
        self.assertEqual((self.data / "old-records").read_text(), "unchanged")
        self.assertEqual(self.restore_drill.call_args.args[:2], (upgrade.SOURCE_IMAGE, self.report["binary"]))

    def test_nondefault_inspected_source_path_reaches_exports_and_restore(self):
        self.report["binary"] = "/opt/source-db"
        result = upgrade.upgrade(self.args)
        self.assertEqual(result["state"], "healthy")
        self.assertEqual(self.restore_drill.call_args.args[1], "/opt/source-db")

    def test_export_failure_keeps_source_database_running_and_fence_closed(self):
        with patch.object(upgrade, "export_database", side_effect=RuntimeError("container database export failed")):
            with self.assertRaisesRegex(RuntimeError, "maintenance fence retained=True"):
                upgrade.upgrade(self.args)
        self.assertNotIn(("systemctl", "stop", upgrade.SERVICE), self.calls)
        self.assertNotIn(("systemctl", "start", upgrade.ORIGIN), self.calls)
        self.assertNotIn((str(self.unfence),), self.calls)
        self.restore_drill.assert_not_called()
        self.assertEqual((self.data / "old-records").read_text(), "unchanged")

    def test_count_mismatch_restores_original_unit_on_untouched_old_directory(self):
        self.inventory.side_effect = [self.counts, self.counts, {}]
        with self.assertRaisesRegex(RuntimeError, "maintenance fence retained=True"):
            upgrade.upgrade(self.args)
        self.assertFalse(upgrade.DROPIN.exists())
        self.assertIn(("systemctl", "start", upgrade.SERVICE), self.calls)
        self.assertNotIn((str(self.unfence),), self.calls)
        self.assertNotIn(("systemctl", "start", upgrade.ORIGIN), self.calls)
        self.assertEqual((self.data / "old-records").read_text(), "unchanged")

    def test_default_mode_refuses_old_origin_before_fencing(self):
        self.contract.write_text(f'forkRelease: "{upgrade.SOURCE}"')
        with self.assertRaisesRegex(RuntimeError, "stage the compatible origin"):
            upgrade.upgrade(self.args)
        self.assertEqual(self.calls, [])

    def test_deferred_origin_requires_no_current_contract_and_retains_fence(self):
        self.args.defer_origin_start = True
        self.contract.unlink()
        result = upgrade.upgrade(self.args)
        self.assertEqual(result["state"], "database_ready_origin_stopped")
        self.assertEqual(result["write_fence"], "retained")
        self.assertIn((str(self.fence),), self.calls)
        self.assertIn(("systemctl", "stop", upgrade.ORIGIN), self.calls)
        self.assertIn(("systemctl", "start", upgrade.SERVICE), self.calls)
        self.assertNotIn(("systemctl", "start", upgrade.ORIGIN), self.calls)
        self.assertNotIn((str(self.unfence),), self.calls)

    def test_deferred_mode_count_mismatch_still_restores_old_database(self):
        self.args.defer_origin_start = True
        self.contract.unlink()
        self.inventory.side_effect = [self.counts, self.counts, self.counts, {}]
        with self.assertRaisesRegex(RuntimeError, "maintenance fence retained=True"):
            upgrade.upgrade(self.args)
        self.assertFalse(upgrade.DROPIN.exists())
        self.assertNotIn(("systemctl", "start", upgrade.ORIGIN), self.calls)
        self.assertNotIn((str(self.unfence),), self.calls)
        self.assertEqual((self.data / "old-records").read_text(), "unchanged")

    def test_uncertified_surrealkv_never_imports_or_switches(self):
        self.args.storage_engine = "surrealkv"
        rejected = capability()
        rejected["storage"]["backend"] = "surrealkv"
        rejected["backend"]["name"] = "surrealkv"
        rejected["backend"]["hard_quota_certified"] = False
        self.request.return_value = rejected
        with self.assertRaisesRegex(RuntimeError, "maintenance fence retained=True"):
            upgrade.upgrade(self.args)
        self.assertFalse(any(call[0] == "import_database" for call in self.calls))
        self.assertFalse(upgrade.DROPIN.exists())
        self.assertEqual((self.data / "old-records").read_text(), "unchanged")

    def test_checksum_mismatch_never_inspects_or_fences(self):
        self.args.sha256 = "0" * 64
        with self.assertRaisesRegex(RuntimeError, "checksum"):
            upgrade.upgrade(self.args)
        self.inspect.assert_not_called()
        self.assertEqual(self.calls, [])

    def test_already_target_is_read_only_noop(self):
        self.report["version"] = upgrade.TARGET
        self.assertEqual(upgrade.upgrade(self.args)["state"], "already_target")
        self.assertEqual(self.calls, [])

    def test_other_release_is_refused_before_stopping_writes(self):
        self.report["version"] = "3.3.1-native-quota.1"
        with self.assertRaisesRegex(RuntimeError, "exact 3.3"):
            upgrade.upgrade(self.args)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
