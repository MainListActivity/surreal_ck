#!/usr/bin/env python3
"""No compilation. Verify exact source/input/binaries and run exactly two ignored tests."""
import hashlib,json,os,pathlib,subprocess
H=pathlib.Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
source_digest=sha(H/'source-receipt.json')
source=json.loads((H/'source-receipt.json').read_text())
input_binding=source.get('synthetic_input')
if not input_binding:raise SystemExit('Run explicit prepare-input.py first; unbound input refused')
input_path=pathlib.Path(input_binding['receipt_path'])
if sha(input_path)!=input_binding['receipt_sha256']:raise SystemExit('Input receipt changed')
fixture=json.loads(input_path.read_text())
binary=os.environ['E2E_TEST_BINARY'];binary_sha=os.environ['E2E_TEST_SHA256']
fork=os.environ['SURREAL_TEST_BINARY'];fork_sha=os.environ['SURREAL_TEST_SHA256']
def verify():
    assert sha(H/'source-receipt.json')==source_digest,'source receipt changed'
    for path,digest in source['inputs'].items():assert sha(path)==digest,f'source changed: {path}'
    assert sha(input_path)==input_binding['receipt_sha256'],'input receipt changed'
    assert sha(fixture['path'])==fixture['sha256']==input_binding['ivf_sha256'],'synthetic input changed'
    assert sha(fixture['ffmpeg'])==fixture['ffmpeg_sha256'],'FFmpeg changed'
    assert sha(binary)==binary_sha,'test binary changed'
    assert sha(fork)==fork_sha,'fork binary changed'
verify()
prefix='enterprise_peer::enterprise_media_e2e::'
names={prefix+'authenticated_vp8_decode_publish_and_close',prefix+'authenticated_revocation_closes_real_playback'}
listing=subprocess.check_output([binary,prefix,'--ignored','--list'],text=True,timeout=10)
assert {line.removesuffix(': test') for line in listing.splitlines() if line.endswith(': test')}==names,listing
env=os.environ.copy();env['MEDIA_E2E_IVF']=fixture['path']
try:
    result=subprocess.run([binary,prefix,'--ignored','--test-threads=1','--nocapture'],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=210)
    (H/'run.log').write_text(result.stdout)
    print(result.stdout)
    assert result.returncode==0,'test process failed'
    assert 'test result: ok. 2 passed; 0 failed' in result.stdout,'not exactly two passed tests'
finally:
    verify()
print('Verified two synthetic media tests; no device/UI presentation acceptance.')
