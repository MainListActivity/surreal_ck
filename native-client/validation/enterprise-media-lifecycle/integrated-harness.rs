#![allow(dead_code, unused_imports)]
mod bridge {
    #[derive(Debug)]
    pub enum Update { Media(crate::call_bridge::Notice), Other }
}
#[path="/workspace/scratch/115bfa675150/native-client-probe/surreal_ck/native-client/src/enterprise_peer.rs"]
mod enterprise_peer;
#[path="/workspace/scratch/115bfa675150/native-client-probe/surreal_ck/native-client/src/call_bridge.rs"]
mod call_bridge;
