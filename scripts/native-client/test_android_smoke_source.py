"""Source verifier tests use synthetic ZIP fixtures, never executable APKs."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('smoke_source', Path(__file__).with_name('verify-android-smoke-source.py'))
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        apk = self.folder/source.APK_NAME
        with zipfile.ZipFile(apk, 'w') as archive:
            for abi in ('arm64-v8a', 'x86_64'):
                archive.writestr(f'lib/{abi}/libnsh.so', b'fixture only')
        self.digest = source.digest(apk)
        self.patch = patch.object(source, 'APK_SHA256', self.digest)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.metadata = {'run': dict(id=source.RUN_ID, head_sha=source.COMMIT,
            repository=dict(full_name=source.REPOSITORY, id=source.REPOSITORY_ID),
            head_repository=dict(id=source.REPOSITORY_ID), head_branch='feat/native-collaboration-bootstrap',
            event='push', status='completed', path='.github/workflows/native-client-release.yml'),
            'artifact': dict(id=source.ARTIFACT_ID, name=source.ARTIFACT_NAME, expired=False,
                digest=source.ARTIFACT_DIGEST, workflow_run=dict(id=source.RUN_ID, head_sha=source.COMMIT,
                    repository_id=source.REPOSITORY_ID, head_repository_id=source.REPOSITORY_ID))}
        self.receipt = dict(commit=source.COMMIT, dirty=False, platform='android',
            app_id='top.maplayer.collaboration', filename=source.APK_NAME, sha256=self.digest, size=apk.stat().st_size,
            update_config='absent-blocked', update_config_sha256=None)
        self.evidence = dict(platform='android', requested_host_mode='collaboration',
            apk_filename=source.APK_NAME, apk_sha256=self.digest, apk_size=apk.stat().st_size,
            signature_verified=True, signing_identity_preserved=True, original_resources_preserved=True,
            zip_alignment='16KiB verified', native_sha256={abi: hashlib.sha256(b'fixture only').hexdigest()
                for abi in ('arm64-v8a', 'x86_64')})
        self.write_inputs()

    def write_inputs(self):
        (self.folder/'android-ubuntu-24.04-build-receipt.json').write_text(json.dumps(self.receipt))
        (self.folder/'android-ubuntu-24.04-package-evidence.json').write_text(json.dumps(self.evidence))

    def test_approved_exact_source(self):
        result = source.verify(self.folder, self.metadata)
        self.assertEqual(result['commit'], source.COMMIT)
        self.assertEqual(result['source_verification'], 'passed')
        self.assertFalse(result['update_gate_bypassed'])

    def test_wrong_run_commit_repository_event_or_artifact_rejected(self):
        for section, field, value in [('run','id',42), ('run','head_sha','f'*40),
            ('run','event','pull_request'), ('run','head_repository',{'id':42}),
            ('run','repository',{'id':42,'full_name':'other/repo'}),
            ('run','path','.github/workflows/other.yml'), ('artifact','id',42),
            ('artifact','digest','sha256:'+'0'*64), ('artifact','expired',True),
            ('artifact','workflow_run',{'id':42, 'head_sha':source.COMMIT})]:
            with self.subTest(section=section, field=field):
                metadata = copy.deepcopy(self.metadata)
                metadata[section][field] = value
                with self.assertRaises(ValueError): source.verify(self.folder, metadata)

    def test_changed_apk_or_additional_apk_rejected(self):
        with (self.folder/source.APK_NAME).open('ab') as stream: stream.write(b'changed')
        with self.assertRaises(ValueError): source.verify(self.folder, self.metadata)
        (self.folder/'unapproved.apk').write_bytes(b'other')
        with self.assertRaises(ValueError): source.verify(self.folder, self.metadata)

    def test_bad_receipt_or_package_evidence_rejected(self):
        for field, value in [('dirty',True), ('commit','f'*40), ('sha256','0'*64),
                             ('size',0), ('update_config','embedded-unverified')]:
            with self.subTest(field=field):
                previous = self.receipt[field]
                self.receipt[field] = value; self.write_inputs()
                with self.assertRaises(ValueError): source.verify(self.folder, self.metadata)
                self.receipt[field] = previous
        for field, value in [('requested_host_mode','updater'), ('signature_verified',False),
                             ('native_sha256',{'x86_64':'0'*64})]:
            with self.subTest(field=field):
                previous = self.evidence[field]
                self.evidence[field] = value; self.write_inputs()
                with self.assertRaises(ValueError): source.verify(self.folder, self.metadata)
                self.evidence[field] = previous


if __name__ == '__main__': unittest.main()
