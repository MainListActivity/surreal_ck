#!/usr/bin/env bash
# Isolated CI install/start only. No permissions, authentication or update-gate bypass.
set -euo pipefail
apk=${1:?usage: android-install-smoke.sh APK EVIDENCE_DIR}
evidence=${2:?evidence directory required}
mkdir -p "$evidence"
apk=$(realpath "$apk")
evidence=$(realpath "$evidence")
sha256sum "$apk" > "$evidence/input-sha256.txt"
: "${ANDROID_HOME:?preinstalled Android SDK required}"
adb="$ANDROID_HOME/platform-tools/adb"
emulator="$ANDROID_HOME/emulator/emulator"
serial=emulator-5580
sdkmanager="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
avdmanager="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
# Keep all mutable AVD state in one explicit, isolated directory. Do not rely on
# avdmanager/emulator's different HOME and ANDROID_* fallback rules.
state=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/surreal-android-smoke.XXXXXX")
export HOME="$state/home"
export ANDROID_USER_HOME="$state/user"
export ANDROID_EMULATOR_HOME="$state/emulator"
export ANDROID_AVD_HOME="$state/avd"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
mkdir -p "$HOME" "$ANDROID_USER_HOME" "$ANDROID_EMULATOR_HOME" "$ANDROID_AVD_HOME"
avd_name=surreal-collaboration-ci
avd_path="$ANDROID_AVD_HOME/$avd_name.avd"
emulator_pid=''
cleanup() {
  result=$?
  trap - EXIT
  set +e
  printf '%s\n' "$result" > "$evidence/exit-status.txt"
  # Small diagnostics only. Never upload writable images, SDKs or emulator keys.
  if [[ -f "$ANDROID_AVD_HOME/$avd_name.ini" ]]; then
    cp "$ANDROID_AVD_HOME/$avd_name.ini" "$evidence/avd.ini"
  fi
  if [[ -f "$avd_path/config.ini" ]]; then cp "$avd_path/config.ini" "$evidence/avd-config.ini"; fi
  if [[ -n "$emulator_pid" ]]; then
    timeout 10 "$adb" devices -l > "$evidence/final-devices.txt" 2>&1
    timeout 10 "$adb" -s "$serial" shell getprop > "$evidence/final-properties.txt" 2>&1
    timeout 10 "$adb" -s "$serial" logcat -d -t 1000 > "$evidence/final-logcat.txt" 2>&1
    timeout 10 "$adb" -s "$serial" logcat -d -b crash > "$evidence/final-crash.txt" 2>&1
    timeout 10 "$adb" -s "$serial" emu kill >/dev/null 2>&1
    kill "$emulator_pid" 2>/dev/null
    for attempt in {1..5}; do
      kill -0 "$emulator_pid" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null
  fi
  # This directory was created by this invocation, outside the evidence folder.
  rm -rf -- "$state"
  exit "$result"
}
trap cleanup EXIT
printf 'AVD_NAME=%s\nAVD_PATH=%s\nANDROID_AVD_HOME=%s\nANDROID_USER_HOME=%s\nANDROID_EMULATOR_HOME=%s\nHOME=%s\n' \
  "$avd_name" "$avd_path" "$ANDROID_AVD_HOME" "$ANDROID_USER_HOME" "$ANDROID_EMULATOR_HOME" "$HOME" > "$evidence/avd-environment.txt"
image='system-images;android-35;google_apis;x86_64'
"$sdkmanager" emulator "$image" > "$evidence/sdk-setup.txt" 2>&1
printf 'no\n' | "$avdmanager" create avd --name "$avd_name" --path "$avd_path" --package "$image" --device pixel_7 > "$evidence/avd-create.txt" 2>&1
"$emulator" -list-avds > "$evidence/avd-list.txt" 2> "$evidence/avd-list-stderr.txt"
grep -Fxq "$avd_name" "$evidence/avd-list.txt" || { echo 'Created AVD is not visible to emulator; inspect AVD diagnostics'; exit 1; }
[[ -f "$ANDROID_AVD_HOME/$avd_name.ini" && -f "$avd_path/config.ini" ]] || { echo 'Isolated AVD metadata is missing'; exit 1; }
accel=off
if [[ -r /dev/kvm && -w /dev/kvm ]]; then accel=on; fi
printf 'Acceleration: %s; existing KVM access only, no permission changes\n' "$accel" | tee "$evidence/scope.txt"
"$emulator" -avd "$avd_name" -port 5580 -no-snapshot -no-window -noaudio \
  -no-boot-anim -camera-back none -camera-front none -gpu swiftshader_indirect \
  -memory 2048 -accel "$accel" > "$evidence/emulator.log" 2>&1 &
emulator_pid=$!
booted=false
for ((attempt=0; attempt<180; attempt++)); do
  kill -0 "$emulator_pid" 2>/dev/null || { echo 'Emulator exited before boot'; exit 1; }
  if [[ $(timeout 10 "$adb" -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r') == 1 ]]; then
    booted=true; break
  fi
  sleep 5
done
[[ "$booted" == true ]] || { echo 'Emulator did not boot within 15 minutes'; exit 1; }
timeout 300 "$adb" -s "$serial" install --no-streaming "$apk" 2>&1 | tee "$evidence/install.txt"
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
