import copy
import importlib.util
import json
import pathlib
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import io
import os
import hashlib
from update_config import parse_config, validate_config

SCRIPT = pathlib.Path(__file__).with_name('check-release-readiness.py').resolve()
spec=importlib.util.spec_from_file_location('readiness',SCRIPT)
readiness=importlib.util.module_from_spec(spec)
spec.loader.exec_module(readiness)
receipt_spec = importlib.util.spec_from_file_location('build_receipt', SCRIPT.with_name('build-receipt.py'))
build_receipt = importlib.util.module_from_spec(receipt_spec)
receipt_spec.loader.exec_module(build_receipt)
# Deliberately nonproduction fixture. Never injected into a client build.
GOOD = dict(trust=dict(public_key=list(range(1,33)), app_id='top.maplayer.collaboration', channel='stable', download_hosts=['github.com']), policy_urls=['https://updates.example.org/policy.json'], network_hosts=['updates.example.org'], linux_executable='Surreal Collaboration/SurrealCollaboration')

class ReadinessTests(unittest.TestCase):
    def write_final_desktop_receipt(self, root, package):
        """Finish the real receipt contract using bytes and signing metadata from fixtures."""
        snapshot = {field: package[field] for field in (
            'host_arch', 'version', 'app_id', 'commit', 'source_sha256', 'update_config_sha256'
        )}
        config = copy.deepcopy(GOOD)
        config['trust']['public_key'] = list(range(2, 34))
        snapshot.update(dirty=False, update_config='embedded-unverified', update_config_public=config)
        (root / 'build-input.json').write_text(json.dumps(snapshot), encoding='utf-8')
        installer = root / 'SurrealCK-fixture.exe'
        installer.write_bytes(b'fixture installer bytes')
        evidence = root / 'desktop-package-evidence.json'
        encoded = json.dumps(package).encode()
        evidence.write_bytes(encoded)
        with mock.patch.object(build_receipt, 'snapshot', return_value=snapshot), \
             mock.patch.object(sys, 'argv', ['build-receipt.py', 'finish', str(root), 'windows']):
            build_receipt.main()
        receipt_path = root / 'windows-fixture-build-receipt.json'
        receipt_path.write_bytes((root / 'build-receipt.json').read_bytes())
        receipt = json.loads(receipt_path.read_bytes())
        self.assertEqual(receipt['desktop_package_evidence_sha256'], hashlib.sha256(encoded).hexdigest())
        final_evidence = root / 'windows-fixture-package-evidence.json'
        final_evidence.write_bytes(encoded)
        index = root / 'windows-fixture-assets.json'
        item = {field: receipt[field] for field in ('platform', 'filename', 'version', 'sha256', 'size')}
        index.write_text(json.dumps([item | dict(arch='x86_64', signing='authenticode')]), encoding='utf-8')
        return receipt_path, final_evidence

    def test_desktop_development_artifacts_rejected_without_build_environment(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {}, clear=True):
            root = pathlib.Path(tmp)
            receipt_path = root / 'windows-test-build-receipt.json'
            receipt = dict(platform='windows', host_arch='x86_64')
            receipt_path.write_text(json.dumps(receipt), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'Missing desktop'):
                readiness.check_release(root, 'owner/repo', 'v1')
            receipt_path.unlink()
            files = {'bin/ffmpeg.exe': 'ab' * 32, 'bin/ffplay.exe': 'cd' * 32}
            base = dict(platform='windows', entrypoint='native-client/src/main.rs',
                        features=['desktop', 'windows-auto-update'], host_arch='x86_64',
                        commit='ab' * 20, version='0.1.3', app_id=GOOD['trust']['app_id'],
                        source_sha256='ca' * 32, update_config_sha256='bc' * 32,
                        media_runtime=dict(status='bundled', development_only=False, release_approved=True,
                                           platform='windows', arch='x86_64', manifest_sha256='ef' * 32,
                                           sealed_inventory_validation='passed', files=files, packaged_files=files))
            receipt_path, evidence = self.write_final_desktop_receipt(root, base)
            with mock.patch.object(readiness, 'EXPECTED_TARGETS', {('windows', 'x86_64')}):
                _, version = readiness.load_installers(root, commit=base['commit'], require_release_signing=True)
                self.assertEqual(version, base['version'])
            evidence.write_bytes(evidence.read_bytes() + b' ')
            with self.assertRaisesRegex(ValueError, 'does not match the final build receipt'):
                readiness.check_desktop_package(receipt_path, json.loads(receipt_path.read_bytes()))
            cases = [
                ({'development_only': True}, 'unapproved media'),
                ({'release_approved': False}, 'unapproved media'),
                ({'release_approved': None}, 'unapproved media'),
                ({'development_only': None}, 'unapproved media'),
                ({'sealed_inventory_validation': None}, 'sealed SHA256'),
                ({'manifest_sha256': ''}, 'sealed SHA256'),
                ({'packaged_files': files | {'bin/ffplay.exe': '12' * 32}}, 'sealed SHA256'),
                ({'arch': 'aarch64'}, 'target differs'),
            ]
            for fields, error in cases:
                self.write_final_desktop_receipt(root, base | {'media_runtime': base['media_runtime'] | fields})
                with self.subTest(fields=fields), self.assertRaisesRegex(ValueError, error):
                    readiness.check_release(root, 'owner/repo', 'v1')
            self.write_final_desktop_receipt(root, base | {'features': base['features'] + ['github-manual-updates']})
            with self.assertRaisesRegex(ValueError, 'mandatory platform updates'):
                readiness.check_release(root, 'owner/repo', 'v1')

    def test_valid_structure_is_not_service_verification(self):
        self.assertEqual(validate_config(copy.deepcopy(GOOD)), GOOD)

    def test_invalid_config(self):
        cases = [{}, {'trust':{}}, None]
        for key in ([], [0]*32, [1]*31, [256]*32, [True]*32):
            c=copy.deepcopy(GOOD); c['trust']['public_key']=key; cases.append(c)
        for url in ('http://updates.example.org/policy', 'https://evil.example/policy', 'https://u:p@updates.example.org/x','https://updates.example.org:444/x', 'https://updates.example.org/x#fragment'):
            c=copy.deepcopy(GOOD); c['policy_urls']=[url]; cases.append(c)
        c=copy.deepcopy(GOOD); c['trust']['app_id']='wrong.app'; cases.append(c)
        c=copy.deepcopy(GOOD); c['trust']['download_hosts']=[]; cases.append(c)
        c=copy.deepcopy(GOOD); c['linux_executable']='../escape'; cases.append(c)
        for c in cases:
            with self.subTest(c=c), self.assertRaises(ValueError):validate_config(c)
        with self.assertRaises(ValueError):parse_config('{bad JSON')

    def test_publication_rejects_missing_absent_empty_malformed(self):
        for value in (None, {'update_config':'absent-blocked'}, {'update_config':'embedded-unverified','update_config_public':{}}, '{bad JSON'):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as tmp:
                if value is not None:
                    p=pathlib.Path(tmp)/'android-test-build-receipt.json'
                    p.write_text(value if isinstance(value,str) else json.dumps(value))
                r=subprocess.run([sys.executable,str(SCRIPT),tmp,'--repository','owner/repo','--tag','v0.1.0'],capture_output=True)
                self.assertNotEqual(r.returncode,0)

class OnlinePreflightTests(unittest.TestCase):
    def candidate(self):
        return dict(app_id=GOOD['trust']['app_id'],channel='stable',issued_at=100,expires_at=200000,releases=[dict(platform='linux',arch='x86_64',version='1.0.0',size=10,sha256='ab'*32,url='https://github.com/owner/repo/releases/download/v1.0.0/app.tar.gz',mirror_urls=[])])

    def test_time_identity_and_url_fail_closed(self):
        p=self.candidate(); readiness.check_policy(p,GOOD,1000)
        for field,value in [('issued_at',1001),('expires_at',1000),('expires_at',1001),('app_id','wrong'),('channel','wrong')]:
            bad=copy.deepcopy(p);bad[field]=value
            with self.assertRaises(ValueError):readiness.check_policy(bad,GOOD,1000)
        p['releases'][0]['url']='https://evil.example/asset'
        with self.assertRaises(ValueError):readiness.check_policy(p,GOOD,1000)

    def test_exact_artifact_contract(self):
        p=self.candidate(); item=dict(platform='linux',arch='x86_64',version='1.0.0',size=10,sha256='ab'*32,filename='app.tar.gz')
        readiness.match_asset(p,item,'owner/repo','v1.0.0')
        for key,value in [('version','2.0.0'),('sha256','cd'*32),('size',11),('arch','aarch64'),('filename','wrong.tar.gz')]:
            bad=item|{key:value}
            with self.assertRaises(ValueError):readiness.match_asset(p,bad,'owner/repo','v1.0.0')

    def test_mac_developer_id_alone_cannot_admit_installer(self):
        p = self.candidate()
        release = p['releases'][0]
        release.update(platform='macos', arch='aarch64',
                       url='https://github.com/owner/repo/releases/download/v1.0.0/app.dmg')
        item = {key: release[key] for key in ('platform', 'arch', 'version', 'size', 'sha256')}
        item['filename'] = 'app.dmg'
        item['signing'] = 'developer-id-not-notarized'
        with self.assertRaisesRegex(ValueError, 'stapled notarization'):
            readiness.match_asset(p, item, 'owner/repo', 'v1.0.0')
        item['signing'] = 'developer-id-notarized'
        readiness.match_asset(p, item, 'owner/repo', 'v1.0.0')

    def test_remote_allowlist_rejected_before_network(self):
        for url in ('http://github.com/x','https://evil.example/x','https://u:p@github.com/x'):
            with self.assertRaises(ValueError):readiness.remote_artifact(url,1,'ab'*32,['github.com'])

    def test_remote_bytes_not_just_http_success(self):
        for body,expected in [(b'ab',hashlib.sha256(b'ab').hexdigest()), (b'xx',hashlib.sha256(b'ab').hexdigest())]:
            response=io.BytesIO(body); response.status=200
            opener=mock.Mock();opener.open.return_value=response
            with mock.patch.object(readiness.urllib.request,'build_opener',return_value=opener):
                if body==b'ab':readiness.remote_artifact('https://github.com/x',2,expected,['github.com'])
                else:
                    with self.assertRaisesRegex(ValueError,'bytes differ'):readiness.remote_artifact('https://github.com/x',2,expected,['github.com'])

    def test_unavailable_endpoint_and_real_signature_mismatch(self):
        from test_update_policy import SIGNED
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(readiness, 'EXPECTED_TARGETS', {('linux', 'x86_64')}):
            root=pathlib.Path(tmp); (root/'app.tar.gz').write_bytes(b'hello')
            config=copy.deepcopy(GOOD);config['trust']['public_key']=list(range(2,34))
            receipt=dict(update_config='embedded-unverified',update_config_public=config,filename='app.tar.gz',size=5,sha256=hashlib.sha256(b'hello').hexdigest(),version='1.0.0',platform='linux')
            (root/'linux-test-build-receipt.json').write_text(json.dumps(receipt))
            (root/'linux-test-assets.json').write_text(json.dumps([receipt|{'arch':'x86_64'}]))
            with self.assertRaises(OSError):readiness.check_release(root,'owner/repo','v1.0.0',fetch=mock.Mock(side_effect=OSError('offline')))
            with self.assertRaises(readiness.policy.subprocess.CalledProcessError):readiness.check_release(root,'owner/repo','v1.0.0',fetch=lambda url:SIGNED)

    def test_production_build_accepts_windows_without_certificate_and_rejects_wrong_commit(self):
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(readiness, 'EXPECTED_TARGETS', {('windows', 'x86_64')}), \
             mock.patch.object(readiness, 'check_desktop_package') as desktop:
            root = pathlib.Path(tmp)
            config = copy.deepcopy(GOOD)
            config['trust']['public_key'] = list(range(2, 34))
            installer = root / 'app.exe'
            installer.write_bytes(b'installer')
            identity = dict(platform='windows', filename=installer.name, version='0.1.3',
                            size=installer.stat().st_size, sha256=readiness.file_hash(installer))
            receipt = root / 'windows-build-receipt.json'
            receipt.write_text(json.dumps(identity | dict(commit='a'*40, dirty=False, host_arch='x86_64',
                               update_config='embedded-unverified', update_config_public=config)))
            index = root / 'windows-assets.json'
            asset = identity | dict(arch='x86_64', signing='unknown')
            index.write_text(json.dumps([asset]))
            with self.assertRaisesRegex(ValueError, 'exact clean release commit'):
                readiness.load_installers(root, commit='b'*40, require_release_signing=False)
            with self.assertRaisesRegex(ValueError, 'Windows installer signing status'):
                readiness.load_installers(root, commit='a'*40, require_release_signing=False)
            for signing in ('unsigned', 'authenticode'):
                with self.subTest(signing=signing):
                    index.write_text(json.dumps([asset | dict(signing=signing)]))
                    _, version = readiness.load_installers(root, commit='a'*40, require_release_signing=False)
                    self.assertEqual(version, '0.1.3')
            desktop.assert_called_with(receipt, mock.ANY)
            readiness.load_installers(root, commit='a'*40, require_release_signing=True)
            index.write_text(json.dumps([asset | dict(arch='aarch64', signing='authenticode')]))
            with self.assertRaisesRegex(ValueError, 'architecture differs'):
                readiness.load_installers(root, commit='a'*40, require_release_signing=True)
            index.write_text(json.dumps([asset | dict(signing='unsigned')]))
            with self.assertRaisesRegex(ValueError, 'must be authenticode'):
                readiness.check_release(root, 'owner/repo', 'v0.1.3', commit='a'*40)

    def test_evidence_upload_never_includes_installers_or_overwrites(self):
        helper=SCRIPT.with_name('attach-release-evidence.py')
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp); assets=root/'assets';assets.mkdir()
            (assets/'online-policy-preflight.json').write_text(json.dumps({'result':'online-policy-and-public-artifact-bytes-match'}))
            for name in ('app.apk','app.exe','app.dmg','linux-test-SHA256SUMS.txt','linux-test-build-receipt.json'):(assets/name).write_text('fixture')
            # Mock the command boundary, never a PATH executable that can fall
            # through to the real gh CLI on Windows or contact GitHub.
            with mock.patch.object(subprocess,'check_output',return_value=json.dumps({'assets':[{'name':'linux-test-SHA256SUMS.txt'}]})) as view, \
                 mock.patch.object(subprocess,'run') as upload, \
                 mock.patch.object(sys,'argv',[str(helper),str(assets)]), \
                 mock.patch.dict(os.environ,{'RELEASE_TAG':'v1.0.0'}):
                runpy.run_path(str(helper),run_name='__main__')
            view.assert_called_once_with(['gh','release','view','v1.0.0','--json','assets'],text=True)
            uploads=[call.args[0] for call in upload.call_args_list]
            self.assertEqual(len(uploads),2)
            self.assertTrue(all(x[:4]==['gh','release','upload','v1.0.0'] for x in uploads))
            self.assertTrue(all(x[-1].endswith('.json') and '--clobber' not in x for x in uploads))

    def test_invalid_signature_and_known_fixture_key(self):
        # Actual OpenSSL signature verification; no signing or keys generated.
        from test_update_policy import SIGNED, PUBLIC
        with self.assertRaises(readiness.policy.subprocess.CalledProcessError):
            readiness.policy.read_envelope(SIGNED,bytes(range(2,34)).hex())
        self.assertIn(PUBLIC,readiness.TEST_PUBLIC_KEYS)

if __name__=='__main__':unittest.main()
