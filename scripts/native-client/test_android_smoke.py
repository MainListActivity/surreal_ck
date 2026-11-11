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
                sdk/'cmdline-tools/latest/bin/avdmanager': 'cat >/dev/null',
                sdk/'emulator/emulator': 'exec /bin/sleep 60',
                bindir/'sleep': 'exit 0',
                sdk/'platform-tools/adb': r'''
shift 2
case "$*" in
  'shell getprop sys.boot_completed') echo 1;;
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
            env = os.environ | {'ANDROID_HOME': str(sdk), 'PATH': str(bindir)+os.pathsep+os.environ['PATH'], 'FAILURE': failure}
            result = subprocess.run(['/bin/bash', str(SCRIPT), str(apk), str(root/'evidence')], env=env, capture_output=True, text=True, timeout=15)
            report = root/'evidence/smoke-result.json'
            return result, json.loads(report.read_text()) if report.exists() else None

    def test_success_scope_does_not_claim_business_or_permission_validation(self):
        result, report = self.run_smoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report['install'], 'passed')
        self.assertFalse(report['permissions_granted_by_test'])
        self.assertFalse(report['update_gate_bypassed'])
        self.assertEqual(report['login_chat_meeting_files_update'], 'not-run')

    def test_install_failure_has_no_success_receipt(self):
        result, report = self.run_smoke('install')
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(report)

    def test_app_crash_has_no_success_receipt(self):
        result, report = self.run_smoke('crash')
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(report)


if __name__ == '__main__': unittest.main()
