#!/usr/bin/env python3
"""Prepare/renew unsigned policies, verify external signatures, check expiry.
No key generation, private-key access, upload, scheduling or publication.
"""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

DEFAULT_TTL = 7 * 86400
MAX_TTL = 30 * 86400  # Must match native-updater::MAX_POLICY_LIFETIME_SECS.
MAX_ENVELOPE_BYTES = 128 * 1024
U64_MAX = 2**64 - 1

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Mirror redirects are not allowed; configure its final HTTPS asset URL')

def safe_url(url):
    u = urllib.parse.urlsplit(url)
    if u.scheme != 'https' or not u.hostname or u.port not in (None, 443) or u.username or u.password or u.fragment or u.query:
        raise ValueError('Expected a direct HTTPS URL without credentials, query or fragment')
    return url.rstrip('/')

def strict_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate JSON field: ' + key)
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique)

def uint(value, name):
    if type(value) is not int or not 0 <= value <= U64_MAX:
        raise ValueError(name + ' must be an unsigned 64-bit integer')

def validate_policy(payload):
    p = strict_json(payload)
    if not isinstance(p, dict) or set(p) != {'schema', 'app_id', 'channel', 'sequence', 'issued_at', 'expires_at', 'releases'}:
        raise ValueError('Invalid policy fields')
    for name in ('schema', 'sequence', 'issued_at', 'expires_at'):
        uint(p[name], name)
    if p['schema'] != 1 or p['sequence'] == 0 or not 0 < p['expires_at'] - p['issued_at'] <= MAX_TTL:
        raise ValueError('Schema must be 1, sequence positive, lifetime 1..2592000 seconds')
    if not all(isinstance(p[n], str) and p[n].strip() for n in ('app_id', 'channel')):
        raise ValueError('Application and channel are required')
    if not isinstance(p['releases'], list) or not p['releases']:
        raise ValueError('At least one release is required')
    seen = set()
    required = {'platform', 'arch', 'version', 'url', 'sha256', 'size', 'publisher'}
    for r in p['releases']:
        if not isinstance(r, dict) or not required <= set(r) or set(r) - required - {'mirror_urls'}:
            raise ValueError('Invalid release fields')
        if not all(isinstance(r[n], str) and r[n].strip() for n in required - {'size'}):
            raise ValueError('Release string fields must be nonempty')
        target = (r['platform'], r['arch'])
        if target in seen:
            raise ValueError('Duplicate release target')
        seen.add(target)
        if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', r['version']):
            raise ValueError('Update channel requires plain SemVer')
        uint(r['size'], 'size')
        if not 0 < r['size'] <= 2 * 1024**3 or not re.fullmatch(r'[0-9a-fA-F]{64}', r['sha256']):
            raise ValueError('Invalid artifact size or SHA-256')
        if r['publisher'].lower() in ('unsigned', 'test-key', 'unknown'):
            raise ValueError('Explicit publisher identity required')
        mirrors = r.get('mirror_urls', [])
        if not isinstance(mirrors, list) or not all(isinstance(u, str) for u in mirrors):
            raise ValueError('Invalid mirror URLs')
        for url in [r['url'], *mirrors]:
            safe_url(url)
    return p

def verify_signature(payload, signature_hex, public_key_hex):
    signature, public = bytes.fromhex(signature_hex), bytes.fromhex(public_key_hex)
    if len(signature) != 64 or len(public) != 32 or public == bytes(32):
        raise ValueError('Expected 64-byte Ed25519 signature and nonzero 32-byte public key')
    with tempfile.TemporaryDirectory() as temp:
        temp = pathlib.Path(temp)
        (temp / 'public.der').write_bytes(bytes.fromhex('302a300506032b6570032100') + public)
        (temp / 'signature').write_bytes(signature)
        (temp / 'payload').write_bytes(payload)
        subprocess.run(['openssl', 'pkeyutl', '-verify', '-pubin', '-keyform', 'DER',
                        '-inkey', str(temp / 'public.der'), '-rawin', '-in', str(temp / 'payload'),
                        '-sigfile', str(temp / 'signature')], check=True, capture_output=True)

def read_envelope(data, public_key_hex):
    if len(data) > MAX_ENVELOPE_BYTES:
        raise ValueError('Envelope exceeds 128 KiB')
    e = strict_json(data)
    if not isinstance(e, dict) or set(e) != {'payload', 'signature_hex'} or not all(isinstance(v, str) for v in e.values()):
        raise ValueError('Invalid envelope')
    payload = e['payload'].encode('utf-8')
    verify_signature(payload, e['signature_hex'], public_key_hex)
    return payload, validate_policy(payload)

def previous(args):
    path = getattr(args, 'previous_envelope', None)
    if path:
        key = getattr(args, 'public_key_hex', None)
        if not key:
            raise ValueError('--public-key-hex is required to verify the previous envelope')
        return read_envelope(pathlib.Path(path).read_bytes(), key)
    if not getattr(args, 'initial', False):
        raise ValueError('Previous signed envelope required; use --initial only for the first policy')
    return None

def validate_successor(payload, p, prior):
    if prior is None:
        return
    old_bytes, old = prior
    if (p['app_id'], p['channel']) != (old['app_id'], old['channel']):
        raise ValueError('Application/channel must match previous policy')
    if p['sequence'] < old['sequence'] or (p['sequence'] == old['sequence'] and payload != old_bytes):
        raise ValueError('Policy rollback: changed bytes require a higher sequence')
    if p['issued_at'] < old['issued_at']:
        raise ValueError('Issued time cannot move backwards')
    versions = {(r['platform'], r['arch']): tuple(map(int, r['version'].split('.'))) for r in old['releases']}
    for r in p['releases']:
        if tuple(map(int, r['version'].split('.'))) < versions.get((r['platform'], r['arch']), (0, 0, 0)):
            raise ValueError('Release version cannot move backwards')

def encode(p):
    return json.dumps(p, separators=(',', ':'), ensure_ascii=False).encode('utf-8')

def write_new(path, data):
    # Keep immutable signed history; never overwrite the predecessor/sequence ledger.
    with pathlib.Path(path).open('xb') as stream:
        stream.write(data)

def issue_times(args):
    now = int(time.time()) if args.issued_at is None else args.issued_at
    uint(now, 'issued_at')
    if not 0 < args.ttl <= MAX_TTL or now + args.ttl > U64_MAX:
        raise ValueError('TTL must be 1..2592000 seconds without timestamp overflow')
    return now, now + args.ttl

def write_payload(args, p, prior):
    payload = encode(p)
    validate_policy(payload)
    validate_successor(payload, p, prior)
    # Reserve enough room for envelope escaping and signature fields.
    if len(encode(dict(payload=payload.decode('utf-8'), signature_hex='0' * 128))) > MAX_ENVELOPE_BYTES:
        raise ValueError('Signed envelope would exceed 128 KiB')
    write_new(args.output, payload)
    print('UNSIGNED payload prepared. External authorized signer must sign these exact UTF-8 bytes.')

def prepare(args):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repository):
        raise ValueError('Invalid owner/repository')
    prior = previous(args)
    now, expires = issue_times(args)
    publishers = json.loads(pathlib.Path(args.publishers).read_text())
    mirrors = [safe_url(u) for u in args.mirror_base]
    releases = []
    seen = set()
    for index in sorted(pathlib.Path(args.assets).glob('*-assets.json')):
        for item in json.loads(index.read_text()):
            key = item['platform'] + '/' + item['arch']
            if key in seen:
                raise ValueError('Duplicate platform: ' + key)
            seen.add(key)
            if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', item['version']):
                raise ValueError('Update channel requires plain SemVer')
            if item['platform'] == 'android' and item['signing'] != 'release-key':
                raise ValueError('Android automatic-update channel requires a stable release key; test-key APK rejected')
            publisher = publishers.get(key, '').strip()
            if not publisher or publisher.lower() in ('unsigned', 'test-key', 'unknown'):
                raise ValueError('Explicit publisher identity required for ' + key)
            filename = item['filename']
            if pathlib.Path(filename).name != filename:
                raise ValueError('Unsafe filename')
            asset = pathlib.Path(args.assets) / filename
            if asset.stat().st_size != item['size'] or hashlib.sha256(asset.read_bytes()).hexdigest() != item['sha256']:
                raise ValueError('Local asset hash mismatch: ' + filename)
            encoded = urllib.parse.quote(filename, safe='')
            mirror_urls = [base + '/' + encoded for base in mirrors]
            # Verify every configured mirror's exact bytes BEFORE signing its URL.
            # A failed/unpublished mirror fails preparation; no invented availability.
            for url in mirror_urls:
                digest, size = hashlib.sha256(), 0
                with urllib.request.build_opener(NoRedirect).open(url, timeout=30) as response:
                    while chunk := response.read(1024 * 1024):
                        size += len(chunk)
                        if size > item['size']:
                            raise ValueError('Oversized mirror asset')
                        digest.update(chunk)
                if size != item['size'] or digest.hexdigest() != item['sha256']:
                    raise ValueError('Mirror content differs from GitHub release asset: ' + url)
            releases.append({k: item[k] for k in ('platform', 'arch', 'version', 'sha256', 'size')} | {
                'url': f'https://github.com/{args.repository}/releases/download/{urllib.parse.quote(args.tag, safe="")}/{encoded}',
                'mirror_urls': mirror_urls, 'publisher': publisher})
    if not releases:
        raise ValueError('No release asset indexes found')
    policy = dict(schema=1, app_id=args.app_id, channel=args.channel, sequence=args.sequence,
                  issued_at=now, expires_at=expires, releases=releases)
    write_payload(args, policy, prior)

def renew(args):
    prior = previous(args)
    if prior is None:
        raise ValueError('Renewal requires a previous signed envelope')
    p = dict(prior[1])
    now, expires = issue_times(args)
    if expires <= p['expires_at']:
        raise ValueError('Renewal must extend expiration')
    p.update(sequence=p['sequence'] + 1 if args.sequence is None else args.sequence,
             issued_at=now, expires_at=expires)
    write_payload(args, p, prior)

def envelope(args):
    payload = pathlib.Path(args.payload).read_bytes()
    signature = pathlib.Path(args.signature_hex).read_text().strip()
    data = encode(dict(payload=payload.decode('utf-8'), signature_hex=signature))
    payload, p = read_envelope(data, args.public_key_hex)
    validate_successor(payload, p, previous(args))
    if not p['issued_at'] <= int(time.time()) < p['expires_at']:
        raise ValueError('Cannot package an expired or future policy for publication')
    write_new(args.output, data)
    print('External signature verified; envelope prepared. Nothing was published.')

def check(args):
    """Read only: 0 healthy, 1 warning, 2 critical, 3 invalid/unavailable."""
    if not 0 <= args.critical_before <= args.warn_before:
        raise ValueError('Require 0 <= critical-before <= warn-before')
    if args.url:
        request = urllib.request.Request(safe_url(args.url), headers={
            'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache'})
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            if response.status != 200:
                raise ValueError('Policy endpoint must return HTTP 200')
            data = response.read(MAX_ENVELOPE_BYTES + 1)
    else:
        data = pathlib.Path(args.envelope).read_bytes()
    payload, p = read_envelope(data, args.public_key_hex)
    if args.previous_envelope:
        validate_successor(payload, p, previous(args))
    if p['sequence'] < args.min_sequence:
        raise ValueError('Policy sequence below operator floor')
    if args.expected_payload_sha256 and hashlib.sha256(payload).hexdigest() != args.expected_payload_sha256:
        raise ValueError('Endpoint payload differs from the expected published payload')
    now = int(time.time())
    if now < p['issued_at']:
        raise ValueError('Policy issued in the future / clock rollback')
    remaining = p['expires_at'] - now
    if remaining <= 0:
        raise ValueError('Policy expired; clients are locked')
    status = 2 if remaining <= args.critical_before else 1 if remaining <= args.warn_before else 0
    print(json.dumps(dict(status=['healthy', 'warning', 'critical'][status], sequence=p['sequence'],
        expires_at=p['expires_at'], remaining_seconds=remaining,
        payload_sha256=hashlib.sha256(payload).hexdigest(), source='online' if args.url else 'file')))
    return status

def parser():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('prepare')
    for name in ('assets', 'repository', 'tag', 'app-id', 'channel', 'publishers', 'output'):
        p.add_argument('--' + name, required=True)
    p.add_argument('--sequence', type=int, required=True)
    p.add_argument('--issued-at', type=int)
    p.add_argument('--ttl', type=int, default=DEFAULT_TTL)
    p.add_argument('--mirror-base', action='append', default=[])
    p.add_argument('--public-key-hex')
    r = sub.add_parser('renew', help='Renew unchanged release targets using a verified predecessor')
    for name in ('previous-envelope', 'public-key-hex', 'output'):
        r.add_argument('--' + name, required=True)
    r.add_argument('--sequence', type=int, help='Default: previous sequence + 1')
    r.add_argument('--issued-at', type=int)
    r.add_argument('--ttl', type=int, default=DEFAULT_TTL)
    e = sub.add_parser('envelope')
    for name in ('payload', 'signature-hex', 'public-key-hex', 'output'):
        e.add_argument('--' + name, required=True)
    for command in (p, e):
        history = command.add_mutually_exclusive_group(required=True)
        history.add_argument('--previous-envelope')
        history.add_argument('--initial', action='store_true', help='First policy only; never reset published history')
    c = sub.add_parser('check', help='Read-only signed policy expiry and publication check')
    source = c.add_mutually_exclusive_group(required=True)
    source.add_argument('--envelope')
    source.add_argument('--url')
    c.add_argument('--public-key-hex', required=True)
    c.add_argument('--previous-envelope')
    c.add_argument('--min-sequence', type=int, default=0)
    c.add_argument('--expected-payload-sha256')
    c.add_argument('--warn-before', type=int, default=2 * 86400)
    c.add_argument('--critical-before', type=int, default=86400)
    return parser

def main(argv=None):
    args = parser().parse_args(argv)
    try:
        return {'prepare': prepare, 'renew': renew, 'envelope': envelope, 'check': check}[args.command](args) or 0
    except (ValueError, OSError, TypeError, KeyError, subprocess.CalledProcessError) as error:
        print('Policy operation failed: ' + str(error), file=sys.stderr)
        return 3

if __name__ == '__main__':
    sys.exit(main())
