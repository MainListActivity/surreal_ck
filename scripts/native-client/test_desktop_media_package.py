"""真实校验/复制合约，只有平台 inspection-tool 输出使用 fixture；不运行媒体设备。"""
import importlib.util
import json
import os
from pathlib import Path
import struct
import unittest
from unittest.mock import patch

import test_media_runtime as runtime_tests

spec = importlib.util.spec_from_file_location('desktop_media_builder', Path(__file__).with_name('build-desktop-app.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class DesktopMediaPackageTests(unittest.TestCase):
    setUp = runtime_tests.RuntimeContractTests.setUp

    def stage(self, platform='windows'):
        arch = 'x86_64' if platform == 'windows' else 'aarch64'
        if platform == 'macos':
            self.data.update(platform=platform, arch=arch)
            for name in ('ffmpeg', 'ffplay'):
                (self.root / 'bin' / (name + '.exe')).unlink()
                file = self.root / 'bin' / name
                file.write_bytes(b'\xcf\xfa\xed\xfe' + struct.pack('<I', 0x0100000C) + b'fixture-only')
                file.chmod(0o755)
            evidence = self.root / 'tests.json'
            value = json.loads(evidence.read_text(encoding='utf-8'))
            value.update(platform=platform, arch=arch)
            evidence.write_text(json.dumps(value), encoding='utf-8')
            self.data['files'] = builder.runtime_inventory(self.root)
        self.manifest.write_text(json.dumps(self.data), encoding='utf-8')
        config = dict(source=self.root, manifest=self.manifest, expected_hash=builder.media.sha256(self.manifest))
        app = Path(self.temp.name) / 'app-fixture'
        app.write_bytes(b'MZ' if platform == 'windows' else b'\xcf\xfa\xed\xfe')
        out = Path(self.temp.name) / 'raw'
        with patch('subprocess.run') as inspect:
            inspect.return_value.stdout = ('DLL Name: KERNEL32.dll\n' if platform == 'windows' else
                                          'fixture:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1)\n')
            report = builder.stage(dict(executable=str(app), features=builder.FEATURES[platform]),
                platform, out, dict(app_id='fixture.test', version='0.1.0', build=1),
                arch + ('-pc-windows-msvc' if platform == 'windows' else '-apple-darwin'), config)
        return out, report

    def test_windows_stage_and_seal_media(self):
        out, report = self.stage()
        runtime = report['media_runtime']
        self.assertEqual(runtime['path'], 'SurrealCK/media-runtime')
        self.assertEqual(runtime['copy_validation'], 'passed')
        self.assertEqual(runtime['files'], self.data['files'])
        builder.seal(out)
        sealed = json.loads((out.parent / 'desktop-package-evidence.json').read_text(encoding='utf-8'))
        self.assertEqual(sealed['media_runtime']['sealed_inventory_validation'], 'passed')
        self.assertFalse(sealed['release_eligible'])
        self.assertEqual(sealed['runtime_validation'], 'not-run')

    @unittest.skipIf(os.name == 'nt', 'Mach-O fixture needs POSIX executable mode bits; real validation is unchanged')
    def test_macos_resolver_layout(self):
        out, report = self.stage('macos')
        self.assertEqual(report['media_runtime']['path'], 'SurrealCK.app/Contents/Resources/media-runtime')
        self.assertTrue((out / report['media_runtime']['path'] / 'bin/ffplay').is_file())
        self.assertEqual(report['media_runtime']['arch'], 'aarch64')

    def test_seal_rejects_changed_media(self):
        out, report = self.stage()
        (out / report['media_runtime']['path'] / 'bin/ffmpeg.exe').write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, '改变'):
            builder.seal(out)
        self.assertFalse((out.parent / 'desktop-package-evidence.json').exists())

    def test_invalid_input_creates_no_stage(self):
        self.data['release_approved'] = False
        with self.assertRaisesRegex(ValueError, 'approved'):
            self.stage()
        self.assertFalse((Path(self.temp.name) / 'raw').exists())

    def test_copy_change_rejected_without_success_evidence(self):
        original = builder.shutil.copytree
        def altered(source, destination, *args, **kwargs):
            result = original(source, destination, *args, **kwargs)
            if Path(source) == self.root:
                (Path(destination) / 'bin/ffmpeg.exe').write_bytes(b'changed during copy')
            return result
        with patch.object(builder.shutil, 'copytree', side_effect=altered):
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                self.stage()
        out = Path(self.temp.name) / 'raw'
        self.assertFalse((out / 'desktop-build.json').exists())
        self.assertFalse((out / 'SurrealCK/media-runtime').exists())

    def test_config_rejects_source_root_symlink(self):
        link = Path(self.temp.name) / 'linked-runtime'
        try:
            link.symlink_to(self.root, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest('directory symlink unavailable')
        with self.assertRaisesRegex(ValueError, 'runtime input roots'):
            builder.media_config(dict(SURREAL_MEDIA_RUNTIME_SOURCE=str(link),
                SURREAL_MEDIA_RUNTIME_MANIFEST=str(self.manifest),
                SURREAL_MEDIA_RUNTIME_MANIFEST_SHA256='0'*64))

    def test_config_is_all_or_none(self):
        self.assertIsNone(builder.media_config({}))
        names = ('SURREAL_MEDIA_RUNTIME_SOURCE', 'SURREAL_MEDIA_RUNTIME_MANIFEST', 'SURREAL_MEDIA_RUNTIME_MANIFEST_SHA256')
        for name in names:
            with self.assertRaises(ValueError):
                builder.media_config({name: 'x'})
        with self.assertRaises(ValueError):
            builder.media_config(dict(zip(names, ['relative', '/absolute', '0'*64])))
        config = builder.media_config(dict(zip(names, [str(self.root), str(self.manifest), '0'*64])))
        self.assertEqual(config['source'], self.root)


if __name__ == '__main__':
    unittest.main()
