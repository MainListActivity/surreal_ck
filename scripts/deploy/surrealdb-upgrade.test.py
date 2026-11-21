import argparse
from contextlib import ExitStack
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import socket
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
import urllib.error
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
    def test_transform_only_removes_top_level_redacted_access_keys(self):
        for algorithm in ("HS256", "HS384", "HS512"):
            with self.subTest(algorithm=algorithm), tempfile.TemporaryDirectory() as directory, patch.object(upgrade.os, "fchown"):
                original = Path(directory) / "original.surql"
                transformed = Path(directory) / "import.surql"
                record = (f"DEFINE ACCESS employee ON DATABASE TYPE RECORD SIGNIN {{ RETURN user:bot; }} "
                          f"WITH JWT ALGORITHM {algorithm} KEY '[REDACTED]' WITH ISSUER KEY '[REDACTED]' "
                          "DURATION FOR TOKEN 1h, FOR SESSION 1h;\n").encode()
                jwks = b"DEFINE ACCESS admin ON DATABASE TYPE JWT URL 'https://issuer.test/jwks' DURATION FOR SESSION 1h;\n"
                content = b"-- OPTION\n" + record + jwks + b"INSERT INTO data { text: 'real key' };\n"
                original.write_bytes(content)
                details = upgrade.transform_export(original, transformed)
                self.assertEqual(details, {"replacements": 2, "record_accesses": ["employee"]})
                self.assertEqual(original.read_bytes(), content)
                result = transformed.read_bytes()
                self.assertNotIn(b"[REDACTED]", result)
                self.assertIn(b"DURATION FOR TOKEN 1h, FOR SESSION 1h;", result)
                self.assertIn(jwks, result)
                self.assertEqual(transformed.stat().st_mode & 0o777, 0o600)
                with self.assertRaises(FileExistsError):
                    upgrade.transform_export(original, transformed)

    def test_transform_rejects_placeholders_outside_permitted_positions(self):
        values = (b"INSERT INTO data { text: '[REDACTED]' };\n",
                  b"-- [REDACTED]\n",
                  b"DEFINE ACCESS x ON DATABASE TYPE JWT ALGORITHM HS512 KEY '[REDACTED]';\n",
                  b"DEFINE ACCESS x ON DATABASE TYPE RECORD COMMENT '[REDACTED]';\n",
                  b"DEFINE ACCESS x ON DATABASE TYPE RECORD SIGNIN { RETURN 'WITH ISSUER KEY \\\'[REDACTED]\\\''; };\n",
                  b"DEFINE ACCESS x ON DATABASE TYPE RECORD SIGNIN { LET $x = WITH ISSUER KEY '[REDACTED]'; };\n",
                  b"DEFINE ACCESS x ON DATABASE TYPE RECORD\nWITH JWT ALGORITHM HS512 KEY '[REDACTED]';\n",
                  b"DEFINE ACCESS x ON DATABASE TYPE RECORD; INSERT INTO data { v: '[REDACTED]' };\n",
                  b"x" * (upgrade.TRANSFER_CHUNK - 4) + b"[REDACTED]\n")
        for content in values:
            with self.subTest(prefix=content[:60]), tempfile.TemporaryDirectory() as directory, patch.object(upgrade.os, "fchown"):
                original = Path(directory) / "source"
                original.write_bytes(content)
                with self.assertRaises(RuntimeError):
                    upgrade.transform_export(original, Path(directory) / "result")
                self.assertEqual(original.read_bytes(), content)

    def test_transform_streams_large_non_access_lines_and_keeps_explicit_keys(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(upgrade.os, "fchown"):
            original, result = Path(directory) / "source", Path(directory) / "result"
            content = (b"x" * (upgrade.TRANSFER_CHUNK * 3 + 2) + b"\n"
                       b"DEFINE ACCESS x ON DATABASE TYPE RECORD WITH JWT ALGORITHM HS512 KEY 'real-secret' "
                       b"WITH ISSUER KEY 'real-secret' DURATION FOR SESSION 1h;\n")
            original.write_bytes(content)
            self.assertEqual(upgrade.transform_export(original, result)["replacements"], 0)
            self.assertEqual(result.read_bytes(), content)

    def test_transform_preserves_jwks_while_removing_issuer_key_and_algorithm(self):
        original = b'DEFINE ACCESS reader ON DATABASE TYPE JWT URL "https://issuer.test/jwks" WITH ISSUER KEY "[REDACTED]" ALGORITHM HS512 DURATION FOR SESSION 1h;\n'
        transformed, count, record = upgrade.transform_access_line(original)
        self.assertEqual(count, 1)
        self.assertIsNone(record)
        self.assertIn(b'URL "https://issuer.test/jwks"', transformed)
        self.assertNotIn(b"WITH ISSUER", transformed)
        self.assertNotIn(b"ALGORITHM", transformed)

    def test_transform_empty_input_has_no_keys_or_record_accesses(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(upgrade.os, "fchown"):
            original, transformed = Path(directory) / "source", Path(directory) / "result"
            original.write_bytes(b"")
            self.assertEqual(upgrade.transform_export(original, transformed), {"replacements": 0, "record_accesses": []})
            self.assertEqual(transformed.read_bytes(), b"")

    def test_trial_checks_every_expected_record_access(self):
        definition = "DEFINE ACCESS employee ON DATABASE TYPE RECORD WITH JWT ALGORITHM HS512 KEY '[REDACTED]' DURATION FOR SESSION 1h"
        with patch.object(upgrade, "sql", return_value={"accesses": {"employee": definition}}) as sql:
            upgrade.validate_record_accesses("fixture", ("test", "secret"), "main", "main", ["employee"])
            self.assertEqual(sql.call_args.args[2], "INFO FOR DB;")
            sql.return_value = {"accesses": {}}
            upgrade.validate_record_accesses("fixture", ("test", "secret"), "main", "main", [])
            for catalog in ({}, {"accesses": {}}, {"accesses": {"employee": "DEFINE ACCESS employee ON DATABASE TYPE JWT URL 'https://issuer.test';"}}):
                sql.return_value = catalog
                with self.assertRaises(RuntimeError):
                    upgrade.validate_record_accesses("fixture", ("test", "secret"), "main", "main", ["employee"])

    def test_container_entrypoint_requires_an_inspected_absolute_path(self):
        self.assertEqual(upgrade.container_entrypoint({"Path": "/opt/source-db"}), "/opt/source-db")
        for value in ({}, {"Path": None}, {"Path": ""}, {"Path": "surreal"}, {"Path": 42}):
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, "absolute"):
                upgrade.container_entrypoint(value)

    def test_http_transfer_streams_with_private_logs_and_rejects_errors(self):
        dump = b"-- OPTION\n" + b"x" * (upgrade.TRANSFER_CHUNK * 3 + 17)
        cases = ((False, 200, dump, False, True), (False, 200, b"", False, False),
                 (False, 200, b'{"error":"private fixture-password"}', False, False),
                 (False, 503, b"private fixture-password", False, False),
                 (False, 302, b"private fixture-password", False, False),
                 (False, 200, dump, True, False),
                 (True, 200, b"", False, True),
                 (True, 200, b'[{"status":"ERR","result":"private fixture-password"}]', False, False),
                 (True, 422, b"private fixture-password", False, False))
        for importing, status, content, truncated, succeeds in cases:
            with self.subTest(importing=importing, status=status, truncated=truncated, succeeds=succeeds), \
                    tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "company--main.surql"
                if importing:
                    path.write_bytes(dump)
                body = io.BytesIO(content)
                sizes = []

                def read(size):
                    self.assertGreater(size, 0)
                    self.assertLessEqual(size, upgrade.TRANSFER_CHUNK)
                    sizes.append(size)
                    return body.read(size)

                def send(method, url, headers, body=None):
                    self.assertEqual(method, "POST" if importing else "GET")
                    self.assertEqual(url, "/import" if importing else "/export")
                    self.assertEqual(headers["surreal-ns"], "company")
                    self.assertEqual(headers["surreal-db"], "main")
                    self.assertTrue(headers["Authorization"].startswith("Basic "))
                    self.assertEqual(headers["Accept"], "application/octet-stream")
                    if importing:
                        self.assertFalse(isinstance(body, bytes))
                        total = 0
                        while chunk := body.read(upgrade.TRANSFER_CHUNK):
                            total += len(chunk)
                        self.assertEqual(total, len(dump))
                        self.assertEqual(int(headers["Content-Length"]), total)

                with patch.object(upgrade.http.client, "HTTPConnection") as connection, \
                        patch.object(upgrade.os, "fchown") as chown, \
                        patch.object(upgrade.subprocess, "run", side_effect=AssertionError("exec forbidden")):
                    client = connection.return_value
                    client.request.side_effect = send
                    response = client.getresponse.return_value
                    response.status = status
                    response.getheader.return_value = str(len(content) + int(truncated))
                    response.read.side_effect = read
                    args = ("http://127.0.0.1:8000", ("fixture", "fixture-password"), "company", "main", path)
                    if succeeds:
                        upgrade.http_transfer(*args, importing=importing)
                    else:
                        with self.assertRaisesRegex(RuntimeError, "^database HTTP (import|export) failed; inspect protected backup log$"):
                            upgrade.http_transfer(*args, importing=importing)
                    connection.assert_called_once_with("127.0.0.1", 8000, timeout=1800, blocksize=upgrade.TRANSFER_CHUNK)
                    client.close.assert_called_once()
                    self.assertTrue(all(call.args[1:] == (0, 0) for call in chown.call_args_list))
                self.assertTrue(sizes)
                log = path.with_name(path.name + (".import.stderr.log" if importing else ".stderr.log"))
                self.assertEqual(log.stat().st_mode & 0o777, 0o600)
                if importing and succeeds:
                    self.assertEqual(log.read_bytes(), b"HTTP 200\n")
                if b"private fixture-password" in content:
                    self.assertIn(b"private fixture-password", log.read_bytes())
                if not importing:
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                    if succeeds:
                        self.assertEqual(path.read_bytes(), dump)

    def test_http_transfer_rejects_remote_endpoints(self):
        for endpoint in ("https://127.0.0.1:8000", "http://example.org", "http://127.0.0.1/path", "http://user@127.0.0.1"):
            with self.subTest(endpoint=endpoint), self.assertRaisesRegex(RuntimeError, "loopback"):
                upgrade.export_database(endpoint, ("fixture", "secret"), "main", "main", Path("/unused"))

    def test_http_transfer_disconnect_is_private_and_logs_are_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(upgrade.os, "fchown"), \
                patch.object(upgrade.http.client, "HTTPConnection") as connection:
            output = Path(directory) / "fixture.surql"
            response = connection.return_value.getresponse.return_value
            response.status = 200
            response.getheader.return_value = None
            response.read.side_effect = [b"-- OPTION\n", ConnectionError("private diagnostic")]
            args = ("http://127.0.0.1:8000", ("fixture", "secret"), "main", "main", output)
            with self.assertRaisesRegex(RuntimeError, "^database HTTP export failed; inspect protected backup log$"):
                upgrade.export_database(*args)
            log = output.with_name(output.name + ".stderr.log")
            self.assertIn(b"private diagnostic", log.read_bytes())
            self.assertEqual(output.read_bytes(), b"-- OPTION\n")
            previous = log.read_bytes()
            with self.assertRaises(FileExistsError):
                upgrade.export_database(*args)
            self.assertEqual(log.read_bytes(), previous)
            response.close.assert_called_once()

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

    def test_import_sets_compatibility_three_before_http_upload(self):
        with patch.object(upgrade, "sql") as sql, patch.object(upgrade, "http_transfer") as transfer:
            args = ("http://127.0.0.1:19000", ("test", "secret"), "main", "_system", Path("/backup/main--_system.surql"))

            def upload(*values, **kwargs):
                self.assertEqual(sql.call_count, 3)
                self.assertEqual(sql.call_args.args[2:], ("ALTER DATABASE COMPATIBILITY 3;", "main", "_system"))

            transfer.side_effect = upload
            upgrade.import_database(*args)
            transfer.assert_called_once_with(*args, importing=True)

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
        self.validate_accesses = stack.enter_context(patch.object(upgrade, "validate_record_accesses"))
        stack.enter_context(patch.object(upgrade.os, "fchown"))
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

    def export_database(self, endpoint, auth, namespace, database, output):
        self.calls.append(("export_database", namespace, database))
        output.write_text("fixture export")

    def import_database(self, endpoint, auth, namespace, database, source):
        self.assertEqual(source.read_text(), "fixture export")
        self.calls.append(("import_database", namespace, database))

    def test_success_exports_all_databases_then_imports_into_new_directory(self):
        result = upgrade.upgrade(self.args)
        self.assertEqual(result["state"], "healthy")
        self.assertEqual(len(list(Path(result["backup"]).glob("*.surql"))), 6)
        self.assertEqual(self.validate_accesses.call_count, 3)
        summary = json.loads((Path(result["backup"]) / "access-transforms.json").read_text())
        self.assertEqual(len(summary), 3)
        self.assertTrue(all(row["replacements"] == 0 for row in summary))
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

    def test_unsafe_redaction_stops_before_source_database_stop_or_trial_import(self):
        with patch.object(upgrade, "transform_export", side_effect=RuntimeError("unsupported redaction")):
            with self.assertRaisesRegex(RuntimeError, "maintenance fence retained=True"):
                upgrade.upgrade(self.args)
        self.assertNotIn(("systemctl", "stop", upgrade.SERVICE), self.calls)
        self.assertFalse(any(call[0] == "import_database" for call in self.calls))

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


@unittest.skipUnless(os.environ.get("SURREAL_UPGRADE_SOURCE_BINARY") and os.environ.get("SURREAL_UPGRADE_TARGET_BINARY"),
                     "requires local 3.3 and candidate.233 binaries")
class AccessRotationBinaryTests(unittest.TestCase):
    def test_http_export_transform_import_and_employee_signin(self):
        processes = []
        with tempfile.TemporaryDirectory(prefix="sck-access-rotation-") as directory:
            try:
                endpoints = []
                for variable in ("SURREAL_UPGRADE_SOURCE_BINARY", "SURREAL_UPGRADE_TARGET_BINARY"):
                    with socket.socket() as listener:
                        listener.bind(("127.0.0.1", 0))
                        port = listener.getsockname()[1]
                    process = subprocess.Popen([os.environ[variable], "start", "--bind", f"127.0.0.1:{port}",
                                                "--allow-all", "--user", "root", "--pass", "fixture-password", "memory"],
                                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                               env={**os.environ, "SURREAL_LOG": "info"})
                    processes.append(process)
                    endpoint = f"http://127.0.0.1:{port}"
                    upgrade.wait_health(endpoint)
                    endpoints.append(endpoint)
                source, target = endpoints
                auth = ("root", "fixture-password")
                ns = db = "access_rotation_fixture"
                upgrade.sql(source, auth, f"DEFINE NAMESPACE IF NOT EXISTS {ns};")
                upgrade.sql(source, auth, f"DEFINE DATABASE IF NOT EXISTS {db};", ns)
                upgrade.sql(source, auth, "DEFINE TABLE user SCHEMALESS PERMISSIONS FULL;", ns, db)
                upgrade.sql(source, auth, 'CREATE user:bot CONTENT {subject: "fixture-employee", kind: "virtual", virtual_profile: {status: "active"}};', ns, db)
                upgrade.sql(source, auth, 'CREATE employee_credential:bot CONTENT {employee: user:bot, secret: "fixture-secret"};', ns, db)
                schema = (Path(__file__).parents[2] / "shared/sql/workspace-template/001-access.surql").read_text()
                employee = "DEFINE ACCESS OVERWRITE employee" + schema.split("DEFINE ACCESS OVERWRITE employee", 1)[1]
                upgrade.sql(source, auth, employee, ns, db)
                signin = json.dumps({"NS": ns, "DB": db, "AC": "employee", "subject": "fixture-employee", "pass": "fixture-secret"}).encode()
                headers = {"Accept": "application/json", "Content-Type": "application/json"}
                old_token = upgrade.request(source + "/signin", signin, headers)["token"]
                original, transformed = Path(directory) / "original.surql", Path(directory) / "import.surql"
                with patch.object(upgrade.os, "fchown"):
                    upgrade.export_database(source, auth, ns, db, original)
                    access_lines = [line for line in original.read_bytes().splitlines() if line.startswith(b"DEFINE ACCESS ")]
                    self.assertEqual(len(access_lines), 1)
                    self.assertIn(b"SIGNIN", access_lines[0])
                    self.assertIn(b"[REDACTED]", access_lines[0])
                    original_hash = upgrade.digest(original)
                    details = upgrade.transform_export(original, transformed)
                    self.assertEqual(details, {"replacements": 2, "record_accesses": ["employee"]})
                    self.assertEqual(upgrade.digest(original), original_hash)
                    upgrade.import_database(target, auth, ns, db, transformed)
                upgrade.validate_record_accesses(target, auth, ns, db, details["record_accesses"])
                token = upgrade.request(target + "/signin", signin, headers)["token"]
                self.assertTrue(token)
                self.assertNotEqual(token, old_token)
                result = upgrade.request(target + "/sql", b"RETURN $auth.id;", {"Accept": "application/json", "Content-Type": "text/plain", "Authorization": "Bearer " + token})
                self.assertEqual(result[0]["status"], "OK")
                self.assertEqual(result[0]["result"], "user:bot")
                with self.assertRaises(urllib.error.HTTPError) as rejected:
                    upgrade.request(target + "/sql", b"RETURN $auth.id;", {"Accept": "application/json", "Content-Type": "text/plain", "Authorization": "Bearer " + old_token})
                self.assertIn(rejected.exception.code, (401, 403))
                self.assertEqual(upgrade.inventory(source, auth)[(ns, db)], upgrade.inventory(target, auth)[(ns, db)])
                self.assertEqual(transformed.with_name(transformed.name + ".import.stderr.log").read_bytes(), b"HTTP 200\n")
            finally:
                for process in processes:
                    process.terminate()
                for process in processes:
                    process.wait(timeout=20)


if __name__ == "__main__":
    unittest.main()
