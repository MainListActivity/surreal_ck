#!/usr/bin/env bash
# 启动隔离的测试AVD，安装已有APK并检查首次启动；不授予权限或执行更新。
set -euo pipefail
: "${ANDROID_HOME:?Set ANDROID_HOME}"
: "${ANDROID_AVD_HOME:?Set ANDROID_AVD_HOME}"
: "${XDG_RUNTIME_DIR:?Set a writable XDG_RUNTIME_DIR}"
APK=$(realpath "${1:?APK path required}")
OUT=$(realpath -m "${2:?Evidence directory required}")
AVD=${3:-surreal-client}
PORT=${ANDROID_EMULATOR_PORT:-5560}
BOOT_SECONDS=${ANDROID_BOOT_TIMEOUT_SECONDS:-1800}
SERIAL="emulator-$PORT"
mkdir -p "$OUT" "$XDG_RUNTIME_DIR"
sha256sum "$APK" > "$OUT/input-sha256.txt"
ADB="$ANDROID_HOME/platform-tools/adb"
timeout 8 "$ADB" start-server
"$ANDROID_HOME/emulator/emulator" -avd "$AVD" -port "$PORT" -no-metrics -read-only -no-window -no-audio -no-boot-anim -no-snapshot -accel off -gpu swiftshader -cores 2 -memory 2048 > "$OUT/emulator.log" 2>&1 &
EMU=$!
cleanup() { kill "$EMU" 2>/dev/null || true; sleep 2; kill -9 "$EMU" 2>/dev/null || true; }
trap cleanup EXIT
booted=false
stable=0
deadline=$((SECONDS + BOOT_SECONDS))
attempt=0
while [ "$SECONDS" -lt "$deadline" ]; do
    attempt=$((attempt + 1))
    sleep 10
    timeout 8 "$ADB" devices -l > "$OUT/devices.txt"
    boot=$(timeout 8 "$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)
    printf 'boot attempt %s: %s\n' "$attempt" "$boot"
    package=$(timeout 8 "$ADB" -s "$SERIAL" shell service check package 2>/dev/null || true)
    activity=$(timeout 8 "$ADB" -s "$SERIAL" shell service check activity 2>/dev/null || true)
    printf 'services: %s; %s\n' "$package" "$activity" >> "$OUT/service-readiness.txt"
    if [ "$boot" = 1 ] && [[ "$package" == *": found"* ]] && [[ "$activity" == *": found"* ]]; then
        stable=$((stable + 1))
        if [ "$stable" -ge 3 ]; then booted=true; break; fi
    else stable=0; fi
    if ! kill -0 "$EMU" 2>/dev/null; then echo 'Emulator exited before boot' >&2; exit 2; fi
done
if [ "$booted" != true ]; then timeout 8 "$ADB" -s "$SERIAL" shell getprop > "$OUT/boot-properties.txt" 2>&1 || true; timeout 8 "$ADB" -s "$SERIAL" logcat -d -t 4000 > "$OUT/boot-logcat.txt" 2>&1 || true; echo 'Emulator did not complete boot; APK not installed' >&2; exit 3; fi
# No -g, shell pm grant, install-source authorization, accessibility, or root.
timeout 8 "$ADB" -s "$SERIAL" shell pm path top.maplayer.collaboration > "$OUT/package-before.txt" 2>&1 || true
set +e
timeout "${ANDROID_INSTALL_TIMEOUT_SECONDS:-600}" stdbuf -oL "$ADB" -s "$SERIAL" install --no-streaming -r "$APK" 2>&1 | tee "$OUT/install.txt"
install_status=${PIPESTATUS[0]}
set -e
printf '%s\n' "$install_status" > "$OUT/install-status.txt"
timeout 8 "$ADB" -s "$SERIAL" shell pm path top.maplayer.collaboration > "$OUT/package-after.txt" 2>&1 || true
timeout 8 "$ADB" -s "$SERIAL" logcat -d -t 4000 > "$OUT/install-logcat.txt" 2>&1 || true
if [ "$install_status" -ne 0 ]; then echo 'Install did not report success; inspect package-after and logs' >&2; exit 5; fi
# Diagnostic failures must not discard the more useful next piece of evidence.
set +e
timeout 8 "$ADB" -s "$SERIAL" logcat -c
timeout 120 "$ADB" -s "$SERIAL" shell am start -W -n top.maplayer.collaboration/com.longbridge.nsh.AppActivity > "$OUT/launch.txt" 2>&1
printf '%s\n' "$?" > "$OUT/launch-status.txt"
# TCG can take minutes to initialize Android/NSH even after am's own wait times out.
sleep 120
timeout 8 "$ADB" -s "$SERIAL" shell pidof top.maplayer.collaboration > "$OUT/pid.txt" 2>&1
timeout 8 "$ADB" -s "$SERIAL" logcat -d -t 600 > "$OUT/logcat.txt" 2>&1
timeout 8 "$ADB" -s "$SERIAL" shell dumpsys activity top > "$OUT/activity.txt" 2>&1
timeout 8 "$ADB" -s "$SERIAL" exec-out screencap -p > "$OUT/screen.png"
timeout 8 "$ADB" -s "$SERIAL" shell uiautomator dump /sdcard/ck-host-window.xml > "$OUT/uiautomator.txt" 2>&1
timeout 8 "$ADB" -s "$SERIAL" pull /sdcard/ck-host-window.xml "$OUT/window.xml" > "$OUT/pull.txt" 2>&1
timeout 8 "$ADB" -s "$SERIAL" logcat -b crash -d -t 100 > "$OUT/crash-logcat.txt" 2>&1
sha256sum "$APK" > "$OUT/final-input-sha256.txt"
echo 'Installation succeeded; launch diagnostics collected. Inspect evidence before declaring startup success.'
