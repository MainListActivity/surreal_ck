#!/usr/bin/env python3
"""原生无设备 smoke：仅合成媒体与 SDL dummy；绝不打开摄像头/麦克风/屏幕。"""
import argparse
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import struct
import tempfile
from datetime import datetime, timezone


def native_target():
    system = platform.system()
    target = {'Darwin': 'macos', 'Windows': 'windows'}.get(system)
    arch = {'AMD64': 'x86_64', 'x86_64': 'x86_64', 'arm64': 'aarch64', 'aarch64': 'aarch64'}.get(platform.machine())
    return target, arch


def clean_environment(environ):
    result = {key: value for key, value in environ.items()
              if key.upper() in ('SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE')}
    return result | {'PATH': '', 'SDL_AUDIODRIVER': 'dummy', 'SDL_VIDEODRIVER': 'dummy'}


def verify_binary(path, target, arch):
    raw = path.read_bytes()
    if target == 'windows':
        if len(raw) < 64 or raw[:2] != b'MZ':
            raise ValueError('Expected native PE executable')
        offset = struct.unpack_from('<I', raw, 60)[0]
        expected = 0x8664 if arch == 'x86_64' else 0xAA64
        if len(raw) < offset + 6 or raw[offset:offset + 4] != b'PE\0\0' or struct.unpack_from('<H', raw, offset + 4)[0] != expected:
            raise ValueError('Native PE architecture mismatch')
    else:
        expected = 0x01000007 if arch == 'x86_64' else 0x0100000C
        if len(raw) < 8 or raw[:4] != b'\xcf\xfa\xed\xfe' or struct.unpack_from('<I', raw, 4)[0] != expected:
            raise ValueError('Native Mach-O architecture mismatch')


def _smoke(root, target, arch, evidence_path=None):
    if native_target() != (target, arch):
        raise ValueError('Smoke must run on the exact native OS/architecture')
    root = root.resolve(strict=True)
    extension = '.exe' if target == 'windows' else ''
    ffmpeg = root / 'bin' / ('ffmpeg' + extension)
    ffplay = root / 'bin' / ('ffplay' + extension)
    evidence = dict(platform=target, arch=arch, started_at=datetime.now(timezone.utc).isoformat(),
                    host=platform.platform(), tests=[], device_access='none: synthetic inputs and SDL dummy only')
    for file in (ffmpeg, ffplay):
        if file.is_symlink() or not file.is_file():
            raise ValueError('Missing regular native media executable')
        verify_binary(file, target, arch)
    evidence['executable_sha256'] = {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in (ffmpeg, ffplay)}
    def save():
        if evidence_path is not None:
            evidence_path.write_text(json.dumps(evidence, indent=2) + '\n', encoding='utf-8')
    evidence['status'] = 'running'
    save()
    env = clean_environment(os.environ)
    with tempfile.TemporaryDirectory(prefix='ck-media-smoke-') as temp:
        work = Path(temp)
        def run(binary, args, input_file=None, output_file=None):
            command = [str(binary), *args]
            with ExitStack() as stack:
                stdin = stack.enter_context(input_file.open('rb')) if input_file else subprocess.DEVNULL
                stdout = stack.enter_context(output_file.open('wb')) if output_file else subprocess.PIPE
                try:
                    result = subprocess.run(command, cwd=work, env=env, stdin=stdin, stdout=stdout,
                                            stderr=subprocess.PIPE, text=True, timeout=60)
                except subprocess.TimeoutExpired as error:
                    evidence['tests'].append(dict(command=command, timed_out=True, error=str(error)))
                    save()
                    raise
            evidence['tests'].append(dict(command=command, returncode=result.returncode,
                stdout=result.stdout, stderr=result.stderr,
                stdin_file=input_file.name if input_file else None,
                stdout_file=output_file.name if output_file else None))
            save()
            if result.returncode:
                raise RuntimeError(f'Media smoke failed: {command}: {result.stderr}')
            return (result.stdout or '') + result.stderr
        for binary in (ffmpeg, ffplay):
            run(binary, ['-version'])
        evidence['clean_path'] = 'passed'
        common = ['-hide_banner', '-nostdin', '-y']
        run(ffmpeg, common + ['-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=30', '-frames:v', '6',
            '-c:v', 'libvpx', '-deadline', 'realtime', '-f', 'ivf', 'pipe:1'], output_file=work / 'video.ivf')
        run(ffmpeg, common + ['-f', 'ivf', '-i', 'pipe:0', '-pix_fmt', 'rgba', '-threads', '1', '-f', 'rawvideo', 'pipe:1'],
            input_file=work / 'video.ivf', output_file=work / 'video.rgba')
        if (work / 'video.rgba').stat().st_size != 64 * 48 * 4 * 6:
            raise ValueError('VP8 frame size/count mismatch')
        evidence['vp8_roundtrip'] = 'passed'
        run(ffmpeg, common + ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.2',
            '-ac', '2', '-c:a', 'libopus', '-frame_duration', '20', '-f', 'ogg', 'pipe:1'], output_file=work / 'audio.ogg')
        run(ffmpeg, common + ['-f', 'ogg', '-i', 'pipe:0', '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1'],
            input_file=work / 'audio.ogg', output_file=work / 'audio.pcm')
        pcm = (work / 'audio.pcm').read_bytes()
        if len(pcm) != 48000 * 2 * 2 // 5 or not any(pcm):
            raise ValueError('Opus sample size/count/content mismatch')
        evidence['opus_roundtrip'] = 'passed'
        run(ffplay, ['-hide_banner', '-loglevel', 'error', '-nodisp', '-autoexit', '-fflags', 'nobuffer', '-f', 'ogg', '-i', 'pipe:0'],
            input_file=work / 'audio.ogg')
        evidence['ffplay_dummy'] = 'passed'
        devices = run(ffmpeg, ['-hide_banner', '-devices'])
        required = ['avfoundation'] if target == 'macos' else ['dshow', 'gdigrab']
        if not all(any(name in line.split() for line in devices.splitlines()) for name in required):
            raise ValueError('Required capture backend was not compiled')
        evidence['device_backends_listed'] = 'passed'
    evidence['status'] = 'passed'
    save()
    return evidence


def smoke(root, target, arch, evidence_path=None):
    try:
        return _smoke(root, target, arch, evidence_path)
    except Exception as error:
        if evidence_path is not None:
            partial = (json.loads(evidence_path.read_text(encoding='utf-8')) if evidence_path.exists()
                       else dict(platform=target, arch=arch, tests=[]))
            partial.update(status='failed', error=str(error))
            evidence_path.write_text(json.dumps(partial, indent=2) + '\n', encoding='utf-8')
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--platform', choices=['windows', 'macos'], required=True)
    parser.add_argument('--arch', choices=['x86_64', 'aarch64'], required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        parser.error('Evidence output already exists')
    result = smoke(args.root, args.platform, args.arch, args.out)
    args.out.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
