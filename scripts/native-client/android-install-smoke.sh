#!/usr/bin/env bash
# Isolated CI install/start only. No permissions, authentication or update-gate bypass.
set -euo pipefail
apk=${1:?usage: android-install-smoke.sh APK EVIDENCE_DIR}
evidence=${2:?evidence directory required}
mkdir -p "$evidence"
apk=$(realpath "$apk")
evidence=$(realpath "$evidence")
: "${ANDROID_HOME:?preinstalled Android SDK required}"
adb="$ANDROID_HOME/platform-tools/adb"
emulator="$ANDROID_HOME/emulator/emulator"
serial=emulator-5580
sdkmanager="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
avdmanager="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
image='system-images;android-35;google_apis;x86_64'
"$sdkmanager" emulator "$image"
printf 'no\n' | "$avdmanager" create avd --name surreal-collaboration-ci --package "$image" --device pixel_7
accel=off
if [[ -r /dev/kvm && -w /dev/kvm ]]; then accel=on; fi
printf 'Acceleration: %s; existing KVM access only, no permission changes\n' "$accel" | tee "$evidence/scope.txt"
"$emulator" -avd surreal-collaboration-ci -port 5580 -no-snapshot -no-window -noaudio \
  -no-boot-anim -camera-back none -camera-front none -gpu swiftshader_indirect \
  -memory 2048 -accel "$accel" > "$evidence/emulator.log" 2>&1 &
emulator_pid=$!
cleanup() {
  "$adb" -s "$serial" emu kill >/dev/null 2>&1 || true
  kill "$emulator_pid" 2>/dev/null || true
}
trap cleanup EXIT
booted=false
for ((attempt=0; attempt<180; attempt++)); do
  kill -0 "$emulator_pid" 2>/dev/null || { echo 'Emulator exited before boot'; exit 1; }
  if [[ $("$adb" -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r') == 1 ]]; then
    booted=true; break
  fi
  sleep 5
done
[[ "$booted" == true ]] || { echo 'Emulator did not boot within 15 minutes'; exit 1; }
timeout 300 "$adb" -s "$serial" install --no-streaming "$apk" | tee "$evidence/install.txt"
grep -q '^Success' "$evidence/install.txt"
"$adb" -s "$serial" shell dumpsys package top.maplayer.collaboration > "$evidence/package.txt"
"$adb" -s "$serial" logcat -c
"$adb" -s "$serial" shell am start -W -n top.maplayer.collaboration/com.longbridge.nsh.AppActivity > "$evidence/launch.txt"
grep -q 'Status: ok' "$evidence/launch.txt"
sleep 20
"$adb" -s "$serial" shell pidof top.maplayer.collaboration | tee "$evidence/pid.txt"
test -s "$evidence/pid.txt"
"$adb" -s "$serial" logcat -d -b crash > "$evidence/crash.txt"
if grep -Eq 'Process: top\.maplayer\.collaboration|>>> top\.maplayer\.collaboration <<<' "$evidence/crash.txt"; then
  echo 'Application crash recorded'; exit 1
fi
"$adb" -s "$serial" shell dumpsys activity activities > "$evidence/activity.txt"
grep -E 'mResumedActivity|topResumedActivity' "$evidence/activity.txt" | grep -q 'top.maplayer.collaboration'
"$adb" -s "$serial" exec-out screencap -p > "$evidence/screenshot.png"
"$adb" -s "$serial" shell uiautomator dump /sdcard/surreal-collaboration-ci.xml > "$evidence/ui-dump.txt" 2>&1 || true
"$adb" -s "$serial" pull /sdcard/surreal-collaboration-ci.xml "$evidence/ui.xml" >> "$evidence/ui-dump.txt" 2>&1 || true
python - "$apk" "$evidence" <<'PY'
import hashlib,json,pathlib,sys
apk,folder=map(pathlib.Path,sys.argv[1:])
report=dict(apk_sha256=hashlib.sha256(apk.read_bytes()).hexdigest(), install='passed', launch='passed',
    process_survived_20_seconds='passed', app_crash_buffer='none observed',
    permissions_granted_by_test=False, update_gate_bypassed=False,
    update_gate_ui='requires screenshot review', login_chat_meeting_files_update='not-run')
(folder/'smoke-result.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report))
PY
