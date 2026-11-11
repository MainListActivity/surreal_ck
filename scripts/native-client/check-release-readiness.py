#!/usr/bin/env python3
"""Read-only online signed-policy preflight. No key generation or publication.
A pass is a point-in-time policy/artifact match, not an OS/device certification.
"""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import re
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from update_config import validate_config

spec = importlib.util.spec_from_file_location('release_policy', pathlib.Path(__file__).with_name('update-policy.py'))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
MIN_REMAINING = 86400
EXPECTED_TARGETS = {('linux','x86_64'), ('macos','aarch64'), ('macos','x86_64'), ('windows','x86_64'), ('android','aarch64'), ('android','x86_64')}
# Public repository test fixtures / RFC8032 vectors must never be production roots.
TEST_PUBLIC_KEYS = {
    '197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61',
    'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    bytes(range(1,33)).hex(),
}

def file_hash(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        while chunk := f.read(1024*1024): h.update(chunk)
    return h.hexdigest()

def fetch_policy(url):
    # Config validation already checked allowlist. Refuse all redirects here;
    # the configured public policy endpoint must directly serve its envelope.
    request = urllib.request.Request(url, headers={'Cache-Control':'no-cache, no-store','Pragma':'no-cache'})
    with urllib.request.build_opener(policy.NoRedirect).open(request, timeout=30) as response:
        if response.status != 200: raise ValueError('Policy endpoint did not return HTTP 200')
        data = response.read(policy.MAX_ENVELOPE_BYTES + 1)
    if len(data) > policy.MAX_ENVELOPE_BYTES: raise ValueError('Policy envelope too large')
    return data

class NoAutoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def remote_artifact(url, size, expected_hash, hosts):
    """Stream verified bytes without saving large files; allowlisted redirects only."""
    opener = urllib.request.build_opener(NoAutoRedirect)
    for hop in range(6):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'https' or parsed.port not in (None,443) or parsed.username or parsed.password or parsed.fragment or parsed.hostname not in hosts:
            raise ValueError('Remote artifact/redirect not in HTTPS network allowlist')
        try:
            response = opener.open(urllib.request.Request(url, headers={'Cache-Control':'no-cache'}), timeout=30)
        except urllib.error.HTTPError as error:
            if error.code in (301,302,303,307,308) and hop < 5 and error.headers.get('Location'):
                url = urllib.parse.urljoin(url, error.headers['Location'])
                error.close()
                continue
            raise
        with response:
            if response.status != 200: raise ValueError('Remote asset must return 200')
            digest, total = hashlib.sha256(), 0
            deadline = time.monotonic() + 600
            while chunk := response.read(1024*1024):
                total += len(chunk)
                if total > size or time.monotonic() > deadline: raise ValueError('Remote asset oversized or timed out')
                digest.update(chunk)
            if total != size or digest.hexdigest() != expected_hash.lower():
                raise ValueError('Public remote artifact bytes differ from signed/local artifact')
            return
    raise ValueError('Too many redirects')

def check_policy(p, config, now, min_remaining=MIN_REMAINING):
    trust = config['trust']
    if (p['app_id'],p['channel']) != (trust['app_id'],trust['channel']):
        raise ValueError('Signed policy app/channel mismatch')
    if p['issued_at'] > now or p['expires_at'] - now < min_remaining:
        raise ValueError('Policy is future, expired, or lacks at least 24h remaining validity')
    for release in p['releases']:
        for url in [release['url'], *release.get('mirror_urls',[])]:
            if urllib.parse.urlsplit(policy.safe_url(url)).hostname not in trust['download_hosts']:
                raise ValueError('Signed artifact URL is not in embedded download allowlist')

def match_asset(p, item, repository, tag):
    matches = [r for r in p['releases'] if (r['platform'],r['arch']) == (item['platform'],item['arch'])]
    if len(matches) != 1: raise ValueError('Policy lacks an unambiguous artifact target')
    release = matches[0]
    for key in ('version','size'):
        if release[key] != item[key]: raise ValueError('Signed artifact ' + key + ' mismatch')
    if release['sha256'].lower() != item['sha256'].lower(): raise ValueError('Signed artifact hash mismatch')
    expected = f'https://github.com/{repository}/releases/download/{urllib.parse.quote(tag,safe="")}/{urllib.parse.quote(item["filename"],safe="")}'
    if release['url'] != expected: raise ValueError('Signed primary URL does not identify this exact GitHub release asset')
    if item['platform']=='android' and item.get('signing')!='release-key':
        raise ValueError('Test-key Android APK cannot enter a production release')

def check_release(root, repository, tag, *, fetch=fetch_policy, verify_remote=remote_artifact, now=None):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository) or not tag:
        raise ValueError('Exact repository and release tag required')
    fixed_now = now is not None
    now = int(time.time()) if now is None else now
    receipts = sorted(root.glob('*-build-receipt.json'))
    if not receipts: raise ValueError('No build receipts; refusing unproven installers')
    seen, cache, evidence, remote_checked = set(), {}, [], set()
    for path in receipts:
        receipt = policy.strict_json(path.read_bytes())
        if receipt.get('update_config') != 'embedded-unverified':
            raise ValueError('Missing embedded update config: startup-locked preview')
        config = validate_config(receipt.get('update_config_public'))
        key = bytes(config['trust']['public_key']).hex()
        if key in TEST_PUBLIC_KEYS: raise ValueError('Public test key cannot authorize production release')
        name = receipt['filename']
        if pathlib.Path(name).name != name: raise ValueError('Unsafe installer filename')
        artifact = root/name
        if artifact.stat().st_size != receipt['size'] or file_hash(artifact) != receipt['sha256']:
            raise ValueError('Installer does not match build receipt')
        index = path.with_name(path.name.removesuffix('-build-receipt.json')+'-assets.json')
        items = policy.strict_json(index.read_bytes())
        if not isinstance(items,list) or not items: raise ValueError('Missing platform asset index')
        accepted = []
        for url in config['policy_urls']:
            cache_key = (url,key)
            if cache_key not in cache:
                data = fetch(url)
                payload,p = policy.read_envelope(data,key)
                cache[cache_key] = (hashlib.sha256(payload).hexdigest(),p)
            payload_hash,p = cache[cache_key]
            check_policy(p,config,now)
            accepted.append(payload_hash)
            for item in items:
                if any(item[k] != receipt[k] for k in ('platform','filename','version','size','sha256')):
                    raise ValueError('Asset index differs from build receipt')
                match_asset(p,item,repository,tag)
                release = next(r for r in p['releases'] if (r['platform'],r['arch']) == (item['platform'],item['arch']))
                for asset_url in [release['url'], *release.get('mirror_urls',[])]:
                    remote_key = (asset_url,item['sha256'],item['size'],tuple(config['network_hosts']))
                    if remote_key not in remote_checked:
                        verify_remote(asset_url,item['size'],item['sha256'],config['network_hosts'])
                        remote_checked.add(remote_key)
            evidence.append(dict(endpoint=url, payload_sha256=payload_hash, sequence=p['sequence'], expires_at=p['expires_at']))
        if len(set(accepted)) != 1: raise ValueError('Configured policy endpoints serve different payloads')
        for item in items:
            target = (item['platform'],item['arch'])
            if target in seen: raise ValueError('Duplicate local platform target')
            seen.add(target)
    if seen != EXPECTED_TARGETS: raise ValueError('Complete expected release target set required')
    final_time = now if fixed_now else int(time.time())
    if final_time < now or any(p['expires_at'] - final_time < MIN_REMAINING for _,p in cache.values()):
        raise ValueError('Policy expired/too near expiry or clock rolled back during remote verification')
    return dict(checked_at=final_time, result='online-policy-and-public-artifact-bytes-match', policies=evidence,
                limitation='Point-in-time only; no OS installation, key ownership, or device behavior certification; availability may change after this check')

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('assets',type=pathlib.Path)
    p.add_argument('--repository',required=True)
    p.add_argument('--tag',required=True)
    args=p.parse_args()
    try: print(json.dumps(check_release(args.assets,args.repository,args.tag),indent=2))
    except (ValueError,KeyError,TypeError,OSError,policy.subprocess.SubprocessError) as e:
        raise SystemExit('Release preflight FAILED: '+str(e))

if __name__=='__main__':main()
