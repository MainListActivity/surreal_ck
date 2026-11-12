"""Offline checks of the preview's fail-closed and artifact boundaries."""
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]

class ApplePreviewContract(unittest.TestCase):
    def test_package_is_native_and_does_not_use_real_trust_configuration(self):
        script = (ROOT / 'scripts/native-client/package-macos-arm-preview.sh').read_text()
        self.assertIn('check-native-host.sh aarch64-apple-darwin', script)
        self.assertIn('SURREAL_UPDATE_CONFIG_JSON', script)
        self.assertIn('must not embed identity configuration', script)
        self.assertIn('lipo "$binary" -verify_arch arm64', script)
        self.assertIn('codesign --force --sign -', script)
        self.assertIn('Jiji-macos-arm64.dmg', script)
        self.assertNotIn('release upload', script)

    def test_workflow_uploads_only_test_artifacts(self):
        workflow = (ROOT / '.github/workflows/native-client-macos-arm64-preview.yml').read_text()
        self.assertIn('runs-on: macos-15', workflow)
        self.assertIn('Jiji-macos-arm64.dmg', workflow)
        self.assertIn('smoke-macos-preview.py', workflow)
        self.assertNotIn('release:', workflow)
        self.assertIn('--prerelease', workflow)
        self.assertIn('refusing to replace its assets', workflow)

if __name__ == '__main__':
    unittest.main()
