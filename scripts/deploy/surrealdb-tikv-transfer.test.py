from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from threading import Event
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
        manifest = self.bundle / transfer.MANIFEST
        manifest.write_text(json.dumps(self.manifest))
        for path in (self.dump, manifest):
            path.chmod(0o600)

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

    def test_empty_database_does_not_query_tables(self):
        with patch.object(transfer.upgrade, "request") as request:
            self.assertEqual(transfer.table_catalog("source", ("root", "fixture"), "ns", "db", {}), {})
            self.assertEqual(transfer.upgrade.database_counts("source", ("root", "fixture"), "ns", "db", {}), {})
            request.assert_not_called()

    def test_export_batches_each_database_counts_once_and_preserves_sorted_order(self):
        endpoint = "http://127.0.0.1:1234"
        database_names = {"z": {"b": "DEFINE DATABASE b"},
                          "a": {"z": "DEFINE DATABASE z", "a": "DEFINE DATABASE a"}}
        expected_order = [("a", "a"), ("a", "z"), ("z", "b")]
        tables = {"z": "DEFINE TABLE z", "a": "DEFINE TABLE a"}
        count_sql = b"SELECT count() AS count FROM `a` GROUP ALL;\nSELECT count() AS count FROM `z` GROUP ALL;"
        info_sql = b"INFO FOR TABLE `a`;\nINFO FOR TABLE `z`;"
        later_catalog_read = Event()
        later_export_written = Event()

        def query(url, sql, headers, **options):
            self.assertEqual(url, endpoint + "/sql")
            ns, db = headers.get("surreal-ns"), headers.get("surreal-db")
            if sql == b"INFO FOR ROOT;":
                values = [{"namespaces": {ns: f"DEFINE NAMESPACE {ns}" for ns in database_names},
                           "users": {"root": "definition"}}]
            elif sql == b"INFO FOR NS;":
                values = [{"databases": database_names[ns]}]
            elif sql == b"INFO FOR DB;":
                if (ns, db) == expected_order[0]:
                    self.assertTrue(later_catalog_read.wait(3), "database snapshots did not overlap")
                elif (ns, db) == expected_order[1]:
                    later_catalog_read.set()
                values = [{"tables": tables}]
            elif sql == info_sql:
                values = [{"indexes": {"a_unique": "definition"}, "lives": {"ephemeral": "definition"}}, {}]
            elif sql == count_sql:
                values = [[{"count": 1}], []]
            else:
                self.assertEqual(sql, f"INFO FOR QUOTA ON DATABASE `{db}` STRUCTURE;".encode())
                values = [{"policy": None}]
            return [{"status": "OK", "result": value} for value in values]

        def dump(ns, db):
            return f"-- {ns}/{db}\n".encode()

        def export_database(endpoint, auth, ns, db, output):
            if (ns, db) == expected_order[0]:
                self.assertTrue(later_export_written.wait(3), "database exports did not overlap")
            output.write_bytes(dump(ns, db))
            if (ns, db) == expected_order[1]:
                later_export_written.set()

        exported = self.bundle / "exported"
        with (patch.object(transfer.upgrade, "request", side_effect=query) as request,
              patch.object(transfer.upgrade, "export_database", side_effect=export_database)):
            self.assertEqual(transfer.export_bundle(endpoint, ("root", "fixture"), exported),
                             {"namespaces": 2, "databases": 3})

        def queried_databases(sql):
            return Counter((headers["surreal-ns"], headers["surreal-db"])
                           for _, body, headers in (call.args for call in request.call_args_list) if body == sql)

        self.assertEqual(queried_databases(count_sql), Counter(expected_order))
        self.assertEqual(queried_databases(info_sql), Counter(expected_order * 2))
        receipt = transfer.read_bundle(exported)
        self.assertEqual([(ns, db) for ns, db, _ in transfer.databases(receipt["catalog"]["namespaces"])],
                         expected_order)
        for index, (ns, db, metadata) in enumerate(transfer.databases(receipt["catalog"]["namespaces"])):
            self.assertEqual(metadata["counts"], {"a": 1, "z": 0})
            self.assertEqual(metadata["tables"]["a"], {"indexes": {"a_unique": "definition"}})
            self.assertEqual((exported / f"{index}.import.surql").read_bytes(), dump(ns, db))
            self.assertEqual(receipt["artifacts"][index]["sha256"], hashlib.sha256(dump(ns, db)).hexdigest())

    def test_export_rejects_post_export_directory_or_quota_drift(self):
        metadata = {"definition": "DEFINE DATABASE db", "catalog": {"tables": {"sample": "DEFINE TABLE sample"}},
                    "tables": {"sample": {}}, "quota": {"usage": {"total": 2}}}

        def snapshot(db):
            return {"namespaces": {"ns": {"definition": "DEFINE NAMESPACE ns", "databases": {"db": db}}},
                    "defaults": {}, "config": {}}

        before = snapshot({**metadata, "counts": {"sample": 2}})
        changes = (
            {**metadata, "tables": {"sample": {"indexes": {"new": "definition"}}}},
            {**metadata, "quota": {"usage": {"total": 3}}},
        )
        for index, changed in enumerate(changes):
            exported = self.bundle / f"changed-{index}"
            with (patch.object(transfer, "snapshot", side_effect=[before, snapshot(changed)]),
                  patch.object(transfer.upgrade, "export_database"),
                  patch.object(transfer.upgrade, "transform_export", return_value={"replacements": 0}),
                  patch.object(transfer.upgrade, "digest", return_value="a" * 64)):
                with self.assertRaisesRegex(RuntimeError, "导出期间数据目录或配额状态发生变化"):
                    transfer.export_bundle("source", ("root", "fixture"), exported)
            self.assertFalse((exported / transfer.MANIFEST).exists())

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
