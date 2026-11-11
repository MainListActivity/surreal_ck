#!/usr/bin/env python3
"""Read-only audit of prepared media runtime. Never downloads or executes it.
This does not validate licenses, source completeness, or runtime behavior.
"""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess

SYSTEM_WINDOWS = set('avicap32 iphlpapi msimg32 ncrypt advapi32 avrt bcrypt bcryptprimitives cfgmgr32 comctl32 comdlg32 crypt32 d3d11 d3d12 dcomp dbghelp dwmapi dxgi gdi32 imm32 kernel32 mfuuid mf mfplat mfreadwrite msvcrt ntdll ole32 oleaut32 opengl32 powrprof propsys psapi rpcrt4 secur32 setupapi shell32 shlwapi user32 userenv ucrtbase uuid version winmm winspool wintrust ws2_32 wtsapi32'.split())

def audit(root, target, tool):
    root = root.resolve(strict=True)
    ext = '.exe' if target == 'windows' else ''
    required = [root / 'bin' / (name + ext) for name in ('ffmpeg', 'ffplay')]
    for file in required:
        if not file.is_file(): raise ValueError('Missing executable: ' + str(file))
    records = []
    files = [p for p in root.rglob('*') if p.is_file()]
    names = {p.name.lower(): p for p in files}
    for file in files:
        if not file.resolve().is_relative_to(root): raise ValueError('Symlink escapes runtime: ' + str(file))
        header = file.read_bytes()[:4]
        binary = header[:2] == b'MZ' if target == 'windows' else header in (b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xca\xfe\xba\xbf')
        if not binary: continue
        command = [tool or 'objdump', '-p', str(file)] if target == 'windows' else [tool or 'otool', '-L', str(file)]
        result = subprocess.run(command, check=True, capture_output=True, text=True).stdout
        deps = re.findall(r'DLL Name:\s*(\S+)', result) if target == 'windows' else [line.strip().split(' (')[0] for line in result.splitlines()[1:]]
        for dep in deps:
            if target == 'windows':
                name = dep.lower()
                if name.removesuffix('.dll') in SYSTEM_WINDOWS or name.startswith(('api-ms-win-', 'ext-ms-win-')): continue
                if name not in names or names[name].parent != root / 'bin': raise ValueError(f'Unbundled PE dependency in executable directory: {file.name}: {dep}')
            else:
                if dep.startswith(('/System/Library/', '/usr/lib/')): continue
                if dep.startswith('@loader_path/'):
                    resolved = (file.parent / dep.removeprefix('@loader_path/')).resolve()
                elif dep.startswith('@executable_path/'):
                    resolved = (root / 'bin' / dep.removeprefix('@executable_path/')).resolve()
                else:
                    raise ValueError(f'Unresolved Mach-O dependency (including unverified rpath): {file.name}: {dep}')
                if not resolved.is_relative_to(root) or not resolved.is_file():
                    raise ValueError(f'Missing/escaping Mach-O dependency: {dep}')
        records.append(dict(path=str(file.relative_to(root)), sha256=hashlib.sha256(file.read_bytes()).hexdigest(), dependencies=deps))
    if not all(any(r['path'] == str(f.relative_to(root)) for r in records) for f in required):
        raise ValueError('Expected real platform executable headers')
    return dict(platform=target, dependency_audit='static-imports-passed', runtime_execution='not-tested', source_license_compliance='not-validated', files=records)

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('root', type=pathlib.Path)
    p.add_argument('--platform', choices=['windows', 'macos'], required=True)
    p.add_argument('--inspection-tool')
    args = p.parse_args()
    print(json.dumps(audit(args.root, args.platform, args.inspection_tool), indent=2))
