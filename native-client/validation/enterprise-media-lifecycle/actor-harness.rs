#![allow(dead_code, unused_imports)]
extern crate self as surreal_ck_peer_transport;
pub enum Route { Direct }
pub mod chat {
    pub struct Chat;
    impl Chat {
        pub async fn new(_:bool,_:crate::Route,_:Vec<String>)->Result<(Self,()),String>{Ok((Self,()))}
        pub async fn close(&self)->Result<(),String>{Ok(())}
    }
}
mod enterprise_peer {
    #[derive(Clone)]
    pub struct LeaseObserver(std::sync::Arc<std::sync::atomic::AtomicBool>);
    impl LeaseObserver {
        pub fn is_active(&self)->bool{self.0.load(std::sync::atomic::Ordering::SeqCst)}
        pub fn test_only(v:bool)->Self{Self(std::sync::Arc::new(std::sync::atomic::AtomicBool::new(v)))}
        pub fn test_revoke(&self){self.0.store(false,std::sync::atomic::Ordering::SeqCst);}
    }
}
mod bridge { pub enum Update { Media(crate::call_bridge::Notice), Other } }
mod call_bridge {
    #[derive(Debug,Clone,Copy)] pub enum Source { Camera, Microphone, Screen }
    pub enum Control { Start {source:Source,selection:String},Stop(Source),RemoteAudio(bool),RemoteVideo(bool) }
    #[derive(Clone)] pub enum Notice { VideoPresented(Source),RemoteVideo{enabled:bool},RemoteAudio(bool),Capture{source:Source,active:bool},Stopped{confirmed:bool} }
    pub struct Call { output:async_channel::Sender<crate::bridge::Update> }
    impl Call {
        pub async fn attach(_: &crate::chat::Chat,output:async_channel::Sender<crate::bridge::Update>)->Result<Self,String>{Ok(Self{output})}
        pub async fn control(&mut self,c:Control){if let Control::RemoteAudio(v)=c{let _=self.output.send(crate::bridge::Update::Media(Notice::RemoteAudio(v))).await;}}
        pub async fn shutdown(&mut self)->Result<(),String>{let _=self.output.send(crate::bridge::Update::Media(Notice::Stopped{confirmed:true})).await;Ok(())}
    }
    #[path="/workspace/scratch/115bfa675150/native-client-probe/surreal_ck/native-client/src/enterprise_media.rs"]
    pub mod enterprise;
}
