"""公开配置预检负例；不访问网络、不读凭据。"""
import importlib.util
import pathlib
import unittest
from unittest.mock import patch
import test_desktop_enterprise_preview as fixtures

spec = importlib.util.spec_from_file_location('preflight', pathlib.Path(__file__).with_name('check-public-inputs.py'))
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class PublicInputsTests(unittest.TestCase):
    def test_build_entrypoints_check_before_build(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        scripts = root / 'scripts/native-client'
        for file, invocation, build in (
            ('package.sh', 'check-public-inputs.py --platform "$target"', 'build-receipt.py begin'),
            ('build-android-host.sh', 'check-public-inputs.py" --platform android', 'cargo build')):
            source = (scripts / file).read_text(encoding='utf-8')
            self.assertLess(source.index(invocation), source.index(build))
        desktop = (scripts / 'build-desktop-app.py').read_text(encoding='utf-8')
        self.assertEqual(desktop.count('desktop.identity_inputs(os.environ, args.platform)'), 2)
        self.assertIn('python scripts/native-client/test_public_inputs.py',
                      (root / '.github/workflows/native-client-release.yml').read_text(encoding='utf-8'))

    def test_source_reads_with_non_utf8_platform_default(self):
        original = pathlib.Path.read_text
        encodings = []

        def windows_read_text(path, encoding=None, errors=None):
            encodings.append(encoding)
            return original(path, encoding=encoding or 'cp1252', errors=errors)

        with patch.object(pathlib.Path, 'read_text', windows_read_text):
            self.test_build_entrypoints_check_before_build()
        self.assertEqual(encodings, ['utf-8'] * 4)

    def test_missing_is_explicitly_blocked(self):
        report = preflight.check({}, 'android')
        self.assertEqual(report['update_config'], 'absent-blocked')
        self.assertFalse(report['registration_verified'])
        self.assertFalse(report['policy_verified'])
        with self.assertRaises(ValueError): preflight.check({}, 'android', True)

    def test_strict_requires_update_and_identity(self):
        with self.assertRaises(ValueError):
            preflight.check(fixtures.PreviewTests().config(), 'windows', True)
        with self.assertRaises(ValueError):
            preflight.check({'SURREAL_UPDATE_CONFIG_JSON': '{}'}, 'windows')

    def test_only_allowlisted_environment_fields_read(self):
        class PublicOnly(dict):
            def get(self, key, default=None):
                if key not in (*preflight.preview.PUBLIC_KEYS, 'SURREAL_UPDATE_CONFIG_JSON'):
                    raise AssertionError('读取非公开配置')
                return super().get(key, default)
        report = preflight.check(PublicOnly(fixtures.PreviewTests().config()), 'windows')
        self.assertNotIn('native-public', str(report))
        self.assertEqual(report['identity_inputs']['state'], 'configured-unverified')


if __name__ == '__main__':
    unittest.main()
