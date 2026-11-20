#!/usr/bin/env python3
"""仅开发分支：下载独立锁定的已验证候选，不推断重新分发批准。"""
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import zipfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('prepare', HERE / 'prepare-media-runtime.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


def main():
    lock = json.loads((HERE / 'development-media-candidate.lock.json').read_text(encoding='utf-8'))
    prepare.development_candidate(lock['manifest_sha256'], lock['platform'], lock['arch'])
    if os.environ.get('GITHUB_REPOSITORY') != lock['repository'] or os.environ.get('GITHUB_REF') != 'refs/heads/feat/native-collaboration-bootstrap':
        raise ValueError('Only the fixed repository development branch can consume this candidate')
    base = f"repos/{lock['repository']}/actions"
    def api(path):
        return json.loads(subprocess.check_output(['gh', 'api', path]))
    run = api(f"{base}/runs/{lock['run_id']}")
    if run['head_sha'] != lock['source_commit'] or run['conclusion'] != 'success' or run['repository']['full_name'] != lock['repository']:
        raise ValueError('Candidate build provenance mismatch')
    artifact = api(f"{base}/artifacts/{lock['artifact_id']}")
    if artifact['expired'] or artifact['workflow_run']['id'] != lock['run_id'] or artifact['workflow_run']['head_sha'] != lock['source_commit']:
        raise ValueError('Expired or mismatched candidate artifact')
    out = Path(sys.argv[1]).resolve()
    out.mkdir(parents=True, exist_ok=False)
    archive = out / 'candidate.zip'
    with archive.open('wb') as stream:
        subprocess.run(['gh', 'api', f"{base}/artifacts/{lock['artifact_id']}/zip"], stdout=stream, check=True)
    if prepare.sha256(archive) != lock['zip_sha256']:
        raise ValueError('Candidate ZIP hash mismatch')
    with zipfile.ZipFile(archive) as z:
        seen = set()
        for item in z.infolist():
            path = PurePosixPath(item.filename)
            if path.is_absolute() or '..' in path.parts or '\\' in item.filename or ':' in item.filename or item.filename in seen or (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('Unsafe or duplicate candidate ZIP entry')
            seen.add(item.filename)
        z.extractall(out)
    source, manifest = out / 'runtime', out / 'candidate-manifest.json'
    prepare.validate(source, manifest, lock['manifest_sha256'], 'windows', 'x86_64', development=True)
    with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as env:
        for key, value in {'SURREAL_MEDIA_RUNTIME_MODE':'development-candidate', 'SURREAL_MEDIA_RUNTIME_SOURCE':source,
                           'SURREAL_MEDIA_RUNTIME_MANIFEST':manifest, 'SURREAL_MEDIA_RUNTIME_MANIFEST_SHA256':lock['manifest_sha256']}.items():
            env.write(f'{key}={value}\n')


if __name__ == '__main__':
    main()
