#!/usr/bin/env sh
set -eu
: "${ANDROID_HOME:?Set ANDROID_HOME to an installed Android SDK}"
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
mkdir -p "$ROOT/build/android"
java com.sun.tools.javac.Main -source 8 -target 8 -Xlint:all,-options -Werror -bootclasspath "$ANDROID_HOME/platforms/android-35/android.jar:$ANDROID_HOME/build-tools/${ANDROID_BUILD_TOOLS_VERSION:-35.0.1}/core-lambda-stubs.jar" -d "$ROOT/build/android" "$ROOT"/android/src/top/maplayer/collaboration/media/*.java "$ROOT"/android/src/top/maplayer/collaboration/documents/*.java
