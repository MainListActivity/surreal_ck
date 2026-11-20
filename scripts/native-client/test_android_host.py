import sys
sys.dont_write_bytecode = True
import importlib.util
from pathlib import Path
import tempfile
import os
import subprocess
import unittest
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('android_host', Path(__file__).with_name('package-android-host.py'))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)

class HostTests(unittest.TestCase):
    def test_resource_symbols_and_flags(self):
        symbols, attrs = host.resource_symbols('''Package name=android id=01
    resource 0x01030241 style/Theme.Material.Light.NoActionBar PUBLIC
    resource 0x0101001f attr/windowSoftInputMode PUBLIC
      () (attr) type=flags size=3
        adjustResize(0x01020001)=0x00000010
        stateHidden(0x01020002)=0x00000002
        adjustPan(0x01020003)=0x00000020
''')
        root=host.normalize_manifest('<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:theme="@ref/0x1030241"><activity android:windowSoftInputMode="0x12" /></application></manifest>',symbols,attrs)
        self.assertEqual(root.find('application').get(host.A+'theme'),'@android:style/Theme.Material.Light.NoActionBar')
        self.assertEqual(root.find('application/activity').get(host.A+'windowSoftInputMode'),'adjustResize|stateHidden')
        with self.assertRaises(ValueError): host.decode_flags(64,'flags',{'one':1})
        with self.assertRaises(ValueError): host.decode_flags(3,'enum',{'one':1})

    def test_unknown_resource_fails_closed(self):
        with self.assertRaises(ValueError): host.normalize_manifest('<manifest icon="@ref/0x12345678"/>',{}, {})

    def test_fragment_preserves_original_and_resolves_authority(self):
        root=ET.fromstring('<manifest package="top.maplayer.collaboration"><application><activity name="original" /></application></manifest>')
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'fragment.xml'
            path.write_text('<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><provider android:name="Test" android:authorities="${applicationId}.init" android:exported="false" /></application></manifest>')
            host.merge_fragment(root,path)
            self.assertEqual(root.find('application/activity').get('name'),'original')
            self.assertEqual(root.find('application/provider').get(host.A+'authorities'),'top.maplayer.collaboration.init')
            with self.assertRaises(ValueError): host.merge_fragment(root,path)

    def test_exported_component_and_application_override_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'fragment.xml'
            for content in ['<application android:name="Other" />','<application><receiver android:name="Test" android:exported="true" /></application>']:
                path.write_text('<manifest xmlns:android="http://schemas.android.com/apk/res/android">'+content+'</manifest>')
                with self.assertRaises(ValueError): host.merge_fragment(ET.fromstring('<manifest package="a"><application /></manifest>'),path)

    def test_media_manifest_requires_actual_jni_exports(self):
        root=Path(__file__).resolve().parents[2]
        required=host.required_jni_symbols([root/'native-media-platform/android/media-manifest.xml'])
        self.assertIn('Java_top_maplayer_collaboration_media_MediaBridge_nativeClosed',required)
        self.assertIn('Java_top_maplayer_collaboration_media_MediaBridge_nativeError',required)
        exported='\n'.join('1: 123 3 FUNC GLOBAL DEFAULT 12 '+name for name in required)
        host.verify_jni_exports(exported,required,'test')
        with self.assertRaises(ValueError):host.verify_jni_exports(exported.replace('MediaBridge_nativeClosed','MediaBridge_nativeClosed_wrong'),required,'test')
        with self.assertRaises(ValueError):host.verify_jni_exports(exported.replace('DEFAULT 12','DEFAULT UND'),required,'test')

    def test_standard_host_requires_updater_and_rejects_experimental_components(self):
        repo = Path(__file__).resolve().parents[2]
        root = ET.fromstring('<manifest package="top.maplayer.collaboration"><application /></manifest>')
        for fragment in ('native-updater-platform/android/manifest-fragment.xml',
                         'native-media-platform/android/documents-manifest.xml'):
            host.merge_fragment(root, repo / fragment)
        host.verify_updater_host(root, False)
        with self.assertRaises(ValueError): host.verify_updater_host(root, True)
        for name in ('MediaInitProvider', 'AuthInitProvider'):
            element = ET.SubElement(root.find('application'), 'provider', {
                host.A+'name': 'top.maplayer.collaboration.media.'+name,
                host.A+'exported': 'false'})
            with self.assertRaises(ValueError): host.verify_updater_host(root, False)
            root.find('application').remove(element)
        root.find('application').remove(root.find('application/receiver'))
        with self.assertRaises(ValueError): host.verify_updater_host(root, False)

    @unittest.skipIf(sys.platform == 'win32', 'Android package.sh is executed on POSIX build hosts only')
    def test_standard_package_routes_through_updater_with_same_signing_identity(self):
        script = Path(__file__).with_name('package.sh').resolve()
        for release in (False, True):
            with self.subTest(release=release), tempfile.TemporaryDirectory() as folder:
                work = Path(folder)
                tools = work/'sdk/build-tools/35.0.1'
                tools.mkdir(parents=True)
                for tool in ('apksigner', 'zipalign'):
                    file = tools/tool
                    file.write_text('#!/bin/sh\nexit 0\n')
                    file.chmod(0o755)
                env = os.environ | {'ANDROID_HOME': str(work/'sdk'),
                    'HOME': str(work), 'CALL_LOG': str(work/'calls'), 'SCRIPT': str(script)}
                for name in ('ANDROID_KEYSTORE_PATH', 'ANDROID_KEY_ALIAS', 'NSH_KEYSTORE_PASSWORD'):
                    env.pop(name, None)
                if release:
                    env.update(ANDROID_KEYSTORE_PATH=str(work/'existing.keystore'),
                               ANDROID_KEY_ALIAS='existing-alias', NSH_KEYSTORE_PASSWORD='test-placeholder')
                commands = r"""
python() { printf '%s\n' "$*" >> "$CALL_LOG"; }
nsh() { mkdir -p dist/native-client/android/raw; touch dist/native-client/android/raw/base.apk; }
bash() { printf 'host %s media=%s oauth=%s enterprise=%s\n' "$*" "$ANDROID_NATIVE_MEDIA" "$ANDROID_NATIVE_OAUTH" "$ANDROID_ENTERPRISE_COLLABORATION" >> "$CALL_LOG"; }
export -f python nsh bash
/bin/bash "$SCRIPT" android
"""
                result = subprocess.run(['/bin/bash', '-c', commands], cwd=work,
                                        env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                calls = (work/'calls').read_text()
                self.assertIn('--enable-collaboration-host --enable-experimental-oauth', calls)
                self.assertIn('native-media-platform/android/media-manifest.xml', calls)
                self.assertIn('native-media-platform/android/auth-manifest.xml', calls)
                self.assertIn('media=1 oauth=1 enterprise=1', calls)
                self.assertIn('native-updater-platform/android/manifest-fragment.xml', calls)
                self.assertIn('--native-lib arm64-v8a=', calls)
                self.assertIn('--native-lib x86_64=', calls)
                if release:
                    self.assertIn('--key-alias existing-alias', calls)
                    self.assertIn('--keystore-existing '+str(work/'existing.keystore'), calls)
                    self.assertNotIn('--test-signing', calls)
                else:
                    self.assertIn('--keystore-existing '+str(work/'.android/debug.keystore'), calls)
                    self.assertIn('--key-alias androiddebugkey --test-signing', calls)

    def test_actual_signer_fingerprints_are_required(self):
        value = 'a' * 64
        self.assertEqual(host.signer_certificates('Signer #1 certificate SHA-256 digest: '+value), {value})
        with self.assertRaises(ValueError): host.signer_certificates('Verifies')
        with self.assertRaises(ValueError): host.signer_certificates('Signer #1 certificate SHA-256 digest: invalid')

    def test_collaboration_host_requires_all_bridges_and_audited_oauth(self):
        repo = Path(__file__).resolve().parents[2]
        root = ET.fromstring('<manifest package="top.maplayer.collaboration"><application /></manifest>')
        for fragment in ('native-updater-platform/android/manifest-fragment.xml',
                         'native-media-platform/android/documents-manifest.xml',
                         'native-media-platform/android/media-manifest.xml',
                         'native-media-platform/android/auth-manifest.xml'):
            host.merge_fragment(root, repo / fragment, True)
        host.verify_updater_host(root, True, True)
        with self.assertRaises(ValueError): host.verify_updater_host(root, False, True)
        application = root.find('application')
        for component in list(application):
            application.remove(component)
            with self.assertRaises(ValueError): host.verify_updater_host(root, True, True)
            application.append(component)
        root.find('application/service').set(host.A+'exported', 'true')
        with self.assertRaises(ValueError): host.verify_updater_host(root, True, True)

    def auth_root(self):
        root = ET.fromstring('<manifest package="top.maplayer.collaboration"><application /></manifest>')
        fragment = Path(__file__).resolve().parents[2] / 'native-media-platform/android/auth-manifest.xml'
        host.merge_fragment(root, fragment, True)
        return root, fragment

    def test_oauth_is_opt_in_and_requires_complete_manifest(self):
        root, fragment = self.auth_root()
        host.verify_auth_manifest(root, True)
        with self.assertRaises(ValueError): host.verify_auth_manifest(root, False)
        with self.assertRaises(ValueError): host.merge_fragment(ET.fromstring('<manifest package="a"><application /></manifest>'), fragment)
        root.find('application').remove(root.find('application/provider'))
        with self.assertRaises(ValueError): host.verify_auth_manifest(root, True)
        with self.assertRaises(ValueError): host.verify_auth_manifest(ET.fromstring('<manifest><application /></manifest>'), True)

    def test_oauth_rejects_exported_provider_and_broadened_filter(self):
        for change in ('provider', 'scheme', 'extra_action', 'extra_attr', 'alias'):
            root, _ = self.auth_root()
            activity = root.find('application/activity')
            if change == 'provider': root.find('application/provider').set(host.A+'exported', 'true')
            elif change == 'scheme': activity.find('intent-filter/data').set(host.A+'scheme', 'https')
            elif change == 'extra_action': ET.SubElement(activity.find('intent-filter'), 'action', {host.A+'name': 'other'})
            elif change == 'extra_attr': activity.set(host.A+'permission', 'other')
            else: activity.tag = 'activity-alias'
            with self.assertRaises(ValueError): host.verify_auth_manifest(root, True)

    def test_oauth_requires_both_actual_jni_exports(self):
        _, fragment = self.auth_root()
        required = host.required_jni_symbols([fragment])
        callback = 'Java_top_maplayer_collaboration_auth_AuthBridge_callback'
        self.assertIn(callback, required)
        self.assertIn('Java_top_maplayer_collaboration_auth_AuthInitProvider_initialize', required)
        exports = '\n'.join('1: 123 3 FUNC GLOBAL DEFAULT 12 '+name for name in required)
        host.verify_jni_exports(exports, required, 'test')
        with self.assertRaises(ValueError): host.verify_jni_exports(exports.replace(callback, callback+'_wrong'), required, 'test')

    def test_oauth_requires_actual_dex_not_source_names(self):
        root, _ = self.auth_root()
        classes = {'Ltop/maplayer/collaboration/auth/'+name+';' for name in ('AuthCallbackActivity','AuthInitProvider','AuthBridge','AuthUri')}
        host.verify_manifest_dex(root, classes, True)
        for missing in classes:
            with self.assertRaises(ValueError): host.verify_manifest_dex(root, classes-{missing}, True)

if __name__ == '__main__': unittest.main()
