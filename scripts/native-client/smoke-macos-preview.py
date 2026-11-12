#!/usr/bin/env python3
"""Launch the app extracted from its DMG; record process survival, not UI acceptance."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

out = Path(sys.argv[1]).resolve()
dmg = out / 'SurrealCK-macos-apple-silicon-test-only.dmg'
result = {'scope': 'test-only; process survival only; GUI and product flows unverified',
          'dmg_mount': 'not-run', 'codesign': 'not-run', 'process_survival': 'not-run'}
log_path = out / 'launch.log'
log_path.touch()
exit_status = 1
try:
    with tempfile.TemporaryDirectory(prefix='surreal-arm-smoke-') as tmp:
        root = Path(tmp)
        mount = root / 'mount'
        mount.mkdir()
        subprocess.run(['hdiutil', 'attach', '-nobrowse', '-readonly', '-mountpoint', str(mount), str(dmg)], check=True)
        result['dmg_mount'] = 'passed'
        try:
            app = root / 'SurrealCK Test.app'
            subprocess.run(['ditto', str(mount / 'SurrealCK Enterprise Test Only.app'), str(app)], check=True)
        finally:
            subprocess.run(['hdiutil', 'detach', str(mount)], check=True)
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
        result['codesign'] = 'passed-ad-hoc'
        exe = app / 'Contents/MacOS/surreal-collaboration'
        home = root / 'home'
        home.mkdir()
        env = os.environ.copy()
        env['HOME'] = str(home)
        with log_path.open('wb') as log:
            proc = subprocess.Popen([str(exe)], stdout=log, stderr=subprocess.STDOUT, env=env)
            try:
                time.sleep(15)
                if proc.poll() is not None:
                    result['process_survival'] = f'failed-exit-{proc.returncode}'
                    raise RuntimeError('App exited during startup; see launch.log')
                result['process_survival'] = 'passed-15-seconds'
            finally:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait()
        exit_status = 0
except (OSError, subprocess.SubprocessError, RuntimeError) as error:
    result['error'] = str(error)
finally:
    (out / 'launch-smoke.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result))
sys.exit(exit_status)
