import hashlib, json, pathlib, subprocess
out=pathlib.Path(__file__).parent
root=pathlib.Path('/workspace/scratch/115bfa675150/collaboration-runtime-e2e')
r=json.loads((out/'build-receipt.json').read_text())
first=r['commands'][0]
libs={first[i+1].split('=',1)[0]:first[i+1].split('=',1)[1] for i,x in enumerate(first) if x=='--extern'}
libs.update({name:str(out/('lib'+name+'.rlib')) for name in ['surreal_ck_peer_transport','surreal_ck_native_media_platform','surreal_ck_native_call']})
cases=[('transport_unit','native-transport/src/lib.rs',['bytes','tokio','thiserror','webrtc','sha2','serde_json','libc']), ('manual_verification','native-transport/tests/manual_verification.rs',['tokio','surreal_ck_peer_transport']), ('desktop_call','native-call/tests/desktop_call.rs',['bytes','tokio','surreal_ck_native_call','surreal_ck_peer_transport']), ('call_unit','native-call/src/lib.rs',['bytes','tokio','thiserror','surreal_ck_peer_transport','surreal_ck_native_media_platform'])]
summary=[]
for name,source,deps in cases:
    args=[first[0],'--edition=2021','--crate-name',name,'--test','-D','warnings','-C','debuginfo=0','-C','strip=debuginfo','-L','dependency='+str(out),'-L',first[first.index('-L')+3],'-o',str(out/name),str(root/source)]
    for dep in deps: args+=['--extern',dep+'='+libs[dep]]
    print('Building',name,flush=True)
    subprocess.run(args,cwd=root,check=True)
    with (out/(name+'.log')).open('w') as log:
        p=subprocess.run([str(out/name),'--nocapture'],cwd=root,stdout=log,stderr=subprocess.STDOUT,timeout=65)
    print((out/(name+'.log')).read_text(),flush=True)
    summary.append({'name':name,'compile':args,'exit':p.returncode,'sha256':hashlib.sha256((out/name).read_bytes()).hexdigest()})
    (out/'regressions.json').write_text(json.dumps(summary,indent=2)+'\n')
    if p.returncode: raise SystemExit(p.returncode)
