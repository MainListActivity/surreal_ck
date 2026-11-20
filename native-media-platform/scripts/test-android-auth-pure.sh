#!/usr/bin/env sh
# Pure ingress ownership tests; never launches a browser or performs login.
set -eu
: "${ANDROID_HOME:?Set existing Android SDK}"
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
OUT="$ROOT/build/auth"
mkdir -p "$OUT"
java com.sun.tools.javac.Main -source 8 -target 8 -Xlint:all,-options -Werror -bootclasspath "$ANDROID_HOME/platforms/android-35/android.jar:$ANDROID_HOME/build-tools/${ANDROID_BUILD_TOOLS_VERSION:-35.0.1}/core-lambda-stubs.jar" -d "$OUT" "$ROOT"/android/src/top/maplayer/collaboration/auth/*.java
java com.sun.tools.javac.Main -Xlint:all -Werror -cp "$OUT" -d "$OUT" "$ROOT/android/tests/top/maplayer/collaboration/auth/AuthUriTest.java"
java -cp "$OUT" top.maplayer.collaboration.auth.AuthUriTest
rustc --edition 2024 --test "$ROOT/../native-client/src/android_oauth_route.rs" -o "$OUT/route-test"
"$OUT/route-test"
