from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("surrealdb-offsite-backup.py")
spec = importlib.util.spec_from_file_location("offsite_backup", SCRIPT)
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class RemoteDigestTests(unittest.TestCase):
    def test_hashes_multi_chunk_remote_output(self):
        chunk_size = backup.upgrade.TRANSFER_CHUNK
        payload = b"a" * chunk_size + b"second chunk"
        with io.BytesIO(payload) as stream, patch.object(backup.subprocess, "Popen") as popen:
            process = popen.return_value.__enter__.return_value
            process.stdout = stream
            process.wait.return_value = 0

            with patch.object(stream, "read", wraps=stream.read) as read:
                self.assertEqual(
                    backup.remote_digest(["rclone", "--config", "fixture.conf"], "backup:db/archive.cms"),
                    hashlib.sha256(payload).hexdigest(),
                )
            self.assertGreaterEqual(read.call_count, 3)
            self.assertTrue(all(0 < call.args[0] <= chunk_size for call in read.call_args_list))

    def test_rejects_remote_read_with_nonzero_exit_even_if_it_produced_output(self):
        with io.BytesIO(b"partial ciphertext") as stream, patch.object(backup.subprocess, "Popen") as popen:
            process = popen.return_value.__enter__.return_value
            process.stdout = stream
            process.wait.return_value = 1
            with self.assertRaisesRegex(RuntimeError, "异地读取校验失败"):
                backup.remote_digest(["rclone"], "backup:db/archive.cms")


class ArchiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        keys = tempfile.TemporaryDirectory()
        cls.addClassCleanup(keys.cleanup)
        cls.key = Path(keys.name) / "recipient.key"
        cls.certificate = Path(keys.name) / "recipient.crt"
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
             "-subj", "/CN=Backup test", "-days", "1",
             "-keyout", str(cls.key), "-out", str(cls.certificate)],
            check=True, capture_output=True,
        )

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.work = Path(directory.name)
        self.archive = self.work / "archive.cms"
        self.restored = self.work / "restored"

    def create_archive(self):
        bundle = self.work / "bundle"
        bundle.mkdir()
        entries = {
            backup.transfer.MANIFEST: b'{"version": 1}',
            "0.import.surql": b"CREATE backup_fixture:record;",
        }
        for name, data in entries.items():
            (bundle / name).write_bytes(data)
        backup.archive(bundle, self.archive, self.certificate)
        return entries

    def test_round_trip_restores_manifest_and_dump_as_private_files(self):
        expected = self.create_archive()
        backup.unpack(self.archive, self.restored, self.certificate, self.key)

        with tarfile.open(self.work / "restore.tar", "r:gz") as tar:
            self.assertEqual(set(tar.getnames()), set(expected))
        restored = {path.name: path.read_bytes() for path in self.restored.iterdir()}
        self.assertEqual(restored, expected)
        self.assertEqual(stat.S_IMODE(self.restored.stat().st_mode), 0o700)
        for name in restored:
            self.assertEqual(stat.S_IMODE((self.restored / name).stat().st_mode), 0o600)

    def test_tampered_ciphertext_is_rejected_before_extraction(self):
        self.create_archive()
        ciphertext = bytearray(self.archive.read_bytes())
        ciphertext[len(ciphertext) // 2] ^= 1
        self.archive.write_bytes(ciphertext)

        with self.assertRaises(subprocess.CalledProcessError):
            backup.unpack(self.archive, self.restored, self.certificate, self.key)
        self.assertFalse(self.restored.exists())

    def test_rejects_tar_path_traversal_inside_authenticated_archive(self):
        plaintext = self.work / "unsafe.tar"
        data = b"unexpected dump"
        with tarfile.open(plaintext, "w") as tar:
            entry = tarfile.TarInfo("../escaped.import.surql")
            entry.size = len(data)
            tar.addfile(entry, io.BytesIO(data))
        self.encrypt_tar(plaintext)

        with self.assertRaisesRegex(RuntimeError, "归档成员无效"):
            backup.unpack(self.archive, self.restored, self.certificate, self.key)
        self.assertEqual(list(self.restored.iterdir()), [])
        self.assertFalse((self.work / "escaped.import.surql").exists())

    def test_restores_legacy_uncompressed_archive(self):
        plaintext = self.work / "legacy.tar"
        data = b'{"version": 1}'
        with tarfile.open(plaintext, "w") as tar:
            entry = tarfile.TarInfo(backup.transfer.MANIFEST)
            entry.size = len(data)
            tar.addfile(entry, io.BytesIO(data))
        self.encrypt_tar(plaintext)

        backup.unpack(self.archive, self.restored, self.certificate, self.key)
        self.assertEqual((self.restored / backup.transfer.MANIFEST).read_bytes(), data)

    def encrypt_tar(self, plaintext):
        subprocess.run(
            ["openssl", "cms", "-encrypt", "-binary", "-stream", "-aes-256-gcm",
             "-outform", "DER", "-in", str(plaintext), "-out", str(self.archive), str(self.certificate)],
            check=True, capture_output=True,
        )


class CommandTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.addCleanup(os.umask, os.umask(0o077))
        scratch = Path(directory.name)
        rclone_config = scratch / "fixture.conf"
        rclone_config.touch(mode=0o600)
        self.key = scratch / "fixture.key"
        self.key.touch(mode=0o600)
        self.endpoint = "http://127.0.0.1:1"
        self.fork_sha = "a" * 40
        self.args = [
            "--endpoint", self.endpoint, "--git-sha", self.fork_sha,
            "--credentials", str(scratch / "unused.json"), "--scratch", directory.name,
            "--certificate", str(scratch / "unused.crt"), "--rclone-config", str(rclone_config),
            "--remote", "backup:db/fixture",
        ]

    def test_accepts_both_backends_for_backup_and_restore_and_defaults_to_rocksdb(self):
        checksum = "b" * 64
        modes = {
            "backup": ["--confirm-fenced-source"],
            "restore": ["--confirm-isolated-target", "--key", str(self.key),
                        "--object", "surrealdb-20261127T082946337568Z.cms", "--sha256", checksum],
        }
        for mode, mode_args in modes.items():
            for backend in ("tikv", "rocksdb", None):
                with self.subTest(mode=mode, backend=backend):
                    selection = ["--backend", backend] if backend else []
                    output = io.StringIO()
                    with (
                        patch.object(sys, "argv", [str(SCRIPT), mode, *self.args, *mode_args, *selection]),
                        patch.object(backup.transfer, "check_server") as check_server,
                        patch.object(backup.transfer, "export_bundle", return_value={"databases": 1}),
                        patch.object(backup.transfer, "restore_bundle", return_value={"databases": 1}),
                        patch.object(backup, "credentials", return_value=("fixture", "fixture")),
                        patch.object(backup, "archive"),
                        patch.object(backup, "unpack"),
                        patch.object(backup, "run"),
                        patch.object(backup.upgrade, "digest", return_value=checksum),
                        patch.object(backup, "remote_digest", return_value=checksum),
                        redirect_stdout(output),
                    ):
                        backup.main()
                    expected = backend or "rocksdb"
                    check_server.assert_called_once_with(self.endpoint, expected, self.fork_sha)
                    receipt = json.loads(output.getvalue())
                    self.assertEqual(receipt["backend"], expected)
                    self.assertEqual(receipt["mode"], mode)

    def test_invalid_backend_is_rejected_by_argument_parser(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "backup", *self.args, "--backend", "invalid-engine"],
            capture_output=True, encoding="utf-8", check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertIn("argument --backend: invalid choice: 'invalid-engine'", result.stderr)

    def test_unconfirmed_backup_exits_nonzero_without_success_receipt(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "backup", *self.args],
            capture_output=True, encoding="utf-8", check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr.strip(), "备份要求已有写围栏覆盖全部数据库写入者")


if __name__ == "__main__":
    unittest.main()
