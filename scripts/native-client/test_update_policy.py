import hashlib
import importlib.util
import json
import pathlib
import tempfile
import types
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('policy', pathlib.Path(__file__).with_name('update-policy.py'))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

# 公开确定性测试种子 [42; 32] 的预先计算签名，仅测试数据，不创建/读取私钥。
PUBLIC = '197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61'
PAYLOAD = '{"schema":1,"app_id":"test.app","channel":"stable","sequence":7,"issued_at":1700000000,"expires_at":1700604800,"releases":[{"platform":"linux","arch":"x86_64","version":"1.0.0","url":"https://github.com/owner/repo/releases/download/v1.0.0/app.tar.gz","mirror_urls":[],"sha256":"abababababababababababababababababababababababababababababababab","size":10,"publisher":"test fixture, not production"}]}'
SIGNATURE = '05b08cdf9ef3cab10e32311601116660097d1e1470a3a9c782f979f60a39052ec561ed2fbfee5dcce9a7af9ea3869551bccf5b506bd6f9993afc84ff68187002'
SIGNED = policy.encode(dict(payload=PAYLOAD, signature_hex=SIGNATURE))

class PolicyTests(unittest.TestCase):
    def test_safe_urls(self):
        self.assertEqual(policy.safe_url('https://mirror.example/releases/'), 'https://mirror.example/releases')
        for url in ['http://mirror.example', 'https://user:pass@mirror.example', 'https://mirror.example:444', 'https://mirror.example/x#secret']:
            with self.assertRaises(ValueError): policy.safe_url(url)

    def test_payload_contract_and_test_key_rejection(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            artifact = root / 'test.apk'
            artifact.write_bytes(b'offline fixture, not an installer')
            item = dict(platform='android', arch='aarch64', version='0.1.0', filename=artifact.name,
                        size=artifact.stat().st_size, sha256=hashlib.sha256(artifact.read_bytes()).hexdigest(), signing='release-key')
            index = root / 'android-test-assets.json'
            index.write_text(json.dumps([item]))
            publishers = root / 'publishers.json'
            publishers.write_text(json.dumps({'android/aarch64': 'test certificate fingerprint fixture'}))
            output = root / 'payload.json'
            args = types.SimpleNamespace(repository='owner/repo', sequence=1, ttl=3600, publishers=str(publishers),
                mirror_base=[], assets=str(root), tag='v0.1.0', issued_at=1700000000, app_id='top.maplayer.collaboration',
                channel='stable', output=str(output), initial=True)
            policy.prepare(args)
            payload = json.loads(output.read_text())
            self.assertEqual(payload['expires_at'], 1700003600)
            self.assertEqual(payload['releases'][0]['mirror_urls'], [])
            self.assertEqual(payload['releases'][0]['url'], 'https://github.com/owner/repo/releases/download/v0.1.0/test.apk')
            self.assertNotIn('signature_hex', payload)
            item['signing'] = 'test-key'
            index.write_text(json.dumps([item]))
            with self.assertRaisesRegex(ValueError, 'stable release key'): policy.prepare(args)

    def test_seven_day_default_and_thirty_day_cap(self):
        args = policy.parser().parse_args(['renew', '--previous-envelope', 'old', '--public-key-hex', PUBLIC, '--output', 'next'])
        self.assertEqual(args.ttl, 7 * 86400)
        args.issued_at = 1700000000
        args.ttl = policy.MAX_TTL
        self.assertEqual(policy.issue_times(args), (1700000000, 1702592000))
        for ttl in (0, -1, policy.MAX_TTL + 1):
            args.ttl = ttl
            with self.assertRaisesRegex(ValueError, 'TTL'): policy.issue_times(args)
        p = json.loads(PAYLOAD)
        p['expires_at'] = p['issued_at'] + policy.MAX_TTL
        policy.validate_policy(policy.encode(p))
        p['expires_at'] += 1
        with self.assertRaisesRegex(ValueError, 'lifetime'): policy.validate_policy(policy.encode(p))

    def test_initial_must_be_explicit_and_history_verified(self):
        with self.assertRaisesRegex(ValueError, 'Previous signed envelope'):
            policy.previous(types.SimpleNamespace())
        self.assertIsNone(policy.previous(types.SimpleNamespace(initial=True)))
        with self.assertRaisesRegex(ValueError, 'public-key-hex'):
            policy.previous(types.SimpleNamespace(previous_envelope='previous'))

    def test_fixed_external_signature_and_tamper_rejection(self):
        payload, p = policy.read_envelope(SIGNED, PUBLIC)
        self.assertEqual(payload, PAYLOAD.encode())
        self.assertEqual(p['sequence'], 7)
        tampered = policy.encode(dict(payload=PAYLOAD.replace('"sequence":7', '"sequence":8'), signature_hex=SIGNATURE))
        with self.assertRaises(policy.subprocess.CalledProcessError): policy.read_envelope(tampered, PUBLIC)
        with self.assertRaises(ValueError): policy.read_envelope(b'x' * (policy.MAX_ENVELOPE_BYTES + 1), PUBLIC)
        with self.assertRaises(ValueError): policy.strict_json('{"sequence":1,"sequence":2}')

    def test_renew_keeps_release_and_identity_and_increments_sequence(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            old, new = root / 'old.json', root / 'new.json'
            old.write_bytes(SIGNED)
            args = policy.parser().parse_args(['renew', '--previous-envelope', str(old), '--public-key-hex', PUBLIC,
                '--output', str(new), '--issued-at', '1700086400'])
            policy.renew(args)
            p = json.loads(new.read_bytes())
            prior = json.loads(PAYLOAD)
            self.assertEqual(p['sequence'], 8)
            self.assertEqual(p['expires_at'], 1700691200)
            for name in ('app_id', 'channel', 'releases', 'schema'):
                self.assertEqual(p[name], prior[name])
            self.assertEqual(old.read_bytes(), SIGNED)
            with self.assertRaises(FileExistsError): policy.renew(args)
            # Recovery after an outage may renew an expired, correctly signed predecessor.
            args.issued_at = prior['expires_at'] + 1
            args.output = str(root / 'recovery.json')
            policy.renew(args)

    def test_renew_rejects_same_or_lower_sequence_and_shortened_expiration(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            old = root / 'old.json'
            old.write_bytes(SIGNED)
            args = policy.parser().parse_args(['renew', '--previous-envelope', str(old), '--public-key-hex', PUBLIC,
                '--output', str(root / 'new.json'), '--issued-at', '1700086400'])
            for seq in (6, 7):
                args.sequence = seq
                with self.assertRaisesRegex(ValueError, 'rollback'): policy.renew(args)
            args.sequence = 8
            args.ttl = 86400
            with self.assertRaisesRegex(ValueError, 'extend expiration'): policy.renew(args)
            args.issued_at = 1699999999
            args.ttl = policy.MAX_TTL
            with self.assertRaisesRegex(ValueError, 'backwards'): policy.renew(args)
            self.assertFalse(pathlib.Path(args.output).exists())

    def test_successor_requires_exact_same_sequence_and_non_decreasing_identity_version_time(self):
        prior = policy.read_envelope(SIGNED, PUBLIC)
        policy.validate_successor(*prior, prior)
        p = dict(prior[1])
        with self.assertRaisesRegex(ValueError, 'rollback'):
            policy.validate_successor(PAYLOAD.encode() + b' ', p, prior)
        for field, value, error in [('channel', 'beta', 'Application/channel'), ('issued_at', 1, 'backwards')]:
            changed = dict(p, sequence=8)
            changed[field] = value
            with self.assertRaisesRegex(ValueError, error): policy.validate_successor(policy.encode(changed), changed, prior)
        changed = json.loads(PAYLOAD)
        changed['sequence'] = 8
        changed['releases'][0]['version'] = '0.9.0'
        with self.assertRaisesRegex(ValueError, 'version'): policy.validate_successor(policy.encode(changed), changed, prior)

    def check_args(self, path):
        return policy.parser().parse_args(['check', '--envelope', str(path), '--public-key-hex', PUBLIC])

    def test_operational_warning_critical_and_expiry_boundaries(self):
        expires = json.loads(PAYLOAD)['expires_at']
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / 'current.json'
            path.write_bytes(SIGNED)
            args = self.check_args(path)
            for remaining, expected in [(6 * 86400 - 1, 0), (2 * 86400 + 1, 0), (2 * 86400, 1),
                                        (86401, 1), (86400, 2), (1, 2)]:
                with self.subTest(remaining=remaining), mock.patch.object(policy.time, 'time', return_value=expires - remaining):
                    self.assertEqual(policy.check(args), expected)
            for now, error in [(expires, 'expired'), (expires + 1, 'expired'), (1699999999, 'future')]:
                with self.subTest(now=now), mock.patch.object(policy.time, 'time', return_value=now):
                    with self.assertRaisesRegex(ValueError, error): policy.check(args)

    def test_monitor_rejects_rollback_unpublished_payload_and_invalid_thresholds(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(policy.time, 'time', return_value=1700100000):
            path = pathlib.Path(temp) / 'current.json'
            path.write_bytes(SIGNED)
            args = self.check_args(path)
            args.previous_envelope = str(path)
            self.assertEqual(policy.check(args), 0)
            args.min_sequence = 8
            with self.assertRaisesRegex(ValueError, 'floor'): policy.check(args)
            args.min_sequence = 7
            args.expected_payload_sha256 = '0' * 64
            with self.assertRaisesRegex(ValueError, 'expected published'): policy.check(args)
            args.expected_payload_sha256 = hashlib.sha256(PAYLOAD.encode()).hexdigest()
            self.assertEqual(policy.check(args), 0)
            args.critical_before = args.warn_before + 1
            with self.assertRaisesRegex(ValueError, 'critical-before'): policy.check(args)

    def test_online_monitor_fetches_with_cache_revalidation_and_fails_unavailable(self):
        args = policy.parser().parse_args(['check', '--url', 'https://updates.example/policy.json', '--public-key-hex', PUBLIC])
        with mock.patch.object(policy.urllib.request, 'build_opener') as opener, mock.patch.object(policy.time, 'time', return_value=1700100000):
            response = opener.return_value.open.return_value.__enter__.return_value
            response.status = 200
            response.read.return_value = SIGNED
            self.assertEqual(policy.check(args), 0)
            request = opener.return_value.open.call_args.args[0]
            self.assertEqual(request.get_header('Cache-control'), 'no-cache, no-store')
            response.read.assert_called_once_with(policy.MAX_ENVELOPE_BYTES + 1)
            opener.return_value.open.side_effect = OSError('offline')
            with self.assertRaises(OSError): policy.check(args)

    def test_envelope_validates_lifetime_and_preserves_signed_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            payload, sig, out = root / 'payload', root / 'signature', root / 'envelope'
            payload.write_text(PAYLOAD)
            sig.write_text(SIGNATURE)
            args = policy.parser().parse_args(['envelope', '--payload', str(payload), '--signature-hex', str(sig),
                '--public-key-hex', PUBLIC, '--output', str(out), '--initial'])
            with mock.patch.object(policy.time, 'time', return_value=1700604800):
                with self.assertRaisesRegex(ValueError, 'expired'): policy.envelope(args)
            self.assertFalse(out.exists())
            with mock.patch.object(policy.time, 'time', return_value=1700000000): policy.envelope(args)
            self.assertEqual(policy.read_envelope(out.read_bytes(), PUBLIC)[0], PAYLOAD.encode())

if __name__ == '__main__': unittest.main()
