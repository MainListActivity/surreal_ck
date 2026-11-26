#!/usr/bin/env python3
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def main():
    linker = Path(os.environ["ROSTER_ANDROID_LINKER"])
    args = sys.argv[1:]
    if not any(re.fullmatch(r"libwebrtc_sys-.*\.rlib", Path(arg).name) for arg in args):
        os.execv(linker, [str(linker), *args])
    with tempfile.TemporaryDirectory(prefix="roster-link-") as tmp:
        tmp = Path(tmp)
        ar = linker.with_name("llvm-ar")
        nm = linker.with_name("llvm-nm")
        index, original = next((i, Path(arg)) for i, arg in enumerate(args)
                               if re.fullmatch(r"libwebrtc_sys-.*\.rlib", Path(arg).name))
        archive = tmp / original.name
        shutil.copyfile(original, archive)
        # NSH owns JNI_OnLoad; the private provider initializes WebRTC separately.
        subprocess.run([ar, "d", archive, "jni_onload.o"], check=True)
        args[index] = str(archive)
        symbols = subprocess.check_output([nm, "--defined-only", "--extern-only", archive], text=True)
        exports = sorted(set(re.findall(r"\bJava_livekit_org_webrtc\w+", symbols)))
        index, original = next((i, arg.split("=", 1)[1]) for i, arg in enumerate(args)
                               if arg.startswith("-Wl,--version-script="))
        script = Path(original).read_text()
        if not exports or script.count("global:") != 1:
            raise ValueError("Missing WebRTC JNI exports or unexpected Rust symbol map")
        version = tmp / "exports"
        version.write_text(script.replace("global:", "global:\n" + "\n".join(f"    {s};" for s in exports)))
        args[index] = f"-Wl,--version-script={version}"
        return subprocess.call([linker, *args, *(f"-Wl,--undefined={s}" for s in exports)])


if __name__ == "__main__":
    sys.exit(main())
