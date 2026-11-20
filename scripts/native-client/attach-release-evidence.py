#!/usr/bin/env python3
"""Attach only missing validation sidecars after successful online preflight.
Never creates a Release, overwrites an asset, or uploads an installer.
"""
import json
import os
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
tag = os.environ['RELEASE_TAG']
report = json.loads((root/'online-policy-preflight.json').read_text())
if report.get('result') != 'online-policy-and-public-artifact-bytes-match':
    raise SystemExit('Successful final online preflight required')
assets = json.loads(subprocess.check_output(['gh','release','view',tag,'--json','assets'],text=True))['assets']
existing = {a['name'] for a in assets}
suffixes = ('-build-receipt.json','-assets.json','-SHA256SUMS.txt','-signing-status.txt')
for file in sorted(root.iterdir()):
    if not file.is_file() or not (file.name.endswith(suffixes) or file.name in ('online-policy-preflight.json','android-apk-verification.txt')):
        continue
    if file.name in existing:
        print('Preserved existing evidence: '+file.name)
        continue
    subprocess.run(['gh','release','upload',tag,str(file)],check=True)  # no --clobber
