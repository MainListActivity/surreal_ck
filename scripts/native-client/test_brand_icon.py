"""App 图标品牌一致性：只来自 Logo.svelte，预览与正式打包共用，拒绝旧 assets/icon.icns。"""
import importlib.util
import json
from pathlib import Path
import plistlib
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


brand = load('brand_icon', ROOT / 'native-client/scripts/brand_icon.py')
preview = load('preview', ROOT / 'scripts/native-client/desktop-enterprise-preview.py')
builder = load('builder', ROOT / 'scripts/native-client/build-desktop-app.py')


def fixture_root(tmp):
    """复制图标源/产物到临时仓库根，便于注入篡改而不改动真实文件。"""
    root = Path(tmp) / 'repo'
    for rel in ('web/src/components/Logo.svelte', 'native-client/assets/brand.svg',
                'native-client/assets/app-icon/AppIcon.svg', 'native-client/assets/app-icon/AppIcon.icns',
                'native-client/assets/app-icon/app-icon.lock.json', 'assets/icon.icns'):
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / rel, root / rel)
    return root


class BrandIconTests(unittest.TestCase):
    def test_committed_assets_match_logo_svelte(self):
        evidence = brand.verify()
        source = (ROOT / 'web/src/components/Logo.svelte').read_text(encoding='utf-8')
        self.assertEqual((ROOT / 'native-client/assets/brand.svg').read_text(encoding='utf-8'), brand.brand_svg(source))
        svg = (ROOT / 'native-client/assets/app-icon/AppIcon.svg').read_text(encoding='utf-8')
        for d in brand.logo_paths(source):
            self.assertIn(f'd="{d}"', svg)
        self.assertIn('fill="#161513"', svg)
        self.assertIn('translate(100 100) scale(12.875)', svg)
        self.assertNotEqual(evidence['icns_sha256'], brand.sha256((ROOT / 'assets/icon.icns').read_bytes()))

    def test_icns_structure_and_sizes(self):
        data = (ROOT / 'native-client/assets/app-icon/AppIcon.icns').read_bytes()
        entries = brand.check_icns(data)
        self.assertEqual(entries['ic10']['size'], 1024)
        self.assertEqual(entries['icp4']['size'], 16)
        rebuilt = brand.build_icns(brand.parse_icns(data))
        self.assertEqual(rebuilt, data)
        with self.assertRaises(brand.IconError):
            brand.check_icns(data[:-10])
        with self.assertRaises(brand.IconError):
            brand.check_icns((ROOT / 'assets/icon.icns').read_bytes())

    def test_install_rejects_legacy_fallback_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / 'AppIcon.icns'
            with self.assertRaises(brand.IconError):
                brand.install_app_icon(dest, source=ROOT / 'assets/icon.icns')
            self.assertFalse(dest.exists())
            evidence = brand.install_app_icon(dest)
            self.assertEqual(brand.sha256(dest.read_bytes()), evidence['icns_sha256'])

    def test_verify_rejects_tampered_or_legacy_resources(self):
        cases = {
            'legacy icns swapped in': lambda r: shutil.copyfile(r / 'assets/icon.icns', r / 'native-client/assets/app-icon/AppIcon.icns'),
            'icns bytes changed': lambda r: (r / 'native-client/assets/app-icon/AppIcon.icns').write_bytes(
                (r / 'native-client/assets/app-icon/AppIcon.icns').read_bytes()[:-1] + b'\0'),
            'logo geometry changed': lambda r: (r / 'web/src/components/Logo.svelte').write_text(
                (r / 'web/src/components/Logo.svelte').read_text(encoding='utf-8').replace('M20.5 57', 'M21.5 57', 1), encoding='utf-8'),
            'app icon svg edited': lambda r: (r / 'native-client/assets/app-icon/AppIcon.svg').write_text(
                (r / 'native-client/assets/app-icon/AppIcon.svg').read_text(encoding='utf-8').replace('#161513', '#000000', 1), encoding='utf-8'),
            'lock missing': lambda r: (r / 'native-client/assets/app-icon/app-icon.lock.json').unlink(),
        }
        for name, tamper in cases.items():
            with self.subTest(name), tempfile.TemporaryDirectory() as tmp:
                root = fixture_root(tmp)
                brand.verify(root)
                tamper(root)
                with self.assertRaises(brand.IconError):
                    brand.install_app_icon(Path(tmp) / 'out/AppIcon.icns', root=root)
                self.assertFalse((Path(tmp) / 'out/AppIcon.icns').exists())

    def test_installed_resource_check_detects_wrong_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / 'AppIcon.icns'
            evidence = brand.install_app_icon(dest)
            shutil.copyfile(ROOT / 'assets/icon.icns', dest)
            with self.assertRaises(brand.IconError):
                brand.check_installed(dest, evidence)

    def event(self, root, target, features):
        binary = root / f'{target}-bin'
        binary.write_bytes(b'\xcf\xfa\xed\xfe' + b'fixture-only')
        return dict(reason='compiler-artifact', executable=str(binary),
            target=dict(name='surreal-collaboration', kind=['bin'], src_path=str(root / 'native-client/src/main.rs')),
            features=features, profile=dict(test=False, opt_level='3'))

    def test_preview_and_official_packagers_share_icon(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snap = dict(app_id='top.maplayer.collaboration', version='0.1.0', build=1)
            preview_report = preview.stage(self.event(root, 'p', preview.FEATURES['macos']), 'macos', root / 'preview', snap, 'aarch64-apple-darwin')
            official_report = builder.stage(self.event(root, 'o', builder.FEATURES['macos']), 'macos', root / 'official', snap, 'aarch64-apple-darwin')
            a = (root / 'preview/吉吉.app/Contents/Resources/AppIcon.icns').read_bytes()
            b = (root / 'official/吉吉.app/Contents/Resources/AppIcon.icns').read_bytes()
            self.assertEqual(a, b)
            self.assertEqual(preview_report['app_icon'], official_report['app_icon'])
            lock = json.loads((ROOT / 'native-client/assets/app-icon/app-icon.lock.json').read_text(encoding='utf-8'))
            self.assertEqual(brand.sha256(a), lock['icns_sha256'])
            # 正式包 seal 阶段再次检查包内资源；被替换成旧图标即失败。
            contents = root / 'official/吉吉.app/Contents'
            info = plistlib.loads((contents / 'Info.plist').read_bytes())
            info.update(SUVerifyUpdateBeforeExtraction=True, SUPublicEDKey='fixture-only')
            (contents / 'Info.plist').write_bytes(plistlib.dumps(info))
            (contents / 'Frameworks/Sparkle.framework').mkdir(parents=True)
            shutil.copyfile(ROOT / 'assets/icon.icns', contents / 'Resources/AppIcon.icns')
            with self.assertRaises(ValueError):
                builder.seal(root / 'official')
            shutil.copyfile(ROOT / 'native-client/assets/app-icon/AppIcon.icns', contents / 'Resources/AppIcon.icns')
            builder.seal(root / 'official')

    def test_packagers_no_longer_reference_legacy_icon(self):
        for rel in ('scripts/native-client/desktop-enterprise-preview.py', 'scripts/native-client/build-desktop-app.py'):
            text = (ROOT / rel).read_text(encoding='utf-8')
            self.assertNotIn("'assets/icon.icns'", text)
            self.assertIn('install_app_icon', text)
        script = (ROOT / 'scripts/native-client/package-macos-arm-preview.sh').read_text(encoding='utf-8')
        self.assertIn('brand_icon.py verify-bundle "$app"', script)

    def test_preview_stage_fails_before_output_when_icon_invalid(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            original = preview.brand_icon.verify
            def broken(root=None):
                raise brand.IconError('fixture')
            preview.brand_icon.verify = broken
            try:
                with self.assertRaises(ValueError):
                    preview.stage(self.event(root, 'p', preview.FEATURES['macos']), 'macos', root / 'out',
                                  dict(version='0.1.0', build=1), 'aarch64-apple-darwin')
            finally:
                preview.brand_icon.verify = original
            self.assertFalse((root / 'out').exists())


if __name__ == '__main__':
    unittest.main()
