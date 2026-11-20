#!/usr/bin/env bash
# Isolated CI install/start only. No permissions, authentication or update-gate bypass.
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd)
# Reserve 150 seconds for cleanup/evidence within the 40-minute CI job.
started=$SECONDS
work_deadline=$((started + 2250))
boot_budget=${ANDROID_SMOKE_BOOT_TIMEOUT_SECONDS:-1800}
[[ "$boot_budget" =~ ^[0-9]+$ ]] && ((boot_budget >= 1 && boot_budget <= 1800)) || { echo 'Boot budget must be 1..1800 seconds'; exit 2; }
bounded() {
  local limit=$1 remaining=$((work_deadline - SECONDS))
  shift
  ((remaining > 0)) || { echo 'Smoke work deadline reached; collecting diagnostics' >&2; return 124; }
  if ((limit > remaining)); then limit=$remaining; fi
  timeout --kill-after=2s "$limit" "$@"
}
capture() {
  local name=$1 limit=$2 status=0
  shift 2
  bounded "$limit" "$@" > "$evidence/$name" 2>&1 || status=$?
  printf '%s\n' "$status" > "$evidence/$name.status"
  return 0
}
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
    timeout --kill-after=2s 10 "$adb" devices -l > "$evidence/final-devices.txt" 2>&1
    timeout --kill-after=2s 10 "$adb" -s "$serial" shell getprop > "$evidence/final-properties.txt" 2>&1
    timeout --kill-after=2s 10 "$adb" -s "$serial" logcat -d -t 1000 > "$evidence/final-logcat.txt" 2>&1
    timeout --kill-after=2s 10 "$adb" -s "$serial" logcat -d -b crash > "$evidence/final-crash.txt" 2>&1
    if [[ ! -f "$evidence/window.txt" ]]; then
      timeout --kill-after=2s 10 "$adb" -s "$serial" shell dumpsys window windows > "$evidence/window.txt" 2>&1
      printf '%s\n' "$?" > "$evidence/window.txt.status"
    fi
    if [[ ! -f "$evidence/screenshot.png" ]]; then
      timeout --kill-after=2s 10 "$adb" -s "$serial" exec-out screencap -p > "$evidence/screenshot.png" 2> "$evidence/screenshot-stderr.txt"
      printf '%s\n' "$?" > "$evidence/screenshot.png.status"
    fi
    timeout --kill-after=2s 10 "$adb" -s "$serial" emu kill >/dev/null 2>&1
    kill "$emulator_pid" 2>/dev/null
    for attempt in {1..5}; do
      kill -0 "$emulator_pid" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null
  fi
  # Always retain a partial result. An installed/launched app is not a GUI pass
  # when a system dialog owns focus or an ANR appears in the retained evidence.
  python "$script_dir/android-smoke-result.py" "$apk" "$evidence"
  assessment=$?
  if ((result == 0 && assessment != 0)); then result=$assessment; fi
  printf '%s\n' "$result" > "$evidence/exit-status.txt"
  # This directory was created by this invocation, outside the evidence folder.
  rm -rf -- "$state"
  exit "$result"
}
trap cleanup EXIT
printf 'AVD_NAME=%s\nAVD_PATH=%s\nANDROID_AVD_HOME=%s\nANDROID_USER_HOME=%s\nANDROID_EMULATOR_HOME=%s\nHOME=%s\n' \
  "$avd_name" "$avd_path" "$ANDROID_AVD_HOME" "$ANDROID_USER_HOME" "$ANDROID_EMULATOR_HOME" "$HOME" > "$evidence/avd-environment.txt"
profile=${ANDROID_SMOKE_PROFILE:-google-api35}
display_args=()
case "$profile" in
  google-api35) image='system-images;android-35;google_apis;x86_64' ;;
  aosp-api35-low-resolution)
    image='system-images;android-35;default;x86_64'
    display_args=(-skin 320x640) ;;
  *) echo 'Unsupported ANDROID_SMOKE_PROFILE; use google-api35 or aosp-api35-low-resolution' >&2; exit 2 ;;
esac
bounded 300 "$sdkmanager" emulator "$image" > "$evidence/sdk-setup.txt" 2>&1
printf 'no\n' | bounded 60 "$avdmanager" create avd --name "$avd_name" --path "$avd_path" --package "$image" --device pixel_7 > "$evidence/avd-create.txt" 2>&1
# Change only the AVD this invocation created. No arbitrary image or emulator args.
python - "$profile" "$image" "$avd_path/config.ini" "$evidence/profile.json" <<'PYPROFILE'
import json,pathlib,sys
profile,image,config_path,output=sys.argv[1:]
path=pathlib.Path(config_path)
lines=path.read_text().splitlines()
if profile == 'aosp-api35-low-resolution':
    values={'hw.lcd.width':'320','hw.lcd.height':'640','hw.lcd.density':'160'}
    lines=[line for line in lines if line.partition('=')[0].strip() not in values]
    lines.extend(key+'='+value for key,value in values.items())
    path.write_text('\n'.join(lines)+'\n')
config={key.strip():value.strip() for line in lines for key,sep,value in [line.partition('=')] if sep}
record=dict(profile=profile, image=image, device='pixel_7',
    display_config={key:config.get(key) for key in ('hw.lcd.width','hw.lcd.height','hw.lcd.density')},
    emulator_display_arguments=['-skin','320x640'] if profile == 'aosp-api35-low-resolution' else [],
    scope='Selected test environment only; not a claim of runtime validation')
pathlib.Path(output).write_text(json.dumps(record,indent=2)+'\n')
PYPROFILE
bounded 20 "$emulator" -list-avds > "$evidence/avd-list.txt" 2> "$evidence/avd-list-stderr.txt"
grep -Fxq "$avd_name" "$evidence/avd-list.txt" || { echo 'Created AVD is not visible to emulator; inspect AVD diagnostics'; exit 1; }
[[ -f "$ANDROID_AVD_HOME/$avd_name.ini" && -f "$avd_path/config.ini" ]] || { echo 'Isolated AVD metadata is missing'; exit 1; }
accel=off
if [[ -r /dev/kvm && -w /dev/kvm ]]; then accel=on; fi
printf 'Acceleration: %s; existing KVM access only, no permission changes\n' "$accel" | tee "$evidence/scope.txt"
"$emulator" -avd "$avd_name" -port 5580 -no-snapshot -no-window -noaudio \
  -no-boot-anim -camera-back none -camera-front none -gpu swiftshader_indirect \
  -memory 2048 -accel "$accel" "${display_args[@]}" > "$evidence/emulator.log" 2>&1 &
emulator_pid=$!
booted=false
boot_started=$SECONDS
boot_deadline=$((boot_started + boot_budget))
if ((boot_deadline > work_deadline)); then boot_deadline=$work_deadline; fi
printf 'boot_limit_seconds=%s\nwork_limit_seconds=2250\nimage=%s\ndevice=pixel_7\n' "$((boot_deadline - boot_started))" "$image" > "$evidence/timing.txt"
while ((SECONDS < boot_deadline)); do
  kill -0 "$emulator_pid" 2>/dev/null || { echo 'Emulator exited before boot'; exit 1; }
  remaining=$((boot_deadline - SECONDS))
  poll_limit=10
  if ((remaining < poll_limit)); then poll_limit=$remaining; fi
  boot=$(bounded "$poll_limit" "$adb" -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r') || boot=''
  printf 'elapsed_seconds=%s boot_completed=%s\n' "$((SECONDS - boot_started))" "$boot" >> "$evidence/boot-poll.txt"
  if [[ "$boot" == 1 ]]; then booted=true; break; fi
  remaining=$((boot_deadline - SECONDS))
  ((remaining > 0)) || break
  pause=5
  if ((remaining < pause)); then pause=$remaining; fi
  sleep "$pause"
done
[[ "$booted" == true ]] || { echo "Emulator did not boot within its recorded wall-clock limit (${boot_budget}s requested, maximum 30 minutes)"; exit 1; }
capture display-size.txt 10 "$adb" -s "$serial" shell wm size
capture display-density.txt 10 "$adb" -s "$serial" shell wm density
bounded 300 "$adb" -s "$serial" install --no-streaming "$apk" 2>&1 | tee "$evidence/install.txt"
grep -q '^Success' "$evidence/install.txt"
capture package.txt 20 "$adb" -s "$serial" shell dumpsys package top.maplayer.collaboration
bounded 10 "$adb" -s "$serial" logcat -c
capture launch.txt 120 "$adb" -s "$serial" shell am start -W -n top.maplayer.collaboration/com.longbridge.nsh.AppActivity
# Diagnostics (including the screenshot) must be collected even when launch,
# survival or ANR checks fail. Never dismiss a blocking system/app dialog.
if grep -q 'Status: ok' "$evidence/launch.txt"; then
  bounded 25 sleep 20
  capture pid.txt 10 "$adb" -s "$serial" shell pidof top.maplayer.collaboration
  if [[ $(cat "$evidence/pid.txt.status") == 0 ]] && grep -Eq '^[0-9]+( [0-9]+)*$' "$evidence/pid.txt"; then
    printf 'passed\n' > "$evidence/process-survived.txt"
  fi
fi
capture crash.txt 15 "$adb" -s "$serial" logcat -d -b crash
capture activity.txt 20 "$adb" -s "$serial" shell dumpsys activity activities
capture window.txt 20 "$adb" -s "$serial" shell dumpsys window windows
capture logcat.txt 15 "$adb" -s "$serial" logcat -d -t 2000
# exec-out output is binary; keep stderr separate from PNG bytes.
screen_status=0
bounded 15 "$adb" -s "$serial" exec-out screencap -p > "$evidence/screenshot.png" 2> "$evidence/screenshot-stderr.txt" || screen_status=$?
printf '%s\n' "$screen_status" > "$evidence/screenshot.png.status"
capture ui-dump.txt 20 "$adb" -s "$serial" shell uiautomator dump /sdcard/surreal-collaboration-ci.xml
capture ui-pull.txt 15 "$adb" -s "$serial" pull /sdcard/surreal-collaboration-ci.xml "$evidence/ui.xml"
# The EXIT handler collects final logs and writes a passed/partial report.
