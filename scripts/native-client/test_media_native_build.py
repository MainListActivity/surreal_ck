"""源码/合成 smoke 合约回归；mock 输出不构成原生运行证据。"""
import importlib.util
import hashlib
import io
import json
from pathlib import Path
import subprocess
import struct
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('media_builder', Path(__file__).with_name('build-media-runtime.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class NativeMediaBuildTests(unittest.TestCase):
    def binary_fixture(self):
        raw = bytearray(128)
        raw[:2] = b'MZ'
        struct.pack_into('<I', raw, 60, 64)
        raw[64:68] = b'PE\0\0'
        struct.pack_into('<H', raw, 68, 0x8664)
        return bytes(raw)

    def test_wrong_binary_architecture_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            binary = Path(tmp) / 'fixture.exe'
            binary.write_bytes(self.binary_fixture())
            builder.smoke.verify_binary(binary, 'windows', 'x86_64')
            with self.assertRaisesRegex(ValueError, 'architecture'):
                builder.smoke.verify_binary(binary, 'windows', 'aarch64')

    def archive(self, path, entries):
        with tarfile.open(path, 'w:gz') as tar:
            for name, content, target in entries:
                info = tarfile.TarInfo(name)
                if target is not None:
                    info.type = tarfile.SYMTYPE
                    info.linkname = target
                    tar.addfile(info)
                else:
                    data = content.encode()
                    info.size = len(data)
                    tar.addfile(info, io.BytesIO(data))

    def test_source_archive_internal_links_materialized_without_privileges(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'source.tar.gz'
            self.archive(archive, [('source/dir/file', 'fixture', None), ('source/copy', '', 'dir/file')])
            builder.extract(archive, root / 'out', 'source')
            copy = root / 'out/source/copy'
            self.assertFalse(copy.is_symlink())
            self.assertEqual(copy.read_text(), 'fixture')

    def test_rejects_traversal_and_escaping_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name, target in [('source/../../escape', None), ('/source/escape', None), ('source/link', '../../escape')]:
                archive = root / 'source.tar.gz'
                self.archive(archive, [(name, 'fixture', target)])
                with self.assertRaises(ValueError):
                    builder.extract(archive, root / 'out', 'source')

    def test_native_target_guard_runs_before_build_or_download(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(builder.smoke, 'native_target', return_value=(None, 'x86_64')):
            root = Path(tmp)
            with self.assertRaisesRegex(ValueError, 'native'):
                builder.build(root / 'work', root / 'cache', 'windows', 'x86_64', True)
            self.assertFalse((root / 'work').exists())

    def test_clean_environment_excludes_path_and_injected_libraries(self):
        env = builder.smoke.clean_environment(dict(PATH='/runner/bin', DYLD_LIBRARY_PATH='/untrusted',
            LD_LIBRARY_PATH='/untrusted', SECRET='never-log', SystemRoot='C:/Windows'))
        self.assertEqual(env['PATH'], '')
        self.assertEqual(env['SDL_AUDIODRIVER'], 'dummy')
        self.assertEqual(env['SystemRoot'], 'C:/Windows')
        self.assertNotIn('SECRET', env)
        self.assertNotIn('LD_LIBRARY_PATH', env)

    def test_synthetic_smoke_commands_and_checks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'bin').mkdir()
            for name in ('ffmpeg.exe', 'ffplay.exe'):
                (root / 'bin' / name).write_bytes(self.binary_fixture())
            def fake_run(command, **kwargs):
                work = Path(kwargs['cwd'])
                self.assertEqual(kwargs['env']['PATH'], '')
                output = kwargs['stdout']
                if hasattr(output, 'write'):
                    size = (64 * 48 * 4 * 6 if output.name.endswith('video.rgba') else
                            48000 * 2 * 2 // 5 if output.name.endswith('audio.pcm') else 128)
                    output.write(b'\x01' * size)
                if '-i' in command:
                    self.assertNotIn(command[command.index('-i') + 1], ('dshow', 'gdigrab', 'avfoundation'))
                return subprocess.CompletedProcess(command, 0, ' D dshow\n D gdigrab\n', '')
            with patch.object(builder.smoke, 'native_target', return_value=('windows', 'x86_64')), patch.object(builder.smoke.subprocess, 'run', side_effect=fake_run):
                evidence = builder.smoke.smoke(root, 'windows', 'x86_64')
            for key in ('clean_path', 'vp8_roundtrip', 'opus_roundtrip', 'ffplay_dummy', 'device_backends_listed'):
                self.assertEqual(evidence[key], 'passed')
            self.assertEqual(len(evidence['tests']), 8)

    def test_failed_native_command_never_returns_passing_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'bin').mkdir()
            for name in ('ffmpeg.exe', 'ffplay.exe'):
                (root / 'bin' / name).write_bytes(self.binary_fixture())
            with patch.object(builder.smoke, 'native_target', return_value=('windows', 'x86_64')), patch.object(builder.smoke.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'failed')):
                with self.assertRaises(RuntimeError):
                    builder.smoke.smoke(root, 'windows', 'x86_64', root / 'failed.json')
            failed = json.loads((root / 'failed.json').read_text(encoding='utf-8'))
            self.assertEqual(failed['status'], 'failed')
            self.assertEqual(failed['tests'][0]['stderr'], 'failed')
            self.assertNotIn('clean_path', failed)

    def test_transient_download_retries_with_strict_tls_and_fixed_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            payload = b'official fixture bytes'
            source = dict(url='https://example.invalid/fixed.tar.gz', sha256=hashlib.sha256(payload).hexdigest())
            attempts = []
            def run(command, **kwargs):
                attempts.append(command)
                self.assertEqual(command[1], '--disable')
                self.assertEqual(command[command.index('--proto') + 1], '=https')
                self.assertEqual(command[command.index('--proto-redir') + 1], '=https')
                self.assertNotIn('--insecure', command)
                self.assertEqual(command[-1], source['url'])
                if len(attempts) < 3:
                    return subprocess.CompletedProcess(command, 35, '000', 'SSL unexpected EOF')
                Path(command[command.index('--output') + 1]).write_bytes(payload)
                return subprocess.CompletedProcess(command, 0, '200', '')
            with patch.object(builder.shutil, 'which', return_value='curl'), patch.object(builder.subprocess, 'run', side_effect=run), patch.object(builder.time, 'sleep'):
                builder.download_source(source, root / 'archive.tar.gz', 'fixture', root / 'downloads.jsonl')
            self.assertEqual(len(attempts), 3)
            self.assertEqual((root / 'archive.tar.gz').read_bytes(), payload)
            self.assertFalse(list(root.glob('*.partial')))
            events = [json.loads(line) for line in (root / 'downloads.jsonl').read_text().splitlines()]
            self.assertEqual(events[-1]['stage'], 'download-verified')

    def test_certificate_failure_not_retried(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(builder.shutil, 'which', return_value='curl'), patch.object(builder.subprocess, 'run', return_value=subprocess.CompletedProcess([], 60, '000', 'certificate verify failed')) as run:
                with self.assertRaises(RuntimeError):
                    builder.download_source(dict(url='https://example.invalid/fixed', sha256='0'*64), root / 'archive', 'fixture')
            self.assertEqual(run.call_count, 1)
            self.assertFalse((root / 'archive').exists())

    def test_hash_failure_not_retried_or_cached(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(builder.shutil, 'which', return_value='curl'), patch.object(builder.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '200', '')) as run:
                with self.assertRaisesRegex(ValueError, 'SHA256'):
                    builder.download_source(dict(url='https://example.invalid/fixed', sha256='0'*64), root / 'archive', 'fixture')
            self.assertEqual(run.call_count, 1)
            self.assertFalse((root / 'archive').exists())

    def test_provenance_exists_before_download_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def fail(cache, destination, download, log):
                self.assertTrue((log.parent / 'provenance.json').is_file())
                self.assertTrue((log.parent / 'media-sources.lock.json').is_file())
                builder.record_event(log, source='fixture', url='https://example.invalid/fixed', stage='download', status='failed')
                raise RuntimeError('fixture network failure')
            with patch.object(builder.smoke, 'native_target', return_value=('macos', 'x86_64')), patch.object(builder.shutil, 'which', return_value='/tool'), patch.object(builder.subprocess, 'check_output', return_value='fixture-commit'), patch.object(builder, 'sources', side_effect=fail):
                with self.assertRaisesRegex(RuntimeError, 'network'):
                    builder.build(root / 'work', root / 'cache', 'macos', 'x86_64', True)
            self.assertTrue((root / 'work/runtime/build-records/downloads.jsonl').is_file())
            self.assertFalse((root / 'work/candidate-manifest.json').exists())

    def test_failed_build_preserves_configure_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def source_fixture(cache, destination, download, log):
                folder = destination / 'ffmpeg/ffbuild'
                folder.mkdir(parents=True)
                (folder / 'config.log').write_text('configure failure detail')
                return dict(sources=dict(ffmpeg=dict(directory='ffmpeg')))
            with patch.object(builder.smoke, 'native_target', return_value=('macos', 'x86_64')), patch.object(builder.shutil, 'which', return_value='/tool'), patch.object(builder.subprocess, 'check_output', return_value='fixture-commit'), patch.object(builder, 'sources', side_effect=source_fixture), patch.object(builder.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['bash'])):
                with self.assertRaises(subprocess.CalledProcessError):
                    builder.build(root / 'work', root / 'cache', 'macos', 'x86_64')
            self.assertEqual((root / 'work/runtime/build-records/ffmpeg-ffbuild-config.log').read_text(), 'configure failure detail')
            self.assertFalse((root / 'work/candidate-manifest.json').exists())

    def test_recipe_remains_minimal_and_never_approves_release(self):
        shell = (builder.HERE / 'build-media-native.sh').read_text(encoding='utf-8')
        for flag in ('--disable-gpl', '--disable-nonfree', '--disable-autodetect', '--disable-network',
                     '--enable-indev=avfoundation', '--enable-indev=dshow,gdigrab', '--enable-libopus', '--enable-libvpx',
                     '--enable-decoder=wrapped_avframe,', '--enable-filter=scale,format,aresample,aformat,testsrc2,sine'):
            self.assertIn(flag, shell)
        self.assertNotIn('sudo ', shell)
        source = Path(builder.__file__).read_text(encoding='utf-8')
        self.assertIn('release_approved=False', source)
        workflow = (builder.HERE.parents[1] / '.github/workflows/native-media-runtime-candidate.yml').read_text(encoding='utf-8')
        self.assertIn('workflow_dispatch:', workflow)
        self.assertNotIn('secrets.', workflow)
        self.assertNotIn('pacman -', workflow)


if __name__ == '__main__':
    unittest.main()
