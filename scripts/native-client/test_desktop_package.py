"""桌面安装器输入 fixture/接线回归；不代表 Windows/macOS 原生验收。"""
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('builder', Path(__file__).with_name('build-desktop-app.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
ROOT = Path(__file__).resolve().parents[2]


class DesktopPackageTests(unittest.TestCase):
    def event(self, root, target):
        binary = root / 'fixture'
        binary.write_bytes((b'MZ' if target == 'windows' else b'\xcf\xfa\xed\xfe') + b'fixture-only')
        return dict(reason='compiler-artifact', executable=str(binary),
            target=dict(name='surreal-collaboration', kind=['bin'], src_path=str(root / 'native-client/src/main.rs')),
            features=builder.FEATURES[target], profile=dict(test=False, opt_level='3'))

    def test_requires_updater_and_handwritten_main(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for target in builder.FEATURES:
                event = self.event(root, target)
                required = builder.FEATURES[target]
                self.assertIn(target + '-auto-update', required)
                self.assertEqual(builder.desktop.artifact([event], target, root, required), event)
                stripped = event | {'features': [f for f in required if f != target + '-auto-update']}
                with self.assertRaises(ValueError):
                    builder.desktop.artifact([stripped], target, root, required)
                generated = event | {'target': event['target'] | {'src_path': str(root / 'generated.rs')}}
                with self.assertRaises(ValueError):
                    builder.desktop.artifact([generated], target, root, required)

    def test_macos_rpath_is_applied_to_final_binary(self):
        cmd = builder.command('macos', 'aarch64-apple-darwin')
        self.assertEqual(cmd[1], 'rustc')
        self.assertEqual(cmd[-3:], ['--', '-C', 'link-arg=-Wl,-rpath,@executable_path/../Frameworks'])
        self.assertIn('macos-auto-update', cmd[cmd.index('--features') + 1])
        with self.assertRaises(ValueError): builder.command('macos', 'x86_64-unknown-linux-gnu')

    def test_macos_missing_sdk_or_existing_identity_fails_closed(self):
        with self.assertRaises(ValueError): builder.preflight('macos', {})
        builder.preflight('windows', {})

    def test_windows_exact_entry_and_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); event = self.event(root, 'windows'); out = root / 'raw'
            report = builder.stage(event, 'windows', out, {'app_id': 'top.maplayer.collaboration'}, 'x86_64-pc-windows-msvc')
            builder.seal(out)
            evidence = json.loads((root / 'desktop-package-evidence.json').read_text())
            self.assertEqual(evidence['executable'], 'SurrealCK/surreal-collaboration.exe')
            self.assertEqual(evidence['packaged_executable_sha256'], report['compiled_executable_sha256'])
            self.assertFalse(evidence['release_eligible'])
            self.assertEqual(evidence['media_runtime']['status'], 'not-bundled')
            self.assertEqual(evidence['media_runtime']['input_validation'], 'not-configured')
            self.assertEqual(evidence['runtime_validation'], 'not-run')
            with self.assertRaises(ValueError): builder.stage(event, 'windows', out, {}, '')

    def test_macos_requires_embedded_update_framework_at_seal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); out = root / 'raw'
            builder.stage(self.event(root, 'macos'), 'macos', out,
                dict(app_id='top.maplayer.collaboration', version='0.1.0', build=1), 'aarch64-apple-darwin')
            contents = out / 'SurrealCK.app/Contents'
            info = plistlib.loads((contents / 'Info.plist').read_bytes())
            self.assertEqual(info['CFBundleIdentifier'], 'top.maplayer.collaboration')
            self.assertIn('NSMicrophoneUsageDescription', info)
            with self.assertRaises(ValueError): builder.seal(out)
            info.update(SUVerifyUpdateBeforeExtraction=True, SUPublicEDKey='fixture-only')
            (contents / 'Info.plist').write_bytes(plistlib.dumps(info))
            with self.assertRaises(ValueError): builder.seal(out)
            (contents / 'Frameworks/Sparkle.framework').mkdir(parents=True)
            builder.seal(out)

    def test_installers_route_to_explicit_builder_before_signing(self):
        windows = (ROOT / 'scripts/native-client/package-windows.ps1').read_text(encoding='utf-8')
        shell = (ROOT / 'scripts/native-client/package.sh').read_text(encoding='utf-8')
        self.assertNotIn('& nsh package', windows)
        self.assertIn('$exe = Get-Item "$out/raw/SurrealCK/surreal-collaboration.exe"', windows)
        self.assertLess(windows.index('build-desktop-app.py'), windows.index('Sign-File $exe.FullName'))
        self.assertIn('if [[ "$target" == macos ]]; then\n  python scripts/native-client/build-desktop-app.py', shell)
        self.assertIn('bash native-updater-platform/macos/embed-framework.sh "$app"', shell)
        self.assertIn('--seal', windows)
        self.assertIn('--seal', shell)


if __name__ == '__main__': unittest.main()
