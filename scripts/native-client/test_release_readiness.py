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
# Deliberately nonproduction fixture. Never injected into a client build.
GOOD = dict(trust=dict(public_key=list(range(1,33)), app_id='top.maplayer.collaboration', channel='stable', download_hosts=['github.com']), policy_urls=['https://updates.example.org/policy.json'], network_hosts=['updates.example.org'], linux_executable='Surreal Collaboration/SurrealCollaboration')

class ReadinessTests(unittest.TestCase):
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
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp); (root/'app.tar.gz').write_bytes(b'hello')
            config=copy.deepcopy(GOOD);config['trust']['public_key']=list(range(2,34))
            receipt=dict(update_config='embedded-unverified',update_config_public=config,filename='app.tar.gz',size=5,sha256=hashlib.sha256(b'hello').hexdigest(),version='1.0.0',platform='linux')
            (root/'linux-test-build-receipt.json').write_text(json.dumps(receipt))
            (root/'linux-test-assets.json').write_text(json.dumps([receipt|{'arch':'x86_64'}]))
            with self.assertRaises(OSError):readiness.check_release(root,'owner/repo','v1.0.0',fetch=mock.Mock(side_effect=OSError('offline')))
            with self.assertRaises(readiness.policy.subprocess.CalledProcessError):readiness.check_release(root,'owner/repo','v1.0.0',fetch=lambda url:SIGNED)

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
