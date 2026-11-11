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


def stage(event, target, out, snapshot, host):
    if out.exists():
        raise ValueError('输出已存在；拒绝混用旧产物')
    binary = Path(event['executable'])
    with binary.open('rb') as f:
        magic = f.read(4)
    if ((target == 'windows' and magic[:2] != b'MZ') or
        (target == 'macos' and magic not in {b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf'})):
        raise ValueError('非目标平台可执行文件；此静态检查不能替代原生加载')
    if target == 'macos':
        contents = out / 'SurrealCK.app/Contents'
        installed = contents / 'MacOS/surreal-collaboration'
        installed.parent.mkdir(parents=True)
        (contents / 'Resources').mkdir()
        with (contents / 'Info.plist').open('wb') as f:
            plistlib.dump(dict(CFBundleExecutable=installed.name,
                CFBundleIdentifier=snapshot['app_id'], CFBundleName='SurrealCK',
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
    report = snapshot | dict(schema=1, purpose='collaboration-installer-input', platform=target,
        rust_host=host, features=sorted(event['features']), entrypoint='native-client/src/main.rs',
        executable=installed.relative_to(out).as_posix(), compiled_executable_sha256=digest,
        runtime_validation='not-run', dependency_closure='unverified', release_eligible=False,
        media_runtime='ffmpeg/ffplay not bundled; availability/device permissions unverified',
        updater='Sparkle SDK embedded by package.sh' if target == 'macos' else 'windows-auto-update helper in application binary')
    (out / 'desktop-build.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    return report


def seal(out):
    """在平台签名之后绑定包内入口；签名后的 hash 与编译 hash 分开记录。"""
    report = json.loads((out / 'desktop-build.json').read_text(encoding='utf-8'))
    binary = out / report['executable']
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
    preflight(args.platform, os.environ)
    host = next(line[6:] for line in subprocess.check_output(['rustc', '-vV'], text=True).splitlines() if line.startswith('host: '))
    cmd = command(args.platform, host)
    before = desktop.receipt.snapshot() | {'identity_inputs': desktop.identity_inputs(os.environ)}
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
    if (desktop.receipt.snapshot() | {'identity_inputs': desktop.identity_inputs(os.environ)}) != before:
        raise SystemExit('构建期间源码或公开配置改变')
    event = desktop.artifact(events, args.platform, Path.cwd(), FEATURES[args.platform])
    stage(event, args.platform, args.out, before, host)


if __name__ == '__main__':
    main()
