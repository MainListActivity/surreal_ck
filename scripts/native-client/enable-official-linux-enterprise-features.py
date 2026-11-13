#!/usr/bin/env python3
"""Patch NSH-generated path deps so official Linux packages include enterprise features.

NSH writes `native-client/.nsh/rust/*/Cargo.toml` with
`nsh-app-native-client` default features only. Official Linux packaging
injects experimental-enterprise-media and experimental-enterprise-files
(which pull in experimental-enterprise-signaling) immediately before each
cargo invocation. This does not change the crate's `default` or `desktop`
feature graphs, which check-enterprise-signaling.sh still requires stay
exclusive of the enterprise preview.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

FEATURES = '["experimental-enterprise-media", "experimental-enterprise-files"]'
DEPENDENCY = re.compile(
    r'app_nsh_app_native_client = \{ package = "nsh-app-native-client", '
    r'path = "([^"]+)"(?:, features = \[[^\]]*\])? \}'
)


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def generated_workspace(root: Path | None = None) -> Path:
    return (root or repo_root()) / 'native-client' / '.nsh' / 'rust'


def patch_text(text: str) -> tuple[str, int]:
    def repl(match: re.Match[str]) -> str:
        return (
            'app_nsh_app_native_client = { package = "nsh-app-native-client", '
            f'path = "{match.group(1)}", features = {FEATURES} }}'
        )

    return DEPENDENCY.subn(repl, text)


def patch_workspace(workspace: Path) -> int:
    if not workspace.is_dir():
        return 0
    changed = 0
    for path in sorted(workspace.rglob('Cargo.toml')):
        original = path.read_text(encoding='utf-8')
        updated, count = patch_text(original)
        if count and updated != original:
            path.write_text(updated, encoding='utf-8')
            changed += count
    return changed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--workspace',
        type=Path,
        default=None,
        help='NSH-generated rust workspace (default: native-client/.nsh/rust)',
    )
    args = parser.parse_args(argv)
    workspace = args.workspace if args.workspace is not None else generated_workspace()
    changed = patch_workspace(workspace)
    print(f'official linux enterprise features: patched {changed} nsh path deps in {workspace}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
