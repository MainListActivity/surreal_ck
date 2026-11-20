#!/usr/bin/env python3
"""复核已安装 app-local 媒体树，再执行无设备 smoke。"""
import importlib.util
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent

def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    root, package_path, output = map(Path, sys.argv[1:])
    package = json.loads(package_path.read_text(encoding='utf-8-sig'))
    runtime = package['media_runtime']
    if runtime.get('status') != 'bundled':
        raise ValueError('Expected installed app-local media runtime')
    builder = load('build-desktop-app')
    if root.is_symlink() or builder.runtime_inventory(root) != runtime['packaged_files']:
        raise ValueError('Installed media inventory differs from sealed package')
    if runtime.get('development_only'):
        builder.media.development_candidate(runtime['manifest_sha256'], 'windows', 'x86_64')
    load('media-runtime').audit(root, 'windows', None)
    result = load('smoke-media-runtime').smoke(root, 'windows', 'x86_64', output)
    result.update(installed_inventory_validation='passed', business_validation='unverified', device_validation='unverified', release_eligible=False)
    output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
