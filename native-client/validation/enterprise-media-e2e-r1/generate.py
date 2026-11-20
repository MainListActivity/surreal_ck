#!/usr/bin/env python3
"""Generate isolated source harness; no build, device access or fixture execution."""
import pathlib, hashlib, json, re
H=pathlib.Path(__file__).resolve().parent
R=H.parent/'native-client-probe/surreal_ck'
I=R/'native-identity'
if (H/'input-receipt.json').exists():
    raise SystemExit('Input already bound; regeneration requires explicit new evidence directory')
root=(I/'src/lib.rs').read_text()
root=re.sub(r'(?m)^mod (\w+);$',lambda m:f'#[path = {json.dumps(str(I/"src"/(m[1]+".rs")))}]\nmod {m[1]};',root)
root+='''
#[cfg(not(all(target_os="linux",feature="experimental-enterprise-media")))]
compile_error!("Linux enterprise media opt-in required");
extern crate self as surreal_ck_native_identity;
extern crate self as surreal_ck_native_signaling;
pub mod bridge {
    // Only the output envelope is narrowed; the real Call and actor are included below.
    pub enum Update { Media(crate::call_bridge::Notice), Unused }
}
'''
for name,path in [('protocol','native-signaling/src/protocol.rs'),('session','native-signaling/src/session.rs'),('call_bridge','native-client/src/call_bridge.rs')]:
    root+=f'#[path = {json.dumps(str(R/path))}]\npub mod {name};\n'
root+='pub mod enterprise_peer;\npub use session::Signaling;\npub use protocol::Error;\n'
(H/'lib.rs').write_text(root)
p=R/'native-client/src/enterprise_peer.rs'
(H/'enterprise_peer.rs').write_bytes(p.read_bytes()+(H/'peer-seam.rs').read_bytes())
manifest=(H.parent/'enterprise-signaling-file-e2e-harness/Cargo.toml').read_text().replace('surreal-ck-enterprise-file-e2e-r3','surreal-ck-enterprise-media-e2e-r1')
manifest=manifest.replace('[dependencies]',f'''[dependencies]
bytes = "1"
async-channel = "2"
surreal-ck-native-call = {{ path = "{R}/native-call" }}
surreal-ck-native-video-view = {{ path = "{R}/native-video-view", features = ["linux-gtk"] }}''')
(H/'Cargo.toml').write_text(manifest)
inputs=list(R.glob('native-*/src/**/*.rs'))+list(R.glob('native-*/Cargo.toml'))+list((R/'native-identity/sql').rglob('*.surql'))+list((R/'shared/sql/workspace-template').rglob('*.*'))+[p,H/'peer-seam.rs',H/'media-tests.rs',H/'lib.rs',H/'enterprise_peer.rs',H/'Cargo.toml',H/'generate.py',H/'prepare-input.py',H/'run.py',H/'Cargo.lock',H/'README.md']
receipt={str(f):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(set(inputs))}
(H/'source-receipt.json').write_text(json.dumps({'status':'source only; not compiled or run','inputs':receipt,'seams':['exact enterprise_peer source prefix plus appended test-only sample injection','narrow bridge Update envelope; production Call, EnterpriseCall, CallSession and FramePublisher unchanged']},indent=2)+'\n')
print('Generated source only; production files unchanged.')
