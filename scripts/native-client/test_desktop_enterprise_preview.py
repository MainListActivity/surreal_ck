"""仅 fixture 结构/身份测试，不执行 Cargo 或声称原生加载成功。"""
import importlib.util
import pathlib
import plistlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('preview', pathlib.Path(__file__).with_name('desktop-enterprise-preview.py'))
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


class PreviewTests(unittest.TestCase):
    def event(self, root, target):
        binary = root / 'fixture-bin'
        binary.write_bytes((b'MZ' if target == 'windows' else b'\xcf\xfa\xed\xfe') + b'not-a-real-binary')
        return dict(reason='compiler-artifact', executable=str(binary),
                    target=dict(name='surreal-collaboration', kind=['bin'], src_path=str(root / 'native-client/src/main.rs')),
                    features=preview.FEATURES[target], profile=dict(test=False, opt_level='3'))

    def config(self):
        return {'SURREAL_CK_' + k: v for k, v in dict(
            OIDC_ISSUER='https://id.example/tenant', API_BASE_URL='https://api.example',
            OIDC_CLIENT_ID='native-public', OIDC_AUDIENCE='enterprise',
            NATIVE_REDIRECT_URI='http://127.0.0.1:3456/callback',
            OIDC_TOKEN_MODE='public-pkce-discovery', OIDC_ALLOWED_HOSTS='id.example',
            SURREAL_URL='wss://db.example/rpc').items()}

    def test_identity_hash_and_secret_exclusion(self):
        c = self.config(); result = preview.identity_inputs(c)
        self.assertEqual(result['state'], 'configured-unverified')
        self.assertNotIn('https://', str(result))
        self.assertNotEqual(result, preview.identity_inputs(c | {'SURREAL_CK_OIDC_CLIENT_ID': 'other'}))
        class NoSecrets(dict):
            def get(self, key):
                if key not in preview.PUBLIC_KEYS: raise AssertionError('read outside whitelist')
                return super().get(key)
        self.assertEqual(result, preview.identity_inputs(NoSecrets(c | {'CLIENT_SECRET': 'not-read'})))
        self.assertEqual(preview.identity_inputs({})['state'], 'absent-blocked')

    def test_identity_rejects_invalid_config_without_values_in_error(self):
        for key, value in [('OIDC_ISSUER', 'https://user:private@id.example'),
                           ('API_BASE_URL', 'https://api.example?secret=private'),
                           ('NATIVE_REDIRECT_URI', 'http://localhost:3456/cb'),
                           ('OIDC_TOKEN_MODE', 'implicit'), ('OIDC_ALLOWED_HOSTS', '*.example'),
                           ('OIDC_ALLOWED_HOSTS', 'other.example'),
                           ('SURREAL_URL', 'wss://db.example/rpc#private'),
                           ('SURREAL_NS', 'bad-name')]:
            with self.subTest(key=key):
                with self.assertRaises(ValueError) as error:
                    preview.identity_inputs(self.config() | {'SURREAL_CK_' + key: value})
                self.assertNotIn(value, str(error.exception))
        with self.assertRaises(ValueError): preview.identity_inputs({'SURREAL_CK_OIDC_CLIENT_ID': 'only-one'})

    def test_platform_callback_contract(self):
        android = self.config() | {'SURREAL_CK_NATIVE_REDIRECT_URI': 'top.maplayer.collaboration:/auth/callback'}
        self.assertEqual(preview.identity_inputs(android, 'android')['state'], 'configured-unverified')
        for platform in ('macos', 'windows', 'linux'):
            preview.identity_inputs(self.config(), platform)
            with self.assertRaises(ValueError): preview.identity_inputs(android, platform)
        for uri in ('top.maplayer.collaboration://auth/callback',
                    'top.maplayer.collaboration:/auth/callback/extra',
                    'top.maplayer.collaboration:opaque',
                    'http://127.0.0.1:3456/callback',
                    'top.maplayer.collaboration:/auth/callback?secret=value'):
            with self.assertRaises(ValueError):
                preview.identity_inputs(android | {'SURREAL_CK_NATIVE_REDIRECT_URI': uri}, 'android')

    def test_commands_and_native_host_guard(self):
        for target, host in [('macos', 'aarch64-apple-darwin'), ('windows', 'x86_64-pc-windows-msvc')]:
            cmd = preview.command(target, host)
            self.assertIn('--locked', cmd)
            self.assertIn('--release', cmd)
            self.assertIn('experimental-enterprise-files', cmd[cmd.index('--features') + 1])
        with self.assertRaises(ValueError): preview.command('macos', 'x86_64-unknown-linux-gnu')

    def test_staging_and_hash_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            for target in preview.FEATURES:
                event = self.event(root, target)
                self.assertEqual(preview.artifact([event], target, root), event)
                out = root / target
                report = preview.stage(event, target, out, dict(version='0.1.0', build=1, update_config='absent-blocked'), next(iter(preview.HOSTS[target])))
                self.assertEqual(report['executable_sha256'], preview.receipt.digest(out / report['executable']))
                self.assertFalse(report['release_eligible'])
                self.assertEqual(report['update_config'], 'absent-blocked')
                if target == 'macos':
                    info = plistlib.loads(next(out.rglob('Info.plist')).read_bytes())
                    self.assertEqual(info['CFBundleExecutable'], 'surreal-collaboration')
                    self.assertEqual(info['CFBundleDisplayName'], '吉吉')
                    self.assertEqual(info['CFBundleIconFile'], 'AppIcon.icns')
                    self.assertEqual((out / '吉吉.app/Contents/Resources/AppIcon.icns').read_bytes(), pathlib.Path('assets/icon.icns').read_bytes())
                with self.assertRaises(ValueError): preview.stage(event, target, out, {}, '')

    def test_reject_missing_features_wrong_main_and_duplicate(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp); event = self.event(root, 'windows')
            with self.assertRaises(ValueError): preview.artifact([event, event], 'windows', root)
            with self.assertRaises(ValueError): preview.artifact([event | {'features': ['desktop']}], 'windows', root)
            wrong = event | {'target': event['target'] | {'src_path': str(root / 'generated.rs')}}
            with self.assertRaises(ValueError): preview.artifact([wrong], 'windows', root)
            with self.assertRaises(ValueError): preview.artifact([event | {'profile': {'test': True}}], 'windows', root)

    def test_reject_wrong_binary_format(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp); event = self.event(root, 'windows')
            pathlib.Path(event['executable']).write_bytes(b'ELF-not-PE')
            with self.assertRaises(ValueError): preview.stage(event, 'windows', root / 'out', {}, '')
            self.assertFalse((root / 'out').exists())

    def test_windows_staging_uses_utf8_in_non_utf8_locale(self):
        original = pathlib.Path.write_text
        encodings = []
        def legacy_locale_write(path, data, encoding=None, errors=None, newline=None):
            encodings.append(encoding)
            return original(path, data, encoding=encoding or 'cp1252', errors=errors, newline=newline)
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            event = self.event(root, 'windows')
            out = root / 'preview'
            with patch.object(pathlib.Path, 'write_text', legacy_locale_write):
                preview.stage(event, 'windows', out, dict(version='0.1.0', build=1), 'x86_64-pc-windows-msvc')
            self.assertEqual(encodings, ['utf-8', 'utf-8'])
            self.assertIn('仅企业实验', (out / 'TEST-ONLY.txt').read_text(encoding='utf-8'))


if __name__ == '__main__': unittest.main()
