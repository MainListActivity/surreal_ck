#!/usr/bin/env python3
"""Verify one pinned, already-built collaboration APK before a standalone install test.
This is deliberately not a general downloader or an arbitrary APK execution interface.
"""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

REPOSITORY = 'MainListActivity/surreal_ck'
REPOSITORY_ID = 1201323545
RUN_ID = 42968179684
ARTIFACT_ID = 13832646937
COMMIT = '9fea4755bf0aa5f87b901cf1d522b56c56114f2e'
ARTIFACT_DIGEST = 'sha256:9061bd4f56793a64db6abe37d19b517652cd7a9af33925a12ab80851b12913a8'
APK_SHA256 = '7655ea86ba8d3c84b2c6063bd041f6cadead9bb595ccd96cc6e69e2fce738df0'
APK_NAME = 'SurrealCK-android-test-key.apk'
ARTIFACT_NAME = 'native-client-android-ubuntu-24.04'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify(folder, metadata):
    run, artifact = metadata['run'], metadata['artifact']
    require(run['id'] == RUN_ID and run['head_sha'] == COMMIT, 'Unexpected source run/commit')
    require(run['repository']['full_name'] == REPOSITORY and run['repository']['id'] == REPOSITORY_ID,
            'Unexpected source repository')
    require(run['head_repository']['id'] == REPOSITORY_ID and run['head_branch'] == 'feat/native-collaboration-bootstrap',
            'Source must be the approved same-repository development branch')
    require(run['event'] == 'push' and run['status'] == 'completed' and
            run['path'] == '.github/workflows/native-client-release.yml', 'Unexpected source workflow/event/status')
    require(artifact['id'] == ARTIFACT_ID and artifact['name'] == ARTIFACT_NAME and
            artifact['expired'] is False and artifact['digest'] == ARTIFACT_DIGEST, 'Unexpected artifact identity/digest')
    origin = artifact['workflow_run']
    require(origin['id'] == RUN_ID and origin['head_sha'] == COMMIT and
            origin['repository_id'] == REPOSITORY_ID and origin['head_repository_id'] == REPOSITORY_ID,
            'Artifact belongs to another run/repository')
    apks = list(folder.glob('*.apk'))
    require(len(apks) == 1 and apks[0].name == APK_NAME and not apks[0].is_symlink(), 'Expected exactly the pinned APK')
    apk = apks[0]
    actual = digest(apk)
    require(actual == APK_SHA256, 'APK bytes do not match the approved source artifact')
    receipt = json.loads((folder/'android-ubuntu-24.04-build-receipt.json').read_text())
    require(receipt['commit'] == COMMIT and receipt['dirty'] is False and receipt['platform'] == 'android' and
            receipt['app_id'] == 'top.maplayer.collaboration', 'Build receipt provenance mismatch')
    require(receipt['filename'] == APK_NAME and receipt['sha256'] == actual and receipt['size'] == apk.stat().st_size,
            'APK does not match build receipt')
    require(receipt['update_config'] == 'absent-blocked' and receipt['update_config_sha256'] is None,
            'Pinned smoke expects missing update configuration, without gate bypass')
    evidence = json.loads((folder/'android-ubuntu-24.04-package-evidence.json').read_text())
    require(evidence['platform'] == 'android' and evidence['requested_host_mode'] == 'collaboration' and
            evidence['apk_filename'] == APK_NAME and evidence['apk_sha256'] == actual and
            evidence['apk_size'] == apk.stat().st_size, 'Package evidence mismatch')
    require(evidence['signature_verified'] is True and evidence['signing_identity_preserved'] is True and
            evidence['original_resources_preserved'] is True and evidence['zip_alignment'] == '16KiB verified',
            'Package verification is incomplete')
    require(set(evidence['native_sha256']) == {'arm64-v8a', 'x86_64'}, 'Expected both Android ABIs')
    with zipfile.ZipFile(apk) as archive:
        require(len(archive.namelist()) == len(set(archive.namelist())), 'Duplicate APK entries')
        for abi, expected in evidence['native_sha256'].items():
            require(hashlib.sha256(archive.read(f'lib/{abi}/libnsh.so')).hexdigest() == expected,
                    'Native library differs from package evidence')
    return dict(repository=REPOSITORY, run_id=RUN_ID, artifact_id=ARTIFACT_ID, commit=COMMIT,
                apk_filename=APK_NAME, apk_sha256=actual, source_verification='passed',
                scope='Install/start of pinned 9fea475 artifact, not the current checkout build',
                update_config='absent-blocked', update_gate_bypassed=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifact_directory', type=Path)
    parser.add_argument('metadata_json', type=Path)
    parser.add_argument('output_json', type=Path)
    args = parser.parse_args()
    result = verify(args.artifact_directory, json.loads(args.metadata_json.read_text()))
    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
