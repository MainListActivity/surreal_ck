"""开发候选不会放松正式发布批准或完整性检查。"""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('builder', HERE / 'build-desktop-app.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class DevelopmentMediaTests(unittest.TestCase):
    def setUp(self):
        self.lock = json.loads((HERE / 'development-media-candidate.lock.json').read_text(encoding='utf-8'))
        self.lock['enabled'] = True
        reader = patch.object(builder.media.Path, 'read_text', return_value=json.dumps(self.lock))
        reader.start()
        self.addCleanup(reader.stop)

    def test_exact_candidate_only(self):
        with patch.dict(os.environ, {'GITHUB_EVENT_NAME':'push', 'GITHUB_REF':'refs/heads/feat/native-collaboration-bootstrap'}):
            result = builder.media.development_candidate(self.lock['manifest_sha256'], 'windows', 'x86_64')
            self.assertEqual(result['source_commit'], self.lock['source_commit'])
            for digest, platform, arch in [('0'*64,'windows','x86_64'),(self.lock['manifest_sha256'],'macos','x86_64'),(self.lock['manifest_sha256'],'windows','aarch64')]:
                with self.assertRaisesRegex(ValueError, 'pinned'):
                    builder.media.development_candidate(digest, platform, arch)

    def test_release_and_tag_rejected(self):
        for context in ({'GITHUB_EVENT_NAME':'release'}, {'GITHUB_REF':'refs/tags/v1'}):
            with patch.dict(os.environ, context):
                with self.assertRaisesRegex(ValueError, 'Release'):
                    builder.media.development_candidate(self.lock['manifest_sha256'], 'windows', 'x86_64')
            with self.assertRaisesRegex(ValueError, 'Release'):
                builder.media_config(context | {'SURREAL_MEDIA_RUNTIME_MODE':'development-candidate'})

    def test_expiration_fails_closed(self):
        from datetime import datetime, timezone
        with patch.object(builder.media, 'datetime') as clock:
            clock.now.return_value = datetime(2100,1,1,tzinfo=timezone.utc)
            clock.fromisoformat.side_effect = datetime.fromisoformat
            with self.assertRaisesRegex(ValueError, 'expired'):
                builder.media.development_candidate(self.lock['manifest_sha256'], 'windows', 'x86_64')

    def test_disabled_candidate_rejected(self):
        with patch.object(builder.media.Path, 'read_text', return_value=json.dumps(self.lock | {'enabled': False})):
            with self.assertRaisesRegex(ValueError, 'disabled'):
                builder.media.development_candidate(self.lock['manifest_sha256'], 'windows', 'x86_64')

    def test_mode_requires_complete_inputs(self):
        with self.assertRaises(ValueError):
            builder.media_config({'SURREAL_MEDIA_RUNTIME_MODE':'development-candidate'})
        with self.assertRaises(ValueError):
            builder.media_config({'SURREAL_MEDIA_RUNTIME_MODE':'allow-anything'})

    def test_workflow_never_selects_candidates_for_release(self):
        with (HERE.parent.parent / '.github/workflows/native-client-release.yml').open(encoding='utf-8') as source:
            workflow = source.read()
        block = workflow.split('- name: Prepare independently pinned Windows development media')[1].split('- name: Build Windows installer')[0]
        self.assertIn("github.event_name == 'push'", block)
        self.assertIn("github.ref == 'refs/heads/feat/native-collaboration-bootstrap'", block)


class WindowsStaticMaterialTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'build-records').mkdir()
        self.record = 'build-records/windows-static-runtime.json'
        self.data = dict(files={self.record: 'a'*64}, build_records=[self.record], license_files=[])
        self.report = dict(schema=1, packages={}, archives={'fixture.a': {'package': 'mingw-w64-x86_64-gcc'}}, binaries={})
        groups = {'crt': ['COPYING', 'COPYING.MinGW-w64-runtime.txt', 'COPYING.MinGW-w64.txt'],
                  'headers': ['COPYING', 'COPYING.MinGW-w64-runtime.txt', 'COPYING.MinGW-w64.txt'],
                  'gcc': ['COPYING3', 'COPYING.RUNTIME'], 'winpthreads': ['COPYING']}
        for group, names in groups.items():
            entries = []
            for name in names:
                path = 'licenses/toolchain/' + group + '/' + name
                self.data['files'][path] = 'b'*64
                self.data['license_files'].append(path)
                entries.append(dict(path=path, sha256='b'*64))
            self.report['packages']['mingw-w64-x86_64-' + group] = dict(version='fixture', files=entries)
        for name in ('ffmpeg', 'ffplay'):
            path = 'build-records/' + name + '-link.map'
            self.data['files'].update({path: 'c'*64, 'bin/' + name + '.exe': 'd'*64})
            self.data['build_records'].append(path)
            self.report['binaries'][name] = dict(map_path=path, map_sha256='c'*64,
                packaged_executable_sha256='d'*64, extracted_archive_members=[dict(archive='fixture.a', member='x.o')])

    def validate(self):
        (self.root / self.record).write_text(json.dumps(self.report), encoding='utf-8')
        builder.media.validate_windows_static_material(self.root, self.data)

    def test_complete_material(self):
        self.validate()

    def test_missing_record(self):
        self.data['build_records'].remove(self.record)
        with self.assertRaisesRegex(ValueError, 'static runtime evidence'):
            self.validate()

    def test_missing_runtime_exception(self):
        self.report['packages']['mingw-w64-x86_64-gcc']['files'].pop()
        with self.assertRaisesRegex(ValueError, 'toolchain notices'):
            self.validate()

    def test_notice_not_in_license_inventory(self):
        self.data['license_files'].pop()
        with self.assertRaisesRegex(ValueError, 'notice is not bound'):
            self.validate()

    def test_missing_link_map(self):
        self.data['files'].pop('build-records/ffplay-link.map')
        with self.assertRaisesRegex(ValueError, 'final link map'):
            self.validate()

    def test_mismatched_packaged_binary(self):
        self.report['binaries']['ffmpeg']['packaged_executable_sha256'] = 'e'*64
        with self.assertRaisesRegex(ValueError, 'executable mismatch'):
            self.validate()

    def test_unknown_archive_owner(self):
        self.report['archives']['fixture.a']['package'] = 'unreviewed'
        with self.assertRaisesRegex(ValueError, 'owner notices'):
            self.validate()


if __name__ == '__main__':
    unittest.main()
