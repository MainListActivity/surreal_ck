#!/usr/bin/env python3
"""构建正式桌面安装器的手写协同入口；打包证据不等于安装或运行验收。"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

spec = importlib.util.spec_from_file_location('desktop', Path(__file__).with_name('desktop-enterprise-preview.py'))
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)
FEATURES = {k: list(v) for k, v in desktop.FEATURES.items()}
FEATURES['macos'].append('macos-auto-update')

media_spec = importlib.util.spec_from_file_location('media_runtime', Path(__file__).with_name('prepare-media-runtime.py'))
media = importlib.util.module_from_spec(media_spec)
media_spec.loader.exec_module(media)


def media_config(environ):
    names = ('SURREAL_MEDIA_RUNTIME_SOURCE', 'SURREAL_MEDIA_RUNTIME_MANIFEST',
             'SURREAL_MEDIA_RUNTIME_MANIFEST_SHA256')
    mode = environ.get('SURREAL_MEDIA_RUNTIME_MODE', 'release-approved')
    if mode not in ('release-approved', 'development-candidate'):
        raise ValueError('Unknown media runtime mode')
    if mode == 'development-candidate' and (environ.get('GITHUB_EVENT_NAME') == 'release' or environ.get('GITHUB_REF', '').startswith('refs/tags/')):
        raise ValueError('Development media candidates are forbidden in Release/tag builds')
    values = [environ.get(name) for name in names]
    if mode == 'development-candidate' and not all(values):
        raise ValueError('Development mode requires all pinned runtime inputs')
    if not any(value is not None for value in values):
        return None
    if not all(values):
        raise ValueError('媒体运行时配置必须同时提供 source、manifest 和固定 SHA256')
    source, manifest = map(Path, values[:2])
    if not source.is_absolute() or not manifest.is_absolute():
        raise ValueError('媒体运行时输入必须使用绝对路径')
    media.reject_root_link(source)
    media.reject_root_link(manifest)
    return dict(source=source, manifest=manifest, expected_hash=values[2], development=mode == 'development-candidate')


def runtime_inventory(root):
    files = {}
    for path in root.rglob('*'):
        if path.is_symlink() or (not path.is_file() and not path.is_dir()):
            raise ValueError('包内媒体树包含链接或特殊文件')
        if path.is_file():
            files[path.relative_to(root).as_posix()] = media.sha256(path)
    return files


def preflight(target, environ):
    if target == 'macos':
        for name in ('SPARKLE_FRAMEWORK_DIR', 'SPARKLE_EXPECTED_VERSION',
                     'SPARKLE_PUBLIC_ED_KEY', 'SPARKLE_FEED_URL', 'MACOS_SIGN_IDENTITY'):
            if not environ.get(name):
                raise ValueError('正式 macOS 包需要既有 Sparkle SDK/配置/签名身份：' + name)
        framework = Path(environ['SPARKLE_FRAMEWORK_DIR'])
        if not framework.is_absolute() or not (framework / 'Sparkle.framework/Headers/Sparkle.h').is_file():
            raise ValueError('需要事先核验的本地 Sparkle.framework')


def command(target, host):
    cmd = desktop.command(target, host, FEATURES[target])
    if target == 'macos':
        # 依赖 crate 的 rustc-link-arg 不保证传递给最终 bin；在 bin 上明确添加 rpath。
        cmd[1] = 'rustc'
        cmd += ['--', '-C', 'link-arg=-Wl,-rpath,@executable_path/../Frameworks']
    return cmd


def stage(event, target, out, snapshot, host, runtime=None):
    if out.exists():
        raise ValueError('输出已存在；拒绝混用旧产物')
    runtime_report = dict(status='not-bundled', input_validation='not-configured',
        runtime_validation='not-run', device_permissions='unverified')
    if runtime is not None:
        if out.resolve().is_relative_to(runtime['source'].resolve()):
            raise ValueError('媒体运行时目标不能位于输入树内')
        arch = host.split('-')[0]
        if arch not in ('x86_64', 'aarch64'):
            raise ValueError('不支持的媒体运行时架构')
        # 完整验证必须发生在创建应用目录或复制任何运行时文件之前。
        input_audit = media.validate(**runtime, platform=target, arch=arch)
    binary = Path(event['executable'])
    with binary.open('rb') as f:
        magic = f.read(4)
    if ((target == 'windows' and magic[:2] != b'MZ') or
        (target == 'macos' and magic not in {b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf'})):
        raise ValueError('非目标平台可执行文件；此静态检查不能替代原生加载')
    icon = desktop.brand_icon.verify() if target == 'macos' else None
    if target == 'macos':
        contents = out / '吉吉.app/Contents'
        installed = contents / 'MacOS/surreal-collaboration'
        installed.parent.mkdir(parents=True)
        (contents / 'Resources').mkdir()
        # 与预览打包器共用同一图标安装与校验逻辑；拒绝旧 assets/icon.icns。
        icon = desktop.brand_icon.install_app_icon(contents / 'Resources/AppIcon.icns')
        with (contents / 'Info.plist').open('wb') as f:
            plistlib.dump(dict(CFBundleExecutable=installed.name,
                CFBundleIdentifier=snapshot['app_id'], CFBundleName='吉吉', CFBundleDisplayName='吉吉', CFBundleIconFile='AppIcon.icns',
                CFBundlePackageType='APPL', CFBundleShortVersionString=snapshot['version'],
                CFBundleVersion=str(snapshot['build']), NSHighResolutionCapable=True,
                NSCameraUsageDescription='用户发起视频通话时访问摄像头。',
                NSMicrophoneUsageDescription='用户发起语音通话时访问麦克风。'), f)
    else:
        installed = out / 'SurrealCK/surreal-collaboration.exe'
        installed.parent.mkdir(parents=True)
    digest = desktop.receipt.digest(binary)
    shutil.copy2(binary, installed)
    if digest != desktop.receipt.digest(installed) or digest != desktop.receipt.digest(binary):
        raise ValueError('复制期间 binary 改变')
    if runtime is not None:
        destination = (installed.parent / 'media-runtime' if target == 'windows' else
                       installed.parent.parent / 'Resources/media-runtime')
        if destination.resolve().is_relative_to(runtime['source'].resolve()):
            raise ValueError('媒体运行时目标不能位于输入树内')
        try:
            shutil.copytree(runtime['source'], destination)
            copied_audit = media.validate(source=destination, manifest=runtime['manifest'],
                expected_hash=runtime['expected_hash'], platform=target, arch=arch,
                development=runtime.get('development', False))
        except Exception:
            if destination.exists():
                shutil.rmtree(destination)
            raise
        manifest_data = json.loads(runtime['manifest'].read_text(encoding='utf-8'))
        runtime_report = dict(status='bundled', input_validation='passed', copy_validation='passed',
            manifest_sha256=runtime['expected_hash'], platform=target, arch=arch,
            development_only=runtime.get('development', False), release_approved=manifest_data['release_approved'],
            path=destination.relative_to(out).as_posix(), files=runtime_inventory(destination),
            input_static_audit=input_audit, copied_static_audit=copied_audit,
            supplied_native_test_evidence=dict(path=manifest_data['native_test_evidence'],
                sha256=manifest_data['files'][manifest_data['native_test_evidence']]),
            runtime_validation='not-run-by-packager', device_permissions='unverified',
            code_signing='not-validated-by-media-preparation')
    report = snapshot | dict(schema=1, purpose='collaboration-installer-input', platform=target,
        rust_host=host, features=sorted(event['features']), entrypoint='native-client/src/main.rs',
        executable=installed.relative_to(out).as_posix(), compiled_executable_sha256=digest,
        runtime_validation='not-run', dependency_closure='unverified', release_eligible=False,
        media_runtime=runtime_report,
        updater='Sparkle SDK embedded by package.sh' if target == 'macos' else 'windows-auto-update helper in application binary')
    if icon is not None:
        report['app_icon'] = icon
    (out / 'desktop-build.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    return report


def seal(out):
    """在平台签名之后绑定包内入口；签名后的 hash 与编译 hash 分开记录。"""
    report = json.loads((out / 'desktop-build.json').read_text(encoding='utf-8'))
    binary = out / report['executable']
    runtime = report.get('media_runtime', {})
    if isinstance(runtime, dict) and runtime.get('status') == 'bundled':
        if runtime.get('development_only'):
            media.development_candidate(runtime['manifest_sha256'], report['platform'], runtime['arch'])
        root = out / runtime['path']
        if root.is_symlink() or not root.is_dir() or runtime_inventory(root) != runtime['files']:
            raise ValueError('包内媒体运行时在校验后改变；必须重新准备和审核')
        runtime['sealed_inventory_validation'] = 'passed'
        runtime['packaged_files'] = runtime_inventory(root)
    report['packaged_executable_sha256'] = desktop.receipt.digest(binary)
    report['packaged_executable_size'] = binary.stat().st_size
    if report['platform'] == 'macos':
        contents = binary.parent.parent
        info = plistlib.loads((contents / 'Info.plist').read_bytes())
        if info['CFBundleExecutable'] != binary.name or info['CFBundleIdentifier'] != report['app_id']:
            raise ValueError('包入口或应用身份与构建证据不一致')
        if not info.get('SUVerifyUpdateBeforeExtraction') or not info.get('SUPublicEDKey'):
            raise ValueError('缺少 Sparkle 验证配置')
        if not (contents / 'Frameworks/Sparkle.framework').is_dir():
            raise ValueError('缺少嵌入的 Sparkle.framework')
        if info.get('CFBundleIconFile') != 'AppIcon.icns' or not isinstance(report.get('app_icon'), dict):
            raise ValueError('缺少品牌 App 图标证据')
        desktop.brand_icon.check_installed(contents / 'Resources/AppIcon.icns', report['app_icon'])
        report['app_icon']['sealed_resource_validation'] = 'passed'
    (out.parent / 'desktop-package-evidence.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', choices=FEATURES, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--seal', action='store_true')
    args = parser.parse_args()
    if args.seal:
        seal(args.out)
        return
    if args.out.exists():
        parser.error('输出必须不存在')
    runtime = media_config(os.environ)
    preflight(args.platform, os.environ)
    host = next(line[6:] for line in subprocess.check_output(['rustc', '-vV'], text=True).splitlines() if line.startswith('host: '))
    cmd = command(args.platform, host)
    before = desktop.receipt.snapshot() | {'identity_inputs': desktop.identity_inputs(os.environ, args.platform)}
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
        raise SystemExit('Cargo 构建失败，未生成安装器输入')
    if (desktop.receipt.snapshot() | {'identity_inputs': desktop.identity_inputs(os.environ, args.platform)}) != before:
        raise SystemExit('构建期间源码或公开配置改变')
    event = desktop.artifact(events, args.platform, Path.cwd(), FEATURES[args.platform])
    stage(event, args.platform, args.out, before, host, runtime)


if __name__ == '__main__':
    main()
