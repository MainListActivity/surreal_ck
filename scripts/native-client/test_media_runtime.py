import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('prepare_media', Path(__file__).with_name('prepare-media-runtime.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RuntimeContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'runtime'
        (self.root / 'bin').mkdir(parents=True)
        binary = bytearray(128)
        binary[:2] = b'MZ'
        struct.pack_into('<I', binary, 60, 64)
        binary[64:68] = b'PE\0\0'
        struct.pack_into('<H', binary, 68, 0x8664)
        for tool in ('ffmpeg', 'ffplay'):
            (self.root / 'bin' / (tool + '.exe')).write_bytes(binary)
        for name in ('LICENSE', 'source.tar', 'build.txt'):
            (self.root / name).write_text('synthetic test fixture only')
        evidence = dict(platform='windows', arch='x86_64', **{k: 'passed' for k in ('clean_path', 'vp8_roundtrip', 'opus_roundtrip', 'ffplay_dummy', 'device_backends_listed')})
        (self.root / 'tests.json').write_text(json.dumps(evidence))
        self.data = dict(schema=1, platform='windows', arch='x86_64', release_approved=True,
                         files={p.relative_to(self.root).as_posix(): module.sha256(p) for p in self.root.rglob('*') if p.is_file()},
                         license_files=['LICENSE'], corresponding_sources=['source.tar'], build_records=['build.txt'],
                         native_test_evidence='tests.json', origins=[dict(url='https://example.invalid/fixture', version='fixture-1', sha256='0'*64)])
        self.manifest = Path(self.temp.name) / 'manifest.json'

    def validate(self, **kwargs):
        self.manifest.write_text(json.dumps(self.data))
        return module.validate(self.root, self.manifest, module.sha256(self.manifest), 'windows', 'x86_64', **kwargs)

    def test_valid_contract_invokes_read_only_auditor(self):
        # Only audit tool output is mocked; synthetic binaries are never executed.
        with patch('subprocess.run') as run:
            run.return_value.stdout = 'DLL Name: KERNEL32.dll\n'
            report = self.validate()
            self.assertEqual(report['dependency_audit'], 'static-imports-passed')
            self.assertEqual(run.call_count, 2)

    def test_tampering(self):
        (self.root / 'bin/ffmpeg.exe').write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            self.validate()

    def test_unlisted_file(self):
        (self.root / 'extra.dll').write_bytes(b'unknown')
        with self.assertRaisesRegex(ValueError, 'inventory'):
            self.validate()

    def test_unapproved(self):
        self.data['release_approved'] = False
        with self.assertRaisesRegex(ValueError, 'approved'):
            self.validate()

    def test_missing_sources(self):
        self.data['corresponding_sources'] = []
        with self.assertRaisesRegex(ValueError, 'compliance'):
            self.validate()

    def test_wrong_arch(self):
        self.data['arch'] = 'aarch64'
        with self.assertRaisesRegex(ValueError, 'architecture'):
            self.validate()

    def test_pinned_manifest_required(self):
        self.manifest.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'pinned'):
            module.validate(self.root, self.manifest, '0'*64, 'windows', 'x86_64')

    def test_foreign_native_evidence(self):
        evidence = self.root / 'tests.json'
        evidence.write_text(json.dumps(dict(platform='linux', arch='x86_64')))
        self.data['files']['tests.json'] = module.sha256(evidence)
        with self.assertRaisesRegex(ValueError, 'native target'):
            self.validate()

    def test_wrong_binary_architecture(self):
        path = self.root / 'bin/ffmpeg.exe'
        raw = bytearray(path.read_bytes())
        struct.pack_into('<H', raw, 68, 0xAA64)
        path.write_bytes(raw)
        self.data['files']['bin/ffmpeg.exe'] = module.sha256(path)
        with self.assertRaisesRegex(ValueError, 'PE architecture'):
            self.validate()

    def test_symlink_rejected(self):
        path = self.root / 'link'
        try:
            path.symlink_to(self.root / 'LICENSE')
        except (OSError, NotImplementedError):
            self.skipTest('symlink unavailable')
        with self.assertRaisesRegex(ValueError, 'Symlinks'):
            self.validate()

    def test_missing_non_system_dll(self):
        with patch('subprocess.run') as run:
            run.return_value.stdout = 'DLL Name: dependency.dll\n'
            with self.assertRaisesRegex(ValueError, 'Unbundled'):
                self.validate()


if __name__ == '__main__':
    unittest.main()
