#!/usr/bin/env python3
"""Explicit future execution step: generate bounded synthetic data, never devices."""
import hashlib,json,pathlib,shutil,subprocess
H=pathlib.Path(__file__).resolve().parent
ffmpeg=pathlib.Path(shutil.which('ffmpeg') or '').resolve(strict=True)
output=H/'red.ivf'
if output.exists(): raise SystemExit('Refuse overwriting existing fixture; review its receipt first')
command=[str(ffmpeg),'-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=64x48:r=10','-frames:v','4','-an','-c:v','libvpx','-g','1','-deadline','realtime','-f','ivf',str(output)]
subprocess.run(command,check=True,timeout=20)
data=output.read_bytes()
if not 32<len(data)<256*1024 or data[:4]!=b'DKIF':raise SystemExit('Invalid or oversized IVF')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
receipt={'path':str(output),'sha256':sha(output),'bytes':len(data),'ffmpeg':str(ffmpeg),'ffmpeg_sha256':sha(ffmpeg),'command':command,'version':subprocess.check_output([str(ffmpeg),'-version'],text=True,timeout=5)}
(H/'input-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
# Bind generated input receipt to this exact source set, without refreshing source hashes.
p=H/'source-receipt.json';source=json.loads(p.read_text())
source['synthetic_input']={'receipt_path':str(H/'input-receipt.json'),'receipt_sha256':sha(H/'input-receipt.json'),'ivf_sha256':sha(output)}
p.write_text(json.dumps(source,indent=2)+'\n')
print('Synthetic input generated and bound; not a test run.')
