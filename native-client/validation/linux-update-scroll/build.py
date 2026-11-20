import hashlib, json, os, pathlib, subprocess
root=pathlib.Path('/workspace/scratch/115bfa675150/linux-gui-runtime')
cache=pathlib.Path('/workspace/scratch/115bfa675150/native-client-probe/surreal_ck/native-client/target/debug')
out=pathlib.Path(__file__).parent
rustc='/workspace/scratch/115bfa675150/native-client-probe/rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin/rustc'
local={'surreal_ck_peer_transport':'native-transport','surreal_ck_native_media_platform':'native-media-platform','surreal_ck_native_call':'native-call','surreal_ck_native_identity':'native-identity','surreal_ck_native_updater':'native-updater','surreal_ck_native_video_view':'native-video-view','nsh_app_native_client':'native-client'}
manifest=json.loads((cache/'.fingerprint/nsh-app-native-client-7429cb8b025fca51/lib-nsh_app_native_client.json').read_text())
record={'base':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'commands':[],'sources':{},'outputs':{}}
compiled={}
def resolve(name,fp):
    for f in (cache/'.fingerprint').glob('*/lib-'+name):
        if int.from_bytes(bytes.fromhex(f.read_text().strip()),'little')==fp:
            stem='lib'+name+'-'+f.parent.name.rsplit('-',1)[1]
            for ext in ['.rlib','.so']:
                lib=cache/'deps'/(stem+ext)
                if lib.exists():return lib,json.loads(f.with_suffix('.json').read_text())
    raise RuntimeError('missing '+name+' '+str(fp))
def flags(deps):
    args=[]
    for name,path in deps.items(): args+=['--extern',name+'='+str(path)]
    return args
def invoke(name,source,deps,test=False,binary=False,features=[]):
    dest=out/(name if test or binary else 'lib'+name+'.rlib')
    args=[rustc,'--edition=2024' if name in ['nsh_app_native_client','client_gui','ui_tests'] else '--edition=2021','--crate-name',name,'--test' if test else '--crate-type=bin' if binary else '--crate-type=rlib','-C','debuginfo=0','-C','strip=debuginfo','-L','dependency='+str(out),'-L','dependency='+str(cache/'deps'),'-L','native=/workspace/scratch/115bfa675150/native-client-probe/sysroot/usr/lib/x86_64-linux-gnu','-o',str(dest),str(root/source)]
    for feature in features:args+=['--cfg','feature="'+feature+'"']
    args+=flags(deps)
    env=os.environ.copy()
    env.update(CARGO_PKG_VERSION='0.1.0',CARGO_PKG_NAME='nsh-app-native-client',CARGO_MANIFEST_DIR=str(root/'native-client'),CARGO_MANIFEST_PATH=str(root/'native-client/Cargo.toml'))
    record['commands'].append(args)
    print('Building',name,flush=True)
    subprocess.run(args,cwd=root,env=env,check=True)
    record['outputs'][dest.name]=hashlib.sha256(dest.read_bytes()).hexdigest()
    return dest
def build(name,details):
    if name in compiled:return compiled[name]
    deps={}
    for _,dep,_,fp in details['deps']:
        path,meta=resolve(dep,fp)
        deps[dep]=build(dep,meta) if dep in local else path
    path=invoke(name,local[name]+'/src/lib.rs',deps,features=json.loads(details['features']))
    compiled[name]=path
    return path
client=build('nsh_app_native_client',manifest)
# The desktop platform is an existing read-only third party dependency.
platform_meta=json.loads((cache/'.fingerprint/nsh-app-native-client-aa0787da2e36cd81/lib-nsh_app_native_client.json').read_text())
platform_fp=next(fp for _,name,_,fp in platform_meta['deps'] if name=='nsh_platform_linux')
platform,_=resolve('nsh_platform_linux',platform_fp)
client_deps={name:path for name,path in compiled.items()}
for _,name,_,fp in manifest['deps']:
    if name not in client_deps:client_deps[name]=resolve(name,fp)[0]
invoke('client_gui','native-client/src/main.rs',dict(client_deps,nsh_platform_linux=platform),binary=True,features=['desktop'])
# Resolve testing crates from an existing Cargo UI test to preserve matching NSH versions.
ui_fp=cache/'.fingerprint'
candidates=[]
for path in ui_fp.glob('nsh-app-native-client-*/test-integration-test-ui.json'):
    meta=json.loads(path.read_text())
    try:
        ds={name:resolve(name,fp)[0] for _,name,_,fp in meta['deps'] if name in ['nsh_core','nsh_engine','nsh_testing']}
        if ds.get('nsh_core')==client_deps['nsh_core']:candidates.append((path.stat().st_mtime,ds))
    except RuntimeError:pass
assert candidates
ui_deps=max(candidates,key=lambda x:x[0])[1]
invoke('ui_tests','native-client/tests/ui.rs',dict(ui_deps,nsh_app_native_client=client),test=True)
for folder in local.values():
    for p in (root/folder/'src').rglob('*.rs'):record['sources'][str(p.relative_to(root))]=hashlib.sha256(p.read_bytes()).hexdigest()
record['sources']['native-client/tests/ui.rs']=hashlib.sha256((root/'native-client/tests/ui.rs').read_bytes()).hexdigest()
(out/'build-receipt.json').write_text(json.dumps(record,indent=2)+'\n')
