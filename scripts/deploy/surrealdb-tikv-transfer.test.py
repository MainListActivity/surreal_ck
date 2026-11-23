import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "transfer", Path(__file__).with_name("surrealdb-tikv-transfer.py")
)
transfer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)


class TransferTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.bundle = Path(directory.name)
        self.dump = self.bundle / "0.import.surql"
        self.dump.write_bytes(b"synthetic test data")
        self.manifest = {
            "version": 1,
            "catalog": {
                "namespaces": {"ns": {"definition": "DEFINE NAMESPACE ns", "databases": {"db": {}}}},
                "defaults": {},
                "config": {},
            },
            "artifacts": [{"sha256": transfer.upgrade.digest(self.dump), "access_key_replacements": 1}],
        }
        (self.bundle / transfer.MANIFEST).write_text(json.dumps(self.manifest))
        for module, name in ((transfer, "private_workspace"), (transfer.upgrade, "trusted_file")):
            guard = patch.object(module, name)
            guard.start()
            self.addCleanup(guard.stop)

    def test_rotation_requires_operator_acknowledgment_before_any_target_call(self):
        with patch.object(transfer, "root_catalog") as target:
            with self.assertRaisesRegex(RuntimeError, "轮换"):
                transfer.restore_bundle("target", ("root", "dummy"), self.bundle, False)
            target.assert_not_called()

    def test_checksum_mismatch_never_contacts_target(self):
        self.dump.write_bytes(b"changed")
        with patch.object(transfer, "root_catalog") as target:
            with self.assertRaisesRegex(RuntimeError, "文件校验失败"):
                transfer.restore_bundle("target", ("root", "dummy"), self.bundle, True)
            target.assert_not_called()

    def test_nonempty_target_never_replays_statements(self):
        with patch.object(transfer, "root_catalog", return_value=({"existing": {}}, {}, {})):
            with patch.object(transfer.upgrade, "sql") as sql:
                with self.assertRaisesRegex(RuntimeError, "目标必须为空"):
                    transfer.restore_bundle("target", ("root", "dummy"), self.bundle, True)
                sql.assert_not_called()

    def test_untrusted_quota_usage_is_rejected(self):
        quota = {"policy": {}, "ledger": {"usage_trusted": False}}
        with patch.object(transfer.upgrade, "sql", return_value=quota):
            with self.assertRaisesRegex(RuntimeError, "账本不可信"):
                transfer.quota_state("source", ("root", "dummy"), "ns", "db")

    def test_non_loopback_endpoint_never_contacts_server(self):
        with patch.object(transfer.upgrade, "request") as request:
            with self.assertRaisesRegex(RuntimeError, "127.0.0.1"):
                transfer.check_server("http://example.com:1234", "tikv", "a" * 40)
            request.assert_not_called()

    def test_database_request_does_not_follow_redirects(self):
        client = transfer.upgrade.http.client
        with patch.object(client, "HTTPConnection") as connect:
            response = connect.return_value.getresponse.return_value.__enter__.return_value
            response.status = 302
            response.headers = {"Location": "http://example.com/sql"}
            with self.assertRaises(transfer.upgrade.urllib.error.HTTPError):
                transfer.upgrade.request("http://127.0.0.1:1234/sql", b"test")
            connect.assert_called_once_with("127.0.0.1", 1234, timeout=60)


if __name__ == "__main__":
    unittest.main()
