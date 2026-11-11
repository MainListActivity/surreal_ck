#!/usr/bin/env python3
"""独立 test-only 桌面企业预览 staging；不发布，不替换默认 NSH 安装包。"""
import hashlib
import re
from urllib.parse import urlsplit
import argparse
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

spec = importlib.util.spec_from_file_location('receipt', Path(__file__).with_name('build-receipt.py'))
receipt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipt)
# 共用安装器 receipt 范围，包含企业信令源码。

FEATURES = {
    'macos': ['desktop', 'experimental-enterprise-media', 'experimental-enterprise-files', 'experimental-macos-video'],
    'windows': ['desktop', 'experimental-enterprise-media', 'experimental-enterprise-files', 'experimental-windows-video', 'windows-auto-update'],
}
HOSTS = {'macos': {'aarch64-apple-darwin', 'x86_64-apple-darwin'},
         'windows': {'x86_64-pc-windows-msvc'}}


PUBLIC_KEYS = tuple('SURREAL_CK_' + key for key in (
    'OIDC_ISSUER', 'API_BASE_URL', 'OIDC_CLIENT_ID', 'OIDC_AUDIENCE',
    'NATIVE_REDIRECT_URI', 'OIDC_TOKEN_MODE', 'OIDC_ALLOWED_HOSTS', 'SURREAL_URL', 'SURREAL_NS'))


def identity_inputs(environ, target=None):
    # 只读取明确允许的公开配置；不枚举或读取 secret/token/password 变量。
    values = {key: environ.get(key) for key in PUBLIC_KEYS}
    configured = any(value is not None for value in values.values())
    if configured:
        def value(key):
            return values['SURREAL_CK_' + key]
        def url(raw, scheme=None, require_host=True):
            if not isinstance(raw, str) or not raw or any(c.isspace() for c in raw):
                raise ValueError('无效公开身份 URL（值不输出）')
            try:
                parsed = urlsplit(raw)
                _ = parsed.port
            except ValueError:
                raise ValueError("无效公开身份 URL 结构（值不输出）") from None
            if ((require_host and not parsed.hostname) or parsed.username is not None or parsed.password is not None
                    or '?' in raw or '#' in raw or (scheme and parsed.scheme != scheme)):
                raise ValueError('公开身份 URL 必须无凭据/query/fragment')
            _ = parsed.port  # 拒绝非法端口
            return parsed
        issuer = url(value('OIDC_ISSUER'), 'https')
        url(value('API_BASE_URL'), 'https')
        for key in ('OIDC_CLIENT_ID', 'OIDC_AUDIENCE'):
            v = value(key)
            if not isinstance(v, str) or not v.strip() or len(v) > 2048 or any(ord(c) < 32 for c in v):
                raise ValueError('缺少或无效公开 client/audience')
        if value('OIDC_CLIENT_ID') == 'change_me':
            raise ValueError('拒绝占位 client ID')
        redirect = url(value('NATIVE_REDIRECT_URI'), require_host=False)
        loopback = redirect.scheme == 'http' and redirect.hostname in ('127.0.0.1', '::1') and redirect.port not in (None, 0)
        custom = '.' in redirect.scheme and redirect.path.startswith('/')
        if (not loopback and not custom) or redirect.path in ('', '/'):
            raise ValueError('无效原生 redirect')
        if target in ('macos', 'windows', 'linux') and not loopback:
            raise ValueError('桌面宿主仅支持固定端口 IP loopback callback')
        if target == 'android' and value('NATIVE_REDIRECT_URI') != 'top.maplayer.collaboration:/auth/callback':
            raise ValueError('Android callback 必须匹配已打包宿主契约')
        mode = value('OIDC_TOKEN_MODE') if value('OIDC_TOKEN_MODE') is not None else 'confidential-proxy'
        if mode not in ('confidential-proxy', 'public-pkce-discovery'):
            raise ValueError('无效 token mode')
        raw_hosts = value('OIDC_ALLOWED_HOSTS')
        hosts = []
        if raw_hosts is not None:
            hosts = [h.strip() for h in raw_hosts.split(',')]
            for h in hosts:
                parsed = url('https://' + h, 'https')
                if '*' in h or parsed.hostname != h or parsed.port is not None or parsed.path:
                    raise ValueError('无效 OIDC host allowlist')
        if mode == 'public-pkce-discovery' and (not hosts or issuer.hostname not in hosts or issuer.port not in (None, 443)):
            raise ValueError('public PKCE issuer 不匹配允许主机/443端口')
        database = url(value('SURREAL_URL'), 'wss')
        namespace = value('SURREAL_NS') if value('SURREAL_NS') is not None else 'main'
        if database.path != '/rpc' or not re.fullmatch(r'[A-Za-z0-9_]{1,128}', namespace):
            raise ValueError('无效 Surreal endpoint/namespace')
    encoded = json.dumps(values, sort_keys=True, separators=(',', ':')).encode()
    return {'state': 'configured-unverified' if configured else 'absent-blocked',
            'sha256': hashlib.sha256(encoded).hexdigest(),
            'present_fields': [k for k, v in values.items() if v is not None]}


def command(target, host, features=None):
    if host not in HOSTS[target]:
        raise ValueError('必须在对应原生 runner 构建，禁止以交叉编译冒充原生验证')
    return ['cargo', 'build', '--manifest-path', 'native-client/Cargo.toml', '--locked',
            '--release', '--target', host, '--bin', 'surreal-collaboration',
            '--features', ','.join(features or FEATURES[target]), '--message-format=json-render-diagnostics']


def artifact(events, target, root, features=None):
    matches = []
    for event in events:
        t = event.get('target', {})
        if event.get('reason') != 'compiler-artifact' or t.get('name') != 'surreal-collaboration':
            continue
        if t.get('kind') != ['bin'] or not event.get('executable'):
            continue
        if Path(t['src_path']).resolve() != (root / 'native-client/src/main.rs').resolve():
            raise ValueError('产物不是手写 desktop main')
        if not set(features or FEATURES[target]).issubset(event.get('features', [])):
            raise ValueError('产物缺少必需企业或平台 renderer feature')
        if event.get('profile', {}).get('test') or event.get('profile', {}).get('opt_level') != '3':
            raise ValueError('产物不是预期 release binary')
        matches.append(event)
    if len(matches) != 1:
        raise ValueError('必须唯一匹配 Cargo binary 产物')
    return matches[0]


def stage(event, target, out, snapshot, host):
    if out.exists():
        raise ValueError('输出必须不存在，拒绝混用或覆盖旧产物')
    binary = Path(event['executable'])
    with binary.open('rb') as f:
        magic = f.read(4)
    allowed = {b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf'}
    if (target == 'macos' and magic not in allowed) or (target == 'windows' and magic[:2] != b'MZ'):
        raise ValueError('不是预期平台可执行文件；magic 检查不能替代原生加载验证')
    out.mkdir(parents=True)
    if target == 'macos':
        contents = out / 'SurrealCK Enterprise Test Only.app/Contents'
        (contents / 'MacOS').mkdir(parents=True)
        (contents / 'Resources').mkdir()
        installed = contents / 'MacOS/surreal-collaboration'
        with (contents / 'Info.plist').open('wb') as f:
            plistlib.dump(dict(CFBundleExecutable=installed.name,
                              CFBundleIdentifier='top.maplayer.collaboration.enterprise-preview',
                              CFBundleName='SurrealCK Enterprise Test Only', CFBundlePackageType='APPL',
                              CFBundleShortVersionString=snapshot['version'],
                              CFBundleVersion=str(snapshot['build']), NSHighResolutionCapable=True,
                              NSCameraUsageDescription='企业测试通话由用户操作后请求摄像头。',
                              NSMicrophoneUsageDescription='企业测试通话由用户操作后请求麦克风。'), f)
    else:
        installed = out / 'SurrealCK Enterprise Test Only/surreal-collaboration.exe'
        installed.parent.mkdir()
    before = receipt.digest(binary)
    shutil.copy2(binary, installed)
    if receipt.digest(installed) != before or receipt.digest(binary) != before:
        raise ValueError('复制期间 binary 改变')
    report = snapshot | dict(schema=1, purpose='enterprise-preview-test-only',
        platform=target, rust_host=host, features=sorted(event['features']),
        executable=str(installed.relative_to(out)), executable_sha256=before,
        executable_size=installed.stat().st_size, release_eligible=False,
        signing='not-signed-by-this-script', installer='not-created; staging-only',
        dependency_closure='unverified', runtime_validation='not-run',
        app_resources='brand SVG and theme embedded; dependency resource closure and launch unverified',
        media_runtime='not-bundled; ffmpeg/ffplay availability and device permissions unverified')
    (out / 'preview-receipt.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    (out / 'TEST-ONLY.txt').write_text(
        '仅企业实验 staging，不是已验收安装器。未签名/公证；动态依赖闭包未验证。\n'
        'ffmpeg/ffplay 未捆绑，媒体功能不可假定可用。\n'
        '强制更新门保持不变；缺少有效配置/策略仍锁定。不得进入正式 Release 索引。\n', encoding='utf-8')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', choices=FEATURES, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        parser.error('输出必须不存在')
    host = next(line[6:] for line in subprocess.check_output(['rustc', '-vV'], text=True).splitlines()
                if line.startswith('host: '))
    cmd = command(args.platform, host)
    before = receipt.snapshot() | {"identity_inputs": identity_inputs(os.environ, args.platform)}
    env = os.environ | {'CARGO_BUILD_JOBS': '1', 'CARGO_INCREMENTAL': '0'}
    env.setdefault('CARGO_TARGET_DIR', str(Path('native-client/target').resolve()))
    events = []
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True, encoding='utf-8', env=env)
    for line in process.stdout:
        event = json.loads(line)
        if event.get('reason') == 'compiler-artifact':
            events.append(event)
        elif event.get('reason') == 'compiler-message':
            print(event.get('message', {}).get('rendered', ''), file=sys.stderr, end='')
    if process.wait() != 0:
        raise SystemExit('Cargo 构建失败，未生成预览 staging')
    if (receipt.snapshot() | {"identity_inputs": identity_inputs(os.environ, args.platform)}) != before:
        raise SystemExit('构建期间源码或公开更新配置改变')
    event = artifact(events, args.platform, Path.cwd())
    report = stage(event, args.platform, args.out, before, host)
    print(json.dumps({'receipt': str(args.out / 'preview-receipt.json'),
                      'sha256': report['executable_sha256'], 'release_eligible': False}))


if __name__ == '__main__':
    main()
