#!/usr/bin/env python3
"""Classify bounded Android smoke evidence; never dismiss dialogs or infer UI success from a PID."""
import hashlib
import json
from pathlib import Path
import re
import sys

APP = 'top.maplayer.collaboration'


def assess(apk, folder):
    def read(name):
        path = folder/name
        return path.read_text(errors='replace') if path.is_file() else ''
    installed = bool(re.search(r'^Success\s*$', read('install.txt'), re.M))
    launched = read('launch.txt.status').strip() == '0' and bool(re.search(r'^Status: ok\s*$', read('launch.txt'), re.M))
    survived = read('process-survived.txt').strip() == 'passed'
    anr = []
    environment_failures = []
    for name in ('window.txt', 'activity.txt', 'logcat.txt', 'final-logcat.txt', 'crash.txt', 'final-crash.txt', 'ui.xml', 'install.txt'):
        for line in read(name).splitlines():
            if re.search(r"Application Not Responding:|\bANR in\s+\S+|\bam_anr\s*:|isn['’]t responding|is not responding", line, re.I):
                anr.append({'source': name, 'detail': line.strip()[:500]})
            if re.search(r'DeadSystemException|Failure calling service package: Broken pipe', line):
                environment_failures.append({'source': name, 'detail': line.strip()[:500]})
    # A resumed/focused Activity is insufficient: a system ANR can own the window.
    focus = re.findall(r'^\s*mCurrentFocus\s*=\s*(.+)$', read('window.txt') or read('activity.txt'), re.M)
    focus_ok = bool(focus) and any(APP+'/' in value for value in focus)
    focus_ok = focus_ok and all(value.strip() == 'null' or APP+'/' in value for value in focus)
    crash_text = read('crash.txt') + read('final-crash.txt')
    app_crash = bool(re.search(r'Process: top\.maplayer\.collaboration\b|>>> top\.maplayer\.collaboration <<<', crash_text))
    required = ('activity.txt', 'window.txt', 'logcat.txt', 'crash.txt', 'screenshot.png')
    missing = [name for name in required if read(name+'.status').strip() != '0']
    screen = folder/'screenshot.png'
    png = screen.is_file() and screen.read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
    reasons = []
    if not installed: reasons.append('Installation not confirmed')
    if not launched: reasons.append('Activity launch not confirmed')
    if not survived: reasons.append('Process survival after 20 seconds not confirmed')
    if anr: reasons.append('System or application ANR observed; no dialog was dismissed')
    if app_crash: reasons.append('Application crash recorded')
    if environment_failures: reasons.append('Android system/service failure observed; not attributed to an application crash')
    if not focus_ok: reasons.append('Application does not exclusively own the current focused window')
    if missing or not png: reasons.append('Required bounded diagnostics or PNG screenshot unavailable')
    with apk.open('rb') as stream:
        apk_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
    return dict(apk_sha256=apk_hash,
        overall='blocked' if reasons else 'passed',
        install='passed' if installed else 'not-confirmed', launch='passed' if launched else 'not-confirmed',
        process_survived_20_seconds='passed' if survived else 'not-confirmed',
        gui_environment='blocked' if reasons else 'no automated blocker observed; screenshot review required',
        test_profile=json.loads(read('profile.json')) if read('profile.json') else None,
        observed_display_size=read('display-size.txt').strip(), observed_display_density=read('display-density.txt').strip(),
        environment_failure_evidence=environment_failures[:20],
        current_focus=focus, anr_evidence=anr[:20], blockers=reasons, incomplete_diagnostics=missing,
        app_crash_buffer='observed' if app_crash else 'none observed in available evidence',
        permissions_granted_by_test=False, update_gate_bypassed=False, dialogs_dismissed_by_test=False,
        update_gate_ui='not verified; screenshot review required', login_chat_meeting_files_update='not-run')


def main():
    apk, folder = map(Path, sys.argv[1:])
    report = assess(apk, folder)
    (folder/'smoke-result.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report))
    return 0 if report['overall'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
