#!/bin/bash
cd /workspace/scratch/115bfa675150/native-client-probe/surreal_ck || exit 99
D=native-client/validation/real-udp-merged-session
{ date -u +%FT%TZ; uname -srm; printf 'Execution: CUA Xfce native desktop terminal; no network changes\n'; printf 'Interface names only: '; ls /sys/class/net; command -v ffmpeg; } > "$D/desktop-context.txt"
sha256sum native-client/target/debug/deps/one_to_one_session-a63ad52b874eb132 native-call/tests/one_to_one_session.rs > "$D/desktop-input-sha256.txt"
printf '%s\n' 'timeout 60s native-client/target/debug/deps/one_to_one_session-a63ad52b874eb132 real_udp_same_session_chat_files_three_tracks_and_negative_cases --ignored --exact --nocapture' > "$D/command.txt"
timeout 60s native-client/target/debug/deps/one_to_one_session-a63ad52b874eb132 real_udp_same_session_chat_files_three_tracks_and_negative_cases --ignored --exact --nocapture > "$D/desktop-test.log" 2>&1
status=$?
printf '%s\n' "$status" > "$D/desktop-exit.txt"
cat "$D/desktop-context.txt" "$D/desktop-test.log"
printf 'MERGED_REAL_UDP_EXIT=%s\n' "$status"
