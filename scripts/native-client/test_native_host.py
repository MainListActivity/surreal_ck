"""Command-routing tests only; they do not run any native API or compile Rust."""
import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT=pathlib.Path(__file__).resolve().parents[2]

class NativeHostTests(unittest.TestCase):
    def run_route(self,target,cpu,system,translated='0',probe=True,symlinks='0',fail_ignored=False):
        with tempfile.TemporaryDirectory() as tmp:
            p=pathlib.Path(tmp);log=p/'commands'
            bodies={'rustc':f'echo "host: {target}"', 'uname':f'if [ "$1" = "-m" ]; then echo "{cpu}"; else echo "{system}"; fi', 'sysctl':f'echo "{translated}"', 'cargo':'printf "%s\\n" "$*" >> "$CALL_LOG"'}
            if fail_ignored:
                bodies['cargo'] += '\ncase "$*" in *--ignored*) exit 17;; esac'
            for name,body in bodies.items():
                f=p/name;f.write_text('#!/bin/sh\n'+body+'\n');f.chmod(0o755)
            script='check-desktop-receive.sh' if probe else 'check-native-host.sh'
            r=subprocess.run(['bash',str(ROOT/'scripts/native-client'/script),target],cwd=ROOT,capture_output=True,text=True,env=os.environ|{'PATH':str(p)+os.pathsep+os.environ['PATH'],'CALL_LOG':str(log),'DESKTOP_RECEIVE_SYMLINK_TESTS':symlinks})
            return r,log.read_text().splitlines() if log.exists() else []

    def test_three_actual_routes(self):
        for triple,cpu,system in [('aarch64-apple-darwin','arm64','Darwin'),('x86_64-apple-darwin','x86_64','Darwin'),('x86_64-pc-windows-msvc','x86_64','MINGW64_NT-10.0')]:
            with self.subTest(triple=triple):
                r,lines=self.run_route(triple,cpu,system)
                self.assertEqual(r.returncode,0,r.stderr)
                self.assertEqual(len(lines),4)
                self.assertTrue(all('--target '+triple in x for x in lines[1:]))
                self.assertFalse(any('--ignored' in x for x in lines))

    def test_windows_explicit_symlink_suite_runs_without_privilege_changes(self):
        r,lines=self.run_route('x86_64-pc-windows-msvc','x86_64','MINGW64_NT-10.0',symlinks='1')
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(len(lines),5)
        self.assertIn('--ignored --nocapture',lines[3])
        self.assertNotIn('were NOT run',r.stdout)
        self.assertIn('Candidate source commit:',r.stdout)
        self.assertIn('Cross-user isolation',r.stdout)

    def test_symlink_failure_is_not_skipped_or_reported_as_success(self):
        r,lines=self.run_route('x86_64-pc-windows-msvc','x86_64','MINGW64_NT-10.0',symlinks='1',fail_ignored=True)
        self.assertEqual(r.returncode,17)
        self.assertEqual(len(lines),4)
        self.assertNotIn('commands finished',r.stdout)

    def test_invalid_symlink_opt_in_stops_before_cargo(self):
        for triple,cpu,system,setting in [('aarch64-apple-darwin','arm64','Darwin','1'),('x86_64-pc-windows-msvc','x86_64','MINGW64_NT-10.0','yes')]:
            with self.subTest(triple=triple,setting=setting):
                r,lines=self.run_route(triple,cpu,system,symlinks=setting)
                self.assertEqual(r.returncode,2)
                self.assertEqual(lines,[])

    def test_wrong_cpu_os_and_rosetta_stop_before_cargo(self):
        for cpu,system,translated in [('x86_64','Darwin','0'),('arm64','Linux','0'),('arm64','Darwin','1')]:
            with self.subTest(cpu=cpu,system=system,translated=translated):
                r,lines=self.run_route('aarch64-apple-darwin',cpu,system,translated)
                self.assertNotEqual(r.returncode,0)
                self.assertEqual(lines,[])

if __name__=='__main__':unittest.main()
