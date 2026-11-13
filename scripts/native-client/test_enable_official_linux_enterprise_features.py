#!/usr/bin/env python3
import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'enable_official_linux_enterprise_features',
    Path(__file__).with_name('enable-official-linux-enterprise-features.py'),
)
features = importlib.util.module_from_spec(spec)
spec.loader.exec_module(features)


SAMPLE = '''[dependencies]
nsh-core = { version = "=0.4.0" }
app_nsh_app_native_client = { package = "nsh-app-native-client", path = "/workspace/surreal_ck/native-client" }
'''

ALREADY = '''[dependencies]
app_nsh_app_native_client = { package = "nsh-app-native-client", path = "/tmp/app", features = ["experimental-enterprise-media", "experimental-enterprise-files"] }
'''


class OfficialLinuxEnterpriseFeaturesTests(unittest.TestCase):
    def test_injects_media_and_files_features(self):
        updated, count = features.patch_text(SAMPLE)
        self.assertEqual(count, 1)
        self.assertIn('features = ["experimental-enterprise-media", "experimental-enterprise-files"]', updated)
        self.assertIn('path = "/workspace/surreal_ck/native-client"', updated)

    def test_idempotent_when_features_already_present(self):
        updated, count = features.patch_text(ALREADY)
        self.assertEqual(count, 1)
        self.assertEqual(updated, ALREADY)

    def test_patches_generated_workspace_tomls_only(self):
        with tempfile.TemporaryDirectory() as raw:
            workspace = Path(raw)
            (workspace / 'rust-linux').mkdir()
            target = workspace / 'rust-linux' / 'Cargo.toml'
            target.write_text(SAMPLE, encoding='utf-8')
            ignored = workspace / 'README'
            ignored.write_text('app_nsh_app_native_client = { package = "nsh-app-native-client", path = "/x" }', encoding='utf-8')
            self.assertEqual(features.patch_workspace(workspace), 1)
            text = target.read_text(encoding='utf-8')
            self.assertIn('experimental-enterprise-media', text)
            self.assertIn('experimental-enterprise-files', text)
            self.assertEqual(ignored.read_text(encoding='utf-8').count('features'), 0)

    def test_package_sh_wraps_linux_nsh_and_keeps_macos_builder(self):
        shell = Path(__file__).with_name('package.sh').read_text(encoding='utf-8')
        self.assertIn('if [[ "$target" == macos ]]; then\n  python scripts/native-client/build-desktop-app.py', shell)
        self.assertIn('enable-official-linux-enterprise-features.py', shell)
        self.assertLess(shell.index('elif [[ "$target" == linux ]]'), shell.index('PATH="$wrap:$PATH" nsh'))
        self.assertIn('nsh "${args[@]}"', shell)


if __name__ == '__main__':
    unittest.main()
