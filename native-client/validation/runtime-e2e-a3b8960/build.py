import hashlib, json, os, pathlib, subprocess
root = pathlib.Path('/workspace/scratch/115bfa675150/collaboration-runtime-e2e')
cache = pathlib.Path('/workspace/scratch/115bfa675150/native-client-probe/surreal_ck/native-client/target/debug')
out = pathlib.Path(__file__).parent
rustc = '/workspace/scratch/115bfa675150/native-client-probe/rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin/rustc'
# Resolve the exact third party dependency set of an existing Cargo build.
manifest = json.loads((cache/'.fingerprint/surreal-ck-peer-transport-6b54d52903906938/lib-surreal_ck_peer_transport.json').read_text())
def resolve(name, fingerprint):
    for f in (cache/'.fingerprint').glob('*/lib-'+name):
        if int.from_bytes(bytes.fromhex(f.read_text().strip()), 'little') == fingerprint:
            lib=cache/'deps'/('lib'+name+'-'+f.parent.name.rsplit('-',1)[1]+'.rlib')
            if lib.is_file(): return lib
    raise RuntimeError('missing exact cached dependency '+name)
libs={name:resolve(name, fp) for _,name,_,fp in manifest['deps']}
builds=[('surreal_ck_peer_transport','native-transport/src/lib.rs',list(libs)), ('surreal_ck_native_media_platform','native-media-platform/src/lib.rs',['bytes','tokio','thiserror']), ('surreal_ck_native_call','native-call/src/lib.rs',['bytes','tokio','thiserror','surreal_ck_peer_transport','surreal_ck_native_media_platform']), ('one_to_one_session','native-call/tests/one_to_one_session.rs',['bytes','tokio','surreal_ck_peer_transport','surreal_ck_native_call'])]
record={'base':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'rustc':subprocess.check_output([rustc,'--version'],text=True).strip(),'note':'Direct rustc compile of current local crates and test; cached third party dependencies are read only. No Cargo target writes.','commands':[],'inputs':{},'outputs':{}}
for path in sorted(root.glob('native-*/**/*.rs')):
    if '/target/' not in str(path): record['inputs'][str(path.relative_to(root))]=hashlib.sha256(path.read_bytes()).hexdigest()
for name,source,deps in builds:
    test=name=='one_to_one_session'
    dest=out/(name if test else 'lib'+name+'.rlib')
    args=[rustc,'--edition=2021','--crate-name',name,'--test' if test else '--crate-type=rlib','-C','debuginfo=0','-C','strip=debuginfo','-L','dependency='+str(out),'-L','dependency='+str(cache/'deps'),'-o',str(dest),str(root/source)]
    for dep in deps: args += ['--extern',dep+'='+str(libs[dep])]
    record['commands'].append(args)
    print('Building',name,flush=True)
    subprocess.run(args,cwd=root,check=True)
    libs[name]=dest
    record['outputs'][dest.name]=hashlib.sha256(dest.read_bytes()).hexdigest()
for dep,lib in libs.items():
    if lib.parent == cache/'deps': record['inputs'][str(lib)]=hashlib.sha256(lib.read_bytes()).hexdigest()
(out/'build-receipt.json').write_text(json.dumps(record,indent=2)+'\n')
print('Build receipt:',out/'build-receipt.json')
