#!/usr/bin/env python3
"""Offline contract tests; native compilation is verified on the Intel CI runner."""
import importlib.util
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('install_nsh', pathlib.Path(__file__).with_name('install-nsh.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def test_only_intel_macos_uses_source(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(installer, 'build_intel_macos') as build:
            installer.install(pathlib.Path(tmp), 'macos', 'x86_64')
            build.assert_called_once()

    def test_other_hosts_keep_checksum_archive_path(self):
        for system, arch in [('macos', 'arm64'), ('linux', 'x86_64'), ('windows', 'x86_64')]:
            with self.subTest(system=system), tempfile.TemporaryDirectory() as tmp, \
                 patch.object(installer, 'build_intel_macos') as build, \
                 patch.object(installer.urllib.request, 'urlretrieve', side_effect=OSError('network')) as download:
                with self.assertRaises(OSError):
                    installer.install(pathlib.Path(tmp), system, arch)
                self.assertIn(f'nsh-{system}-{arch}', download.call_args.args[0])
                build.assert_not_called()

    def test_moved_tag_fails_before_build(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(installer.subprocess, 'run') as run, \
             patch.object(installer.subprocess, 'check_output', return_value='bad-sha'):
            with self.assertRaisesRegex(RuntimeError, 'revision mismatch'):
                installer.build_intel_macos(pathlib.Path(tmp))
            self.assertEqual(run.call_count, 1)

    def test_build_layout_defaults_lock_and_architecture(self):
        commands = []
        def run(args, **kwargs):
            commands.append(args)
            if args[0] == 'cargo':
                target = pathlib.Path(args[args.index('--target-dir') + 1]) / installer.INTEL_TARGET / 'release'
                target.mkdir(parents=True)
                for relative in installer.MACOS_FILES:
                    output = target / pathlib.Path(relative).name
                    output.write_bytes(b'native fixture')
                    output.chmod(0o755)
        with tempfile.TemporaryDirectory() as tmp, patch.object(installer.subprocess, 'run', side_effect=run), \
             patch.object(installer.subprocess, 'check_output', side_effect=[installer.SOURCE_COMMIT, 'nsh 0.4.0\n']):
            dest = pathlib.Path(tmp)
            installer.build_intel_macos(dest)
            for relative in installer.MACOS_FILES:
                self.assertEqual((dest / 'nsh' / relative).read_bytes(), b'native fixture')
            cargo = next(c for c in commands if c[0] == 'cargo')
            self.assertIn('--locked', cargo)
            self.assertIn(installer.INTEL_TARGET, cargo)
            self.assertNotIn('--no-default-features', cargo)
            self.assertEqual(sum(c[0] == 'lipo' for c in commands), 3)
            for verify in (c for c in commands if c[0] == 'lipo'):
                self.assertEqual(verify[2:], ['-verify_arch', 'x86_64'])
                self.assertTrue(pathlib.Path(verify[1]).name in {'nsh', 'nsh-macos-host', 'nsh-macos-app'})
            self.assertIn(installer.SOURCE_COMMIT, (dest / 'nsh/SOURCE_REVISION').read_text())

    def test_build_failure_propagates(self):
        def run(args, **kwargs):
            if args[0] == 'cargo':
                raise subprocess.CalledProcessError(1, args)
        with tempfile.TemporaryDirectory() as tmp, patch.object(installer.subprocess, 'run', side_effect=run), \
             patch.object(installer.subprocess, 'check_output', return_value=installer.SOURCE_COMMIT):
            with self.assertRaises(subprocess.CalledProcessError):
                installer.build_intel_macos(pathlib.Path(tmp))
            self.assertFalse((pathlib.Path(tmp) / 'nsh/bin/nsh').exists())


if __name__ == '__main__':
    unittest.main()
