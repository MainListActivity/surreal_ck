#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
sh "$ROOT/scripts/check-android.sh"
java com.sun.tools.javac.Main -Xlint:all -Werror -cp "$ROOT/build/android" -d "$ROOT/build/android" "$ROOT/android/tests/top/maplayer/collaboration/media/HostSafetyTest.java"
java -cp "$ROOT/build/android" top.maplayer.collaboration.media.HostSafetyTest
java com.sun.tools.javac.Main -Xlint:all -Werror -cp "$ROOT/build/android" -d "$ROOT/build/android" "$ROOT/android/tests/top/maplayer/collaboration/documents/DocumentLifetimeTest.java"
java -cp "$ROOT/build/android" top.maplayer.collaboration.documents.DocumentLifetimeTest
