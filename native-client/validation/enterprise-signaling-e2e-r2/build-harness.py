"""组合原样生产模块与仅cfg(test)身份fixture；不增加生产测试后门。"""
import argparse, hashlib, json, pathlib, re
p=argparse.ArgumentParser();p.add_argument('--output',required=True);a=p.parse_args()
repo=pathlib.Path(__file__).resolve().parents[3]
out=pathlib.Path(a.output).resolve();out.mkdir(parents=True,exist_ok=True)
identity=repo/'native-identity';text=(identity/'src/lib.rs').read_text()
text=re.sub(r'(?m)^mod (\w+);$',lambda m:f'#[path = {json.dumps(str(identity/"src"/(m[1]+".rs")))}]\nmod {m[1]};',text)
text+='\nextern crate self as surreal_ck_native_identity;\nextern crate self as surreal_ck_native_signaling;\n'
for name,path in [('protocol',repo/'native-signaling/src/protocol.rs'),('session',repo/'native-signaling/src/session.rs'),('enterprise_peer',repo/'native-client/src/enterprise_peer.rs')]:
 text+=f'#[path = {json.dumps(str(path))}]\npub mod {name};\n'
text+='pub use session::Signaling;\npub use protocol::Error;\n'+(pathlib.Path(__file__).parent/'real_chat.rs').read_text()
(out/'lib.rs').write_text(text)
manifest=(identity/'Cargo.toml').read_text().replace('name = "surreal-ck-native-identity"','name = "surreal-ck-enterprise-e2e-r2"').replace('[dependencies]','[lib]\npath = "lib.rs"\n\n[dependencies]\nsurreal-ck-peer-transport = { path = '+json.dumps(str(repo/'native-transport'))+' }')
(out/'Cargo.toml').write_text(manifest)
paths=[]
for directory in ['native-identity/src','native-identity/sql','native-signaling/src','native-transport/src','shared/sql/workspace-template']:
 paths+=list((repo/directory).rglob('*'))
paths += [repo/'native-client/src/enterprise_peer.rs',pathlib.Path(__file__).resolve(),pathlib.Path(__file__).resolve().parent/'real_chat.rs']
receipt={str(f.relative_to(repo)):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(paths) if f.is_file()}
(out/'source-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(out)
