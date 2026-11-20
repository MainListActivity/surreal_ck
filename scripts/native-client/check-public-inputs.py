#!/usr/bin/env python3
"""离线检查公开构建输入；不证明远端登记、签名密钥归属或服务可用。"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
from update_config import parse_config

spec = importlib.util.spec_from_file_location('preview', Path(__file__).with_name('desktop-enterprise-preview.py'))
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


def check(environ, target, require_configured=False):
    identity = preview.identity_inputs(environ, target)
    raw = environ.get('SURREAL_UPDATE_CONFIG_JSON', '')
    if raw:
        parse_config(raw)
    update = 'configured-unverified' if raw else 'absent-blocked'
    if require_configured and (identity['state'] == 'absent-blocked' or not raw):
        raise ValueError('缺少真实公开身份或更新配置；保持更新锁定，不可发布为可用客户端')
    return dict(platform=target, identity_inputs=identity, update_config=update,
                registration_verified=False, policy_verified=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', required=True, choices=['macos', 'windows', 'android', 'linux'])
    parser.add_argument('--require-configured', action='store_true')
    args = parser.parse_args()
    try:
        report = check(os.environ, args.platform, args.require_configured)
    except (ValueError, TypeError):
        # JSON 解析错误可能含输入片段，统一抑制值。
        parser.exit(1, '公开配置缺失或校验失败（值不输出）；请检查宿主 callback 与更新配置契约。\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
