#!/usr/bin/env python3
"""No build; requires a recent desktop-worker confirmation of the isolated test window."""
import hashlib,json,os,pathlib,subprocess,time
H=pathlib.Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
receipt_path=H/'source-receipt.json';receipt_sha=sha(receipt_path)
source=json.loads(receipt_path.read_text())
binary=os.environ['E2E_TEST_BINARY'];binary_sha=os.environ['E2E_TEST_SHA256']
fork=os.environ['SURREAL_TEST_BINARY'];fork_sha=os.environ['SURREAL_TEST_SHA256']
confirmation=os.environ['SCREEN_E2E_CONFIRMATION'];confirmation_sha=os.environ['SCREEN_E2E_CONFIRMATION_SHA256']
def verify():
    assert sha(receipt_path)==receipt_sha
    for path,digest in source['inputs'].items():assert sha(path)==digest,f'source changed: {path}'
    assert sha(binary)==binary_sha;assert sha(fork)==fork_sha
    assert sha(confirmation)==confirmation_sha,'window confirmation changed'
verify()
c=json.loads(pathlib.Path(confirmation).read_text())
assert c['confirmed_test_window_only'] is True
assert c['width']==640 and c['height']==360
assert c['pattern']=='alternating-red-blue-1s'
assert 0<=time.time()-c['confirmed_unix_seconds']<300,'reconfirm actual window before capture'
prefix='enterprise_peer::enterprise_screen_e2e::'
names={prefix+'authenticated_real_screen_capture_stop',prefix+'authenticated_revocation_closes_real_screen'}
listing=subprocess.check_output([binary,prefix,'--ignored','--list'],text=True,timeout=10)
assert {line.removesuffix(': test') for line in listing.splitlines() if line.endswith(': test')}==names
try:
    result=subprocess.run([binary,prefix,'--ignored','--test-threads=1','--nocapture'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=210)
    (H/'run.log').write_text(result.stdout);print(result.stdout)
    assert result.returncode==0
    assert 'test result: ok. 2 passed; 0 failed' in result.stdout
finally:
    verify()
print('Two actual test-window screen capture cases passed; no camera or production grant claim.')
