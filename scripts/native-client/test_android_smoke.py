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
    def run_smoke(self, failure='', profile=None):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); sdk = root / 'sdk'; bindir = root / 'bin'; bindir.mkdir()
            commands = {
                sdk/'cmdline-tools/latest/bin/sdkmanager': 'printf "%s\\n" "$*"; exit 0',
                sdk/'cmdline-tools/latest/bin/avdmanager': r'''
cat >/dev/null
while test $# -gt 0; do
  case "$1" in --path) shift; path=$1;; --name) shift; name=$1;; esac
  shift
done
test "$path" = "$ANDROID_AVD_HOME/$name.avd" || exit 9
mkdir -p "$path"
printf 'path=%s\n' "$path" > "$ANDROID_AVD_HOME/$name.ini"
printf 'image.sysdir.1=test-image\nhw.lcd.width=1080\nhw.lcd.height=2400\nhw.lcd.density=420\n' > "$path/config.ini"
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
printf '%s\n' "$*"
test "$FAILURE" != boot || { echo 'fixture: emulator boot failed'; exit 12; }
exec /bin/sleep 60
''',
                bindir/'sleep': 'exit 0',
                bindir/'timeout': r'''
case "$*" in
  *'shell am start'*) printf '%s\n' "$*" > "$TIMEOUT_LOG"; if test "$FAILURE" = launch_timeout; then exit 124; fi;;
esac
exec /usr/bin/timeout "$@"
''',
                sdk/'platform-tools/adb': r'''
shift 2
case "$*" in
  'shell getprop sys.boot_completed') if test "$FAILURE" = boot; then /bin/sleep 0.02; elif test "$FAILURE" = boot_timeout; then /bin/sleep 10; else echo 1; fi;;
  install*)
    if test "$FAILURE" = dead_system; then echo 'cmd: Failure calling service package: Broken pipe (32)'; exit 224; fi
    test "$FAILURE" != install || exit 7; echo Success;;
  'shell am start'*) echo 'Status: ok';;
  'shell pidof'*) echo 1234;;
  'shell dumpsys activity activities')
    echo 'topResumedActivity=ActivityRecord{541ab10 u0 top.maplayer.collaboration/com.longbridge.nsh.AppActivity t8}'
    if test "$FAILURE" = system_anr; then echo 'mCurrentFocus=Window{b76922d u0 Application Not Responding: com.android.systemui}'; fi;;
  'shell dumpsys window windows')
    if test "$FAILURE" = system_anr; then
      echo 'mCurrentFocus=Window{b76922d u0 Application Not Responding: com.android.systemui}'
      echo 'mFocusedApp=ActivityRecord{541ab10 u0 top.maplayer.collaboration/com.longbridge.nsh.AppActivity t8}'
    elif test "$FAILURE" = foreign_focus; then echo 'mCurrentFocus=Window{123 u0 com.android.launcher3/Launcher}'
    elif test "$FAILURE" != missing_focus; then echo 'mCurrentFocus=Window{123 u0 top.maplayer.collaboration/com.longbridge.nsh.AppActivity}'; fi;;
  'logcat -d -t 2000')
    if test "$FAILURE" = app_anr; then echo '11-11 06:56:33.331 1777 3994 E ActivityManager: ANR in top.maplayer.collaboration'; fi
    if test "$FAILURE" = gms_anr; then echo '11-11 06:56:33.331 1777 3994 E ActivityManager: ANR in com.google.android.gms.persistent'; fi;;
  'logcat -d -b crash') if test "$FAILURE" = crash; then echo 'Process: top.maplayer.collaboration'; fi
    if test "$FAILURE" = dead_system; then echo 'Process: com.android.systemui'; echo 'android.os.DeadSystemException'; fi;;
  'exec-out screencap -p') printf '\211PNG\r\n\032\nfixture, not a rendered screenshot';;
esac
exit 0
''',
            }
            for file, body in commands.items():
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('#!/bin/sh\n'+body+'\n', encoding='utf-8'); file.chmod(0o755)
            apk = root/'fixture.apk'; apk.write_bytes(b'not an actual apk')
            env = os.environ | {'ANDROID_HOME': str(sdk), 'PATH': str(bindir)+os.pathsep+os.environ['PATH'], 'FAILURE': failure, 'TIMEOUT_LOG': str(root/'timeout.log'), 'ANDROID_SMOKE_BOOT_TIMEOUT_SECONDS': '1' if failure == 'boot_timeout' else '1800', 'RUNNER_TEMP': str(root), 'ANDROID_AVD_HOME': '/must-not-use-parent-avd', 'ANDROID_USER_HOME': '/must-not-use-parent-user'}
            env.pop('ANDROID_SMOKE_PROFILE', None)
            if profile is not None: env['ANDROID_SMOKE_PROFILE'] = profile
            result = subprocess.run(['/bin/bash', str(SCRIPT), str(apk), str(root/'evidence')], env=env, capture_output=True, text=True, timeout=15)
            report = root/'evidence/smoke-result.json'
            evidence = {p.name: p.read_text(errors='replace') for p in (root/'evidence').iterdir() if p.is_file()}
            state_remains = list(root.glob('surreal-android-smoke.*'))
            return result, json.loads(report.read_text()) if report.exists() else None, evidence, state_remains

    def test_success_scope_does_not_claim_business_or_permission_validation(self):
        result, report, evidence, state = self.run_smoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report['install'], 'passed')
        self.assertEqual(report['overall'], 'passed')
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
        self.assertEqual(report['overall'], 'blocked')

    def test_app_crash_has_no_success_receipt(self):
        result, report, evidence, state = self.run_smoke('crash')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(report['overall'], 'blocked')

    def test_invisible_avd_fails_before_install_and_keeps_diagnostics(self):
        result, report, evidence, state = self.run_smoke('invisible')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(report['overall'], 'blocked')
        self.assertNotIn('install.txt', evidence)
        self.assertIn('avd-create.txt', evidence)
        self.assertIn('avd.ini', evidence)
        self.assertEqual(state, [])

    def test_emulator_failure_keeps_log_and_no_success_receipt(self):
        result, report, evidence, state = self.run_smoke('boot')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(report['overall'], 'blocked')
        self.assertIn('emulator.log', evidence)
        self.assertEqual(state, [])

    def test_real_system_ui_anr_shape_retains_install_launch_and_screenshot(self):
        result, report, evidence, state = self.run_smoke('system_anr')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(report['overall'], 'blocked')
        self.assertEqual(report['install'], 'passed')
        self.assertEqual(report['launch'], 'passed')
        self.assertEqual(report['gui_environment'], 'blocked')
        self.assertTrue(report['anr_evidence'])
        self.assertIn('screenshot.png', evidence)
        self.assertIn('final-logcat.txt', evidence)
        self.assertFalse(report['dialogs_dismissed_by_test'])
        self.assertEqual(state, [])

    def test_app_and_background_system_anr_are_not_success(self):
        for failure in ('app_anr', 'gms_anr'):
            with self.subTest(failure=failure):
                result, report, evidence, _ = self.run_smoke(failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(report['anr_evidence'])
                self.assertEqual(report['install'], 'passed')
                self.assertIn('screenshot.png', evidence)

    def test_missing_or_foreign_focus_is_not_success_despite_resumed_activity(self):
        for failure in ('missing_focus', 'foreign_focus'):
            with self.subTest(failure=failure):
                result, report, _, _ = self.run_smoke(failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(report['gui_environment'], 'blocked')

    def test_boot_wall_clock_timeout_preserves_partial_result(self):
        result, report, evidence, _ = self.run_smoke('boot_timeout')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('wall-clock limit', result.stdout)
        self.assertEqual(report['install'], 'not-confirmed')
        self.assertIn('boot_limit_seconds=1', evidence['timing.txt'])

    def test_launch_timeout_preserves_install_and_collects_screenshot(self):
        result, report, evidence, _ = self.run_smoke('launch_timeout')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(report['install'], 'passed')
        self.assertEqual(report['launch'], 'not-confirmed')
        self.assertEqual(evidence['launch.txt.status'].strip(), '124')
        self.assertIn('screenshot.png', evidence)

    def test_default_google_profile_and_display_are_unchanged(self):
        result, report, evidence, _ = self.run_smoke()
        self.assertEqual(result.returncode, 0)
        selected = json.loads(evidence['profile.json'])
        self.assertEqual(selected['profile'], 'google-api35')
        self.assertEqual(selected['image'], 'system-images;android-35;google_apis;x86_64')
        self.assertEqual(selected['display_config']['hw.lcd.width'], '1080')
        self.assertEqual(selected['emulator_display_arguments'], [])
        self.assertNotIn('-skin', evidence['emulator.log'])

    def test_aosp_profile_is_fixed_and_modifies_only_temporary_avd(self):
        result, report, evidence, state = self.run_smoke(profile='aosp-api35-low-resolution')
        self.assertEqual(result.returncode, 0, result.stderr)
        selected = report['test_profile']
        self.assertEqual(selected['image'], 'system-images;android-35;default;x86_64')
        self.assertIn(selected['image'], evidence['sdk-setup.txt'])
        self.assertEqual(selected['display_config'], {'hw.lcd.width':'320','hw.lcd.height':'640','hw.lcd.density':'160'})
        self.assertIn('-skin 320x640', evidence['emulator.log'])
        self.assertIn('hw.lcd.density=160', evidence['avd-config.ini'])
        self.assertNotIn('hw.lcd.density=420', evidence['avd-config.ini'])
        self.assertEqual(state, [])

    def test_invalid_profile_is_rejected_before_sdk_commands(self):
        for profile in ('unknown', 'aosp-api35-low-resolution; echo unsafe'):
            with self.subTest(profile=profile):
                result, report, evidence, _ = self.run_smoke(profile=profile)
                self.assertEqual(result.returncode, 2)
                self.assertNotIn('sdk-setup.txt', evidence)
                self.assertEqual(report['overall'], 'blocked')

    def test_aosp_retains_the_same_anr_failure_standard(self):
        result, report, evidence, _ = self.run_smoke('system_anr', profile='aosp-api35-low-resolution')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(report['install'], 'passed')
        self.assertEqual(report['gui_environment'], 'blocked')
        self.assertTrue(report['anr_evidence'])
        self.assertIn('screenshot.png', evidence)

    def test_package_broken_pipe_and_dead_system_are_environment_failure(self):
        result, report, evidence, _ = self.run_smoke('dead_system')
        self.assertEqual(result.returncode, 224)
        self.assertEqual(report['install'], 'not-confirmed')
        self.assertEqual(report['launch'], 'not-confirmed')
        self.assertTrue(report['environment_failure_evidence'])
        self.assertEqual(report['app_crash_buffer'], 'none observed in available evidence')
        self.assertIn('screenshot.png', evidence)


if __name__ == '__main__': unittest.main()
