"""Offline release-asset contract tests. No actual installer/signing claim."""
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name('collect.py').resolve()

class CollectTests(unittest.TestCase):
    def test_all_platforms(self):
        for target, suffix in [('linux', '.tar.gz'), ('macos', '.dmg'), ('windows', '.exe'), ('android', '.apk')]:
            with self.subTest(target=target), tempfile.TemporaryDirectory() as tmp:
                root = pathlib.Path(tmp)
                (root / 'native-client').mkdir()
                (root / 'native-client/nsh.json').write_text(json.dumps({'version': '0.1.0'}))
                source = root / 'dist/native-client' / target
                source.mkdir(parents=True)
                name = 'SurrealCK-test' + suffix
                (source / name).write_bytes(b'mock artifact')
                (source / 'build-receipt.json').write_text(json.dumps(dict(host_arch='aarch64' if target=='macos' else 'x86_64', platform=target, filename=name, size=len(b'mock artifact'), sha256=hashlib.sha256(b'mock artifact').hexdigest(), version='0.1.0', update_config='absent-blocked')))
                (source / 'signing-status.txt').write_text('signing=unsigned\n')
                if target == 'android':
                    (source / 'apk-verification.txt').write_text('mock only')
                    (source / name).with_suffix('.verification.json').write_text(json.dumps({'apk_sha256': hashlib.sha256(b'mock artifact').hexdigest(), 'requested_host_mode': 'collaboration', 'runtime_validation': 'not-run'}), encoding='utf-8')
                if target in ('windows', 'macos'):
                    (source / 'desktop-package-evidence.json').write_text(json.dumps({'platform': target, 'entrypoint': 'native-client/src/main.rs', 'runtime_validation': 'not-run'}), encoding='utf-8')
                # A later source version must never relabel an existing artifact.
                (root / 'native-client/nsh.json').write_text(json.dumps({'version': '9.9.9'}))
                subprocess.run([sys.executable, str(SCRIPT), target, 'test'], cwd=root, check=True)
                release = root / 'dist/release'
                self.assertEqual((release / name).read_bytes(), b'mock artifact')
                manifest = (release / f'{target}-test-SHA256SUMS.txt').read_text()
                self.assertIn(hashlib.sha256(b'mock artifact').hexdigest() + '  ' + name, manifest)
                if target in ('windows', 'macos', 'android'):
                    evidence = release / f'{target}-test-package-evidence.json'
                    self.assertEqual(json.loads(evidence.read_text())['runtime_validation'], 'not-run')
                    self.assertIn(hashlib.sha256(evidence.read_bytes()).hexdigest() + '  ' + evidence.name, manifest)
                self.assertEqual(len(list(release.glob('*signing-status.txt'))), 1)
                index = json.loads((release / f'{target}-test-assets.json').read_text())
                self.assertEqual(len(index), 2 if target == 'android' else 1)
                self.assertEqual(index[0]['version'], '0.1.0')
                if target=='macos': self.assertEqual(index[0]['arch'],'aarch64')
                self.assertEqual(index[0]['size'], len(b'mock artifact'))
                self.assertEqual(index[0]['sha256'], hashlib.sha256(b'mock artifact').hexdigest())

    def test_rejects_tampered_artifact(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = pathlib.Path(tmp) / 'dist/native-client/android'
            source.mkdir(parents=True)
            (source / 'SurrealCK-test.apk').write_bytes(b'tampered')
            (source / 'build-receipt.json').write_text(json.dumps(dict(platform='android', filename='SurrealCK-test.apk', size=8, sha256='0'*64)))
            result = subprocess.run([sys.executable, str(SCRIPT), 'android', 'test'], cwd=tmp, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'does not match', result.stderr)

    def test_rejects_missing_or_ambiguous_installers(self):
        for count in [0, 2]:
            with self.subTest(count=count), tempfile.TemporaryDirectory() as tmp:
                source = pathlib.Path(tmp) / 'dist/native-client/android'
                source.mkdir(parents=True)
                for i in range(count):
                    (source / f'SurrealCK-{i}.apk').write_bytes(b'mock')
                result = subprocess.run([sys.executable, str(SCRIPT), 'android', 'test'], cwd=tmp, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b'Expected exactly one', result.stderr)

if __name__ == '__main__':
    unittest.main()
