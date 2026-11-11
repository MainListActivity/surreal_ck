"""Stub routing only: these tests never boot an emulator or install an APK."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('android-install-smoke.sh').resolve()


@unittest.skipUnless(sys.platform == 'linux', 'Android smoke runs on Linux CI')
class SmokeTests(unittest.TestCase):
    def run_smoke(self, failure=''):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); sdk = root / 'sdk'; bindir = root / 'bin'; bindir.mkdir()
            commands = {
                sdk/'cmdline-tools/latest/bin/sdkmanager': 'exit 0',
                sdk/'cmdline-tools/latest/bin/avdmanager': r'''
cat >/dev/null
while test $# -gt 0; do
  case "$1" in --path) shift; path=$1;; --name) shift; name=$1;; esac
  shift
done
test "$path" = "$ANDROID_AVD_HOME/$name.avd" || exit 9
mkdir -p "$path"
printf 'path=%s\n' "$path" > "$ANDROID_AVD_HOME/$name.ini"
printf 'image.sysdir.1=test-image\n' > "$path/config.ini"
printf '%s\n' "$HOME" "$ANDROID_USER_HOME" "$ANDROID_EMULATOR_HOME" "$ANDROID_AVD_HOME" > "$ANDROID_AVD_HOME/environment"
''',
                sdk/'emulator/emulator': r'''
printf '%s\n' "$HOME" "$ANDROID_USER_HOME" "$ANDROID_EMULATOR_HOME" "$ANDROID_AVD_HOME" > "$ANDROID_AVD_HOME/emulator-environment"
cmp "$ANDROID_AVD_HOME/environment" "$ANDROID_AVD_HOME/emulator-environment" || exit 10
if test "$1" = -list-avds; then
  test "$FAILURE" != invisible || exit 0
  echo surreal-collaboration-ci
  exit 0
fi
test "$2" = surreal-collaboration-ci || exit 11
test "$FAILURE" != boot || { echo 'fixture: emulator boot failed'; exit 12; }
exec /bin/sleep 60
''',
                bindir/'sleep': 'exit 0',
                sdk/'platform-tools/adb': r'''
shift 2
case "$*" in
  'shell getprop sys.boot_completed') if test "$FAILURE" = boot; then /bin/sleep 0.02; else echo 1; fi;;
  install*) test "$FAILURE" != install || exit 7; echo Success;;
  'shell am start'*) echo 'Status: ok';;
  'shell pidof'*) echo 1234;;
  'shell dumpsys activity activities') echo 'mResumedActivity: top.maplayer.collaboration/com.longbridge.nsh.AppActivity';;
  'logcat -d -b crash') if test "$FAILURE" = crash; then echo 'Process: top.maplayer.collaboration'; fi;;
  'exec-out screencap -p') echo 'fixture, not PNG';;
esac
exit 0
''',
            }
            for file, body in commands.items():
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('#!/bin/sh\n'+body+'\n', encoding='utf-8'); file.chmod(0o755)
            apk = root/'fixture.apk'; apk.write_bytes(b'not an actual apk')
            env = os.environ | {'ANDROID_HOME': str(sdk), 'PATH': str(bindir)+os.pathsep+os.environ['PATH'], 'FAILURE': failure, 'RUNNER_TEMP': str(root), 'ANDROID_AVD_HOME': '/must-not-use-parent-avd', 'ANDROID_USER_HOME': '/must-not-use-parent-user'}
            result = subprocess.run(['/bin/bash', str(SCRIPT), str(apk), str(root/'evidence')], env=env, capture_output=True, text=True, timeout=15)
            report = root/'evidence/smoke-result.json'
            evidence = {p.name: p.read_text() for p in (root/'evidence').iterdir() if p.is_file()}
            state_remains = list(root.glob('surreal-android-smoke.*'))
            return result, json.loads(report.read_text()) if report.exists() else None, evidence, state_remains

    def test_success_scope_does_not_claim_business_or_permission_validation(self):
        result, report, evidence, state = self.run_smoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report['install'], 'passed')
        self.assertEqual(state, [])
        self.assertEqual(evidence['avd-list.txt'].strip(), 'surreal-collaboration-ci')
        self.assertIn('avd-config.ini', evidence)
        self.assertIn('final-logcat.txt', evidence)
        self.assertNotIn('/must-not-use-parent', evidence['avd-environment.txt'])
        self.assertEqual(evidence['exit-status.txt'].strip(), '0')
        self.assertFalse(report['permissions_granted_by_test'])
        self.assertFalse(report['update_gate_bypassed'])
        self.assertEqual(report['login_chat_meeting_files_update'], 'not-run')

    def test_install_failure_has_no_success_receipt(self):
        result, report, evidence, state = self.run_smoke('install')
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(report)

    def test_app_crash_has_no_success_receipt(self):
        result, report, evidence, state = self.run_smoke('crash')
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(report)

    def test_invisible_avd_fails_before_install_and_keeps_diagnostics(self):
        result, report, evidence, state = self.run_smoke('invisible')
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(report)
        self.assertNotIn('install.txt', evidence)
        self.assertIn('avd-create.txt', evidence)
        self.assertIn('avd.ini', evidence)
        self.assertEqual(state, [])

    def test_emulator_failure_keeps_log_and_no_success_receipt(self):
        result, report, evidence, state = self.run_smoke('boot')
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(report)
        self.assertIn('emulator.log', evidence)
        self.assertEqual(state, [])


if __name__ == '__main__': unittest.main()
