"""源码/合成 smoke 合约回归；mock 输出不构成原生运行证据。"""
import importlib.util
import hashlib
import io
import json
import os
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
            with patch.object(builder.smoke, 'native_target', return_value=('windows', 'x86_64')), patch.object(builder.smoke.platform, 'platform', return_value='fixture-host'), patch.object(builder.smoke.subprocess, 'run', side_effect=fake_run):
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
            with patch.object(builder.smoke, 'native_target', return_value=('windows', 'x86_64')), patch.object(builder.smoke.platform, 'platform', return_value='fixture-host'), patch.object(builder.smoke.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'failed')):
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
                format_arg = command[command.index('--write-out') + 1]
                self.assertTrue(format_arg.startswith('@'))
                self.assertEqual(Path(format_arg[1:]).read_text(encoding='ascii'), '%{http_code}')
                self.assertEqual(command[-1], source['url'])
                if len(attempts) < 3:
                    return subprocess.CompletedProcess(command, 35, '000', 'SSL unexpected EOF')
                Path(command[command.index('--output') + 1]).write_bytes(payload)
                return subprocess.CompletedProcess(command, 0, '200', '')
            with patch.object(builder, 'resolve_curl', return_value='/fixture/curl'), patch.object(builder, 'curl_tls_options', return_value=([], {})), patch.object(builder.subprocess, 'run', side_effect=run), patch.object(builder.time, 'sleep'):
                builder.download_source(source, root / 'archive.tar.gz', 'fixture', root / 'downloads.jsonl')
            self.assertEqual(len(attempts), 3)
            self.assertEqual((root / 'archive.tar.gz').read_bytes(), payload)
            self.assertFalse(list(root.glob('*.partial')))
            events = [json.loads(line) for line in (root / 'downloads.jsonl').read_text().splitlines()]
            self.assertEqual(events[-1]['stage'], 'download-verified')

    def test_certificate_failure_not_retried(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(builder, 'resolve_curl', return_value='/fixture/curl'), patch.object(builder, 'curl_tls_options', return_value=([], {})), patch.object(builder.subprocess, 'run', return_value=subprocess.CompletedProcess([], 60, '000', 'certificate verify failed')) as run:
                with self.assertRaises(RuntimeError):
                    builder.download_source(dict(url='https://example.invalid/fixed', sha256='0'*64), root / 'archive', 'fixture')
            self.assertEqual(run.call_count, 1)
            self.assertFalse((root / 'archive').exists())

    def test_hash_failure_not_retried_or_cached(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(builder, 'resolve_curl', return_value='/fixture/curl'), patch.object(builder, 'curl_tls_options', return_value=([], {})), patch.object(builder.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '200', '')) as run:
                with self.assertRaisesRegex(ValueError, 'SHA256'):
                    builder.download_source(dict(url='https://example.invalid/fixed', sha256='0'*64), root / 'archive', 'fixture')
            self.assertEqual(run.call_count, 1)
            self.assertFalse((root / 'archive').exists())

    def test_windows_tool_search_never_uses_wsl_or_current_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'msys64'
            calls = []
            def which(name, path=None):
                calls.append((name, path))
                if path is None:
                    return '/fixture/git'
                file = Path(path) / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(b'fixture executable, never run')
                return str(file)
            with patch.object(builder.shutil, 'which', side_effect=which):
                tools = builder.resolve_tools('windows', False, root)
            self.assertEqual(tools['bash'], str((root / 'usr/bin/bash.exe').resolve()))
            self.assertEqual(tools['cygpath'], str((root / 'usr/bin/cygpath.exe').resolve()))
            self.assertEqual(tools['gcc'], str((root / 'mingw64/bin/gcc.exe').resolve()))
            self.assertTrue(all(path is not None for name, path in calls if name != 'git'))
            with patch.object(builder.subprocess, 'check_output', return_value='/translated') as run:
                self.assertEqual(builder.posix_path(Path('fixture'), 'windows', tools), '/translated')
            self.assertEqual(run.call_args.args[0][0], tools['cygpath'])

    def test_windows_build_invokes_validated_absolute_shell(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = dict(bash=str(root / 'msys64/usr/bin/bash.exe'), gcc=str(root / 'msys64/mingw64/bin/gcc.exe'),
                         cygpath=str(root / 'msys64/usr/bin/cygpath.exe'), git=str(root / 'git.exe'))
            with patch.object(builder.smoke, 'native_target', return_value=('windows', 'x86_64')), patch.object(builder.smoke.platform, 'platform', return_value='fixture-host'), patch.object(builder, 'resolve_tools', return_value=tools), patch.object(builder, 'windows_package_provenance', return_value={'fixture': True}), patch.object(builder, 'sources', return_value={'sources': {}}), patch.object(builder.subprocess, 'check_output', return_value='/fixture'), patch.dict(builder.os.environ, {'SystemRoot': str(root / 'Windows')}), patch.object(builder.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['fixture'])) as run:
                with self.assertRaises(subprocess.CalledProcessError):
                    builder.build(root / 'work', root / 'cache', 'windows', 'x86_64')
            self.assertEqual(run.call_args.args[0][0], tools['bash'])
            self.assertNotEqual(run.call_args.args[0][0], 'bash')
            self.assertTrue(run.call_args.kwargs['env']['PATH'].startswith(str(Path(tools['gcc']).parent)))

    def test_windows_tool_result_outside_msys_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            wsl = root / 'System32/bash.exe'
            wsl.parent.mkdir()
            wsl.write_bytes(b'never run')
            with patch.object(builder.shutil, 'which', return_value=str(wsl)):
                with self.assertRaisesRegex(ValueError, 'approved tool directory'):
                    builder.resolve_tools('windows', False, root / 'msys64')

    def test_unexpanded_http_status_never_reported_as_real_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(builder, 'resolve_curl', return_value='/fixture/curl'), patch.object(builder, 'curl_tls_options', return_value=([], {})), patch.object(builder.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '%http_code', '')):
                with self.assertRaisesRegex(RuntimeError, 'Invalid curl HTTP'):
                    builder.download_source(dict(url='https://example.invalid/fixed', sha256='0'*64), root / 'archive', 'fixture', root / 'log.jsonl')
            events = [json.loads(line) for line in (root / 'log.jsonl').read_text(encoding='utf-8').splitlines()]
            result = next(event for event in events if event['stage'] == 'download-result')
            self.assertIsNone(result['http_status'])
            self.assertEqual(result['http_status_raw'], '%http_code')
            self.assertFalse((root / 'archive').exists())
            self.assertFalse(list(root.glob('*.writeout')))

    def test_provenance_exists_before_download_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def fail(cache, destination, download, log):
                self.assertTrue((log.parent / 'provenance.json').is_file())
                self.assertTrue((log.parent / 'media-sources.lock.json').is_file())
                builder.record_event(log, source='fixture', url='https://example.invalid/fixed', stage='download', status='failed')
                raise RuntimeError('fixture network failure')
            with patch.object(builder.smoke, 'native_target', return_value=('macos', 'x86_64')), patch.object(builder.smoke.platform, 'platform', return_value='fixture-host'), patch.object(builder.shutil, 'which', return_value='/tool'), patch.object(builder, 'resolve_curl', return_value='/tool'), patch.object(builder.subprocess, 'check_output', return_value='fixture-commit'), patch.object(builder, 'sources', side_effect=fail):
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
            with patch.object(builder.smoke, 'native_target', return_value=('macos', 'x86_64')), patch.object(builder.smoke.platform, 'platform', return_value='fixture-host'), patch.object(builder.shutil, 'which', return_value='/tool'), patch.object(builder, 'resolve_curl', return_value='/tool'), patch.object(builder.subprocess, 'check_output', return_value='fixture-commit'), patch.object(builder, 'sources', side_effect=source_fixture), patch.object(builder.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['bash'])):
                with self.assertRaises(subprocess.CalledProcessError):
                    builder.build(root / 'work', root / 'cache', 'macos', 'x86_64')
            self.assertEqual((root / 'work/runtime/build-records/ffmpeg-ffbuild-config.log').read_text(), 'configure failure detail')
            self.assertFalse((root / 'work/candidate-manifest.json').exists())

    def test_windows_curl_requires_official_ca_and_openssl(self):
        with tempfile.TemporaryDirectory() as tmp:
            prefix = Path(tmp) / 'mingw64'
            curl = prefix / 'bin/curl.exe'
            with self.assertRaisesRegex(ValueError, 'CA bundle missing'):
                builder.curl_tls_options(str(curl), 'windows')
            bundle = prefix / 'etc/ssl/certs/ca-bundle.crt'
            bundle.parent.mkdir(parents=True)
            bundle.write_bytes(b'fixture CA, never used for a network request')
            options, env = builder.curl_tls_options(str(curl), 'windows')
            self.assertEqual(options, ['--cacert', str(bundle)])
            self.assertEqual(env['CURL_SSL_BACKEND'], 'openssl')
            with patch.object(builder.subprocess, 'check_output', return_value='curl fixture OpenSSL/3.fixture'):
                record = builder.curl_provenance(str(curl), 'windows')
            self.assertEqual(record['ca_bundle_sha256'], builder.digest(bundle))
            self.assertTrue(record['certificate_verification'])
            with patch.object(builder.subprocess, 'check_output', return_value='curl fixture Schannel'):
                with self.assertRaisesRegex(ValueError, 'OpenSSL backend'):
                    builder.curl_provenance(str(curl), 'windows')

    def test_package_versions_recorded_and_required_packages_checked(self):
        installed = '\n'.join(name + ' 1.2.3-1' for name in builder.MSYS2_PACKAGES) + '\ntransitive-runtime 4.5-1\n'
        with patch.object(builder.subprocess, 'check_output', return_value=installed) as query:
            record = builder.windows_package_provenance({'pacman': '/verified/pacman.exe'})
        self.assertEqual(query.call_args.args[0], ['/verified/pacman.exe', '-Q'])
        self.assertEqual(record['requested_packages']['make'], '1.2.3-1')
        self.assertEqual(record['installed_packages']['transitive-runtime'], '4.5-1')
        self.assertEqual(record['configured_action_commit'], builder.MSYS2_ACTION_COMMIT)
        self.assertTrue(record['temporary_msys2_update_requested'])
        self.assertIn('no host OS update', record['update_scope'])
        self.assertFalse(record['signature_policy_override'])
        with patch.object(builder.subprocess, 'check_output', return_value='bash 1.2-1\n'):
            with self.assertRaisesRegex(ValueError, 'packages missing'):
                builder.windows_package_provenance({'pacman': '/verified/pacman.exe'})

    def test_workflow_packages_pin_and_scoped_installer_exclusions(self):
        root = builder.HERE.parents[1]
        workflow = (root / '.github/workflows/native-media-runtime-candidate.yml').read_text(encoding='utf-8')
        self.assertIn('msys2/setup-msys2@' + builder.MSYS2_ACTION_COMMIT, workflow)
        self.assertIn('msystem: MINGW64', workflow)
        self.assertIn('update: true', workflow)
        self.assertIn('release: true', workflow)
        packages = workflow.split('install: >-', 1)[1].split('      - name:', 1)[0].split()
        self.assertEqual(set(packages), set(builder.MSYS2_PACKAGES))
        self.assertIn('-m unittest discover -s scripts/native-client -p test_media_native_build.py', workflow)
        installer = (root / '.github/workflows/native-client-release.yml').read_text(encoding='utf-8')
        excluded = [line.strip() for line in installer.splitlines() if "'!scripts/native-client/" in line]
        expected = ["- '!scripts/native-client/" + name + "'" for name in ('build-media-native.sh', 'build-media-runtime.py', 'media-sources.lock.json', 'smoke-media-runtime.py', 'test_media_native_build.py')]
        self.assertEqual(sorted(excluded), sorted(expected * 2))

    def runtime_material_fixture(self, root):
        work = root / 'work'
        source = work / 'src'
        ffmpeg = source / 'FFmpeg-n9.0.2'
        runtime = work / 'runtime'
        msys = root / 'msys64'
        (runtime / 'bin').mkdir(parents=True)
        (runtime / 'build-records').mkdir()
        ffmpeg.mkdir(parents=True)
        archive = msys / 'mingw64/lib/libpthread.a'
        archive.parent.mkdir(parents=True)
        archive.write_bytes(b'fixture archive never executed')
        for name in ('ffmpeg', 'ffplay'):
            (runtime / 'bin' / (name + '.exe')).write_bytes(b'stripped fixture')
            (ffmpeg / (name + '_g.exe')).write_bytes(b'linked fixture')
            (ffmpeg / (name + '-link.map')).write_text(
                'Archive member included to satisfy reference by file (symbol)\n' +
                os.path.relpath(archive, ffmpeg).replace('\\', '/') + '(thread.o)\n  reference (pthread_create)\n\nMemory Configuration\n', encoding='utf-8')
        inventories = {}
        installed = {}
        for package, names in builder.REQUIRED_WINDOWS_NOTICES.items():
            installed[package] = 'fixture-version'
            entries = []
            for name in names:
                relative = '/mingw64/share/licenses/' + package + '/' + name
                path = msys / relative.lstrip('/')
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('official license fixture, not a legal assertion', encoding='utf-8')
                entries.append(package + ' ' + relative)
            inventories[package] = '\n'.join(entries)
        tools = dict(gcc=str(msys / 'mingw64/bin/gcc.exe'), cygpath='/fixture/cygpath', pacman='/fixture/pacman')
        def query(command, **kwargs):
            if '-Qoq' in command:
                return 'mingw-w64-x86_64-winpthreads\n'
            if '-Ql' in command:
                return inventories[command[-1]]
            if '-u' in command:
                return command[-1]
            raise AssertionError(command)
        return source, runtime, tools, installed, query, inventories

    def test_actual_link_members_and_toolchain_notice_mapping(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, runtime, tools, installed, query, inventories = self.runtime_material_fixture(Path(tmp))
            with patch.object(builder.subprocess, 'check_output', side_effect=query):
                report = builder.collect_windows_runtime_materials(source, runtime, tools, installed)
            self.assertEqual(set(report['binaries']), {'ffmpeg', 'ffplay'})
            for binary in report['binaries'].values():
                self.assertEqual(binary['extracted_archive_members'][0]['member'], 'thread.o')
                self.assertTrue((runtime / binary['map_path']).is_file())
            self.assertEqual(set(report['packages']), set(builder.REQUIRED_WINDOWS_NOTICES))
            for package in report['packages'].values():
                self.assertEqual(package['version'], 'fixture-version')
                for notice in package['files']:
                    self.assertEqual(notice['sha256'], builder.digest(runtime / notice['path']))
            self.assertIn('pending', report['legal_review'])

    def test_missing_toolchain_exception_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, runtime, tools, installed, query, inventories = self.runtime_material_fixture(Path(tmp))
            package = 'mingw-w64-x86_64-gcc'
            inventories[package] = '\n'.join(line for line in inventories[package].splitlines() if not line.endswith('COPYING.RUNTIME'))
            with patch.object(builder.subprocess, 'check_output', side_effect=query):
                with self.assertRaisesRegex(ValueError, 'license/exception material missing'):
                    builder.collect_windows_runtime_materials(source, runtime, tools, installed)
            self.assertFalse((runtime / 'build-records/windows-static-runtime.json').exists())

    def test_msys_link_archive_paths_use_bound_cygpath(self):
        tools = {'cygpath': 'D:/job/msys64/usr/bin/cygpath.exe'}
        for original, converted in (
            ('/mingw64/lib/libgcc.a', 'D:/job/msys64/mingw64/lib/libgcc.a'),
            ('/d/work/libvpx.a', 'D:/work/libvpx.a'),
        ):
            with self.subTest(original=original), patch.object(builder.subprocess, 'check_output', return_value=converted + '\n') as query:
                self.assertEqual(builder.windows_archive_path(original, tools), Path(converted))
                query.assert_called_once_with([tools['cygpath'], '-w', original], text=True, encoding='utf-8')
        with patch.object(builder.subprocess, 'check_output') as query:
            for original in ('D:/work/libvpx.a', 'libavcodec/libavcodec.a'):
                self.assertEqual(builder.windows_archive_path(original, tools), Path(original))
            query.assert_not_called()

    def test_msys_link_archive_invalid_conversion_fails_closed(self):
        tools = {'cygpath': 'D:/job/msys64/usr/bin/cygpath.exe'}
        for converted in ('', '/mingw64/libgcc.a', 'D:relative.a', 'D:/a.a\nD:/b.a'):
            with self.subTest(converted=converted), patch.object(builder.subprocess, 'check_output', return_value=converted):
                with self.assertRaisesRegex(ValueError, 'Invalid absolute archive path'):
                    builder.windows_archive_path('/mingw64/libgcc.a', tools)
        with self.assertRaisesRegex(ValueError, 'Ambiguous Windows archive path'):
            builder.windows_archive_path('D:relative.a', tools)

    def test_link_map_requires_extracted_members_not_only_load_lines(self):
        with self.assertRaisesRegex(ValueError, 'extraction table'):
            builder.map_members('LOAD /fixture/libgcc.a\n')
        with self.assertRaisesRegex(ValueError, 'No archive members'):
            builder.map_members('Archive member included to satisfy reference by file (symbol)\nMemory Configuration\nLOAD libgcc.a\n')
        text = ('Archive member included to satisfy reference by file (symbol)\n/lib/a.a(actual.o)\n'
                'Discarded input sections\n/lib/unused.a(not-in-extraction-table.o)\n')
        self.assertEqual(builder.map_members(text), [('/lib/a.a', 'actual.o')])

    def test_recipe_remains_minimal_and_never_approves_release(self):
        shell = (builder.HERE / 'build-media-native.sh').read_text(encoding='utf-8')
        for flag in ('--disable-gpl', '--disable-nonfree', '--disable-autodetect', '--disable-network',
                     '--enable-indev=avfoundation', '--enable-indev=dshow,gdigrab', '--enable-libopus', '--enable-libvpx',
                     '--enable-decoder=wrapped_avframe,', '--enable-filter=scale,format,aresample,aformat,testsrc2,sine'):
            self.assertIn(flag, shell)
        self.assertNotIn('sudo ', shell)
        self.assertIn('LDFLAGS-ffmpeg=-Wl,-Map,ffmpeg-link.map', shell)
        self.assertIn('LDFLAGS-ffplay=-Wl,-Map,ffplay-link.map', shell)
        source = Path(builder.__file__).read_text(encoding='utf-8')
        self.assertIn('release_approved=False', source)
        workflow = (builder.HERE.parents[1] / '.github/workflows/native-media-runtime-candidate.yml').read_text(encoding='utf-8')
        self.assertIn('workflow_dispatch:', workflow)
        self.assertNotIn('secrets.', workflow)
        self.assertNotIn('-Syu', workflow)
        self.assertNotIn('--overwrite', workflow)
        self.assertNotIn('SigLevel', workflow)
        self.assertNotIn('pacman --noconfirm -Sy --needed', workflow)


if __name__ == '__main__':
    unittest.main()
