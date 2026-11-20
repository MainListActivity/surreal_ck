"""Offline SDK supply-chain/layout tests, not a native framework load test."""
import hashlib
import importlib.util
import io
from pathlib import Path
import plistlib
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sparkle_sdk', Path(__file__).with_name('install-sparkle-sdk.py'))
sdk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sdk)


class SparkleTests(unittest.TestCase):
    def archive(self, root, version=sdk.VERSION, traversal=False):
        archive = root / 'sdk.tar.xz'
        with tarfile.open(archive, 'w:xz') as bundle:
            files = {'Sparkle.framework/Headers/Sparkle.h': b'fixture only',
                     'Sparkle.framework/Resources/Info.plist': plistlib.dumps({'CFBundleShortVersionString': version})}
            if traversal:
                files['../escape'] = b'no'
            for name, data in files.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                bundle.addfile(info, io.BytesIO(data))
        return archive

    def test_verified_layout_and_version(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); archive = self.archive(root)
            with patch.object(sdk, 'SHA256', hashlib.sha256(archive.read_bytes()).hexdigest()):
                self.assertEqual(sdk.extract_verified(archive, root / 'out'), (root / 'out').resolve())
                with self.assertRaises(ValueError): sdk.extract_verified(archive, root / 'out')

    def test_mismatch_does_not_extract(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); archive = self.archive(root)
            with self.assertRaisesRegex(ValueError, 'checksum'): sdk.extract_verified(archive, root / 'out')
            self.assertFalse((root / 'out').exists())

    def test_version_and_path_attacks_are_rejected(self):
        for version, traversal in [('wrong', False), (sdk.VERSION, True)]:
            with self.subTest(version=version, traversal=traversal), tempfile.TemporaryDirectory() as temp:
                root = Path(temp); archive = self.archive(root, version, traversal)
                with patch.object(sdk, 'SHA256', hashlib.sha256(archive.read_bytes()).hexdigest()):
                    with self.assertRaises((ValueError, tarfile.FilterError)):
                        sdk.extract_verified(archive, root / 'out')
                self.assertFalse((root / 'escape').exists())


if __name__ == '__main__': unittest.main()
