//! 独立 WebRTC 传输原型。信令由宿主认证；这里没有 HTTP/数据库流量代理。
use std::{sync::Arc, time::Duration};
use webrtc::{
    api::{media_engine::MediaEngine, APIBuilder},
    ice_transport::ice_server::RTCIceServer,
    peer_connection::{
        configuration::RTCConfiguration, policy::ice_transport_policy::RTCIceTransportPolicy,
        sdp::session_description::RTCSessionDescription, RTCPeerConnection,
    },
};
pub mod file;
pub mod manual_verification;
pub mod media;
pub use webrtc;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("invalid or unauthorized TURN configuration")]
    InvalidRelay,
    #[error("ICE gathering timed out")]
    GatheringTimeout,
    #[error("ICE gathered no candidates: check OS network interfaces or authorized STUN/TURN configuration")]
    NoCandidates,
    #[error(transparent)]
    WebRtc(#[from] webrtc::Error),
}

/// 第一轮禁止 TURN；失败后宿主征得服务使用授权，再新建 RelayFallback peer。
/// 这不是把 SFU 叫做 P2P，也不自动选取不可信的免费中继。
#[derive(Clone, Default)]
pub enum Route {
    #[default]
    Direct,
    RelayFallback {
        urls: Vec<String>,
        username: String,
        credential: String,
    },
}
impl Route {
    fn config(self) -> Result<RTCConfiguration, Error> {
        let mut config = RTCConfiguration::default();
        if let Self::RelayFallback {
            urls,
            username,
            credential,
        } = self
        {
            if urls.is_empty()
                || username.is_empty()
                || credential.is_empty()
                || urls.iter().any(|s| {
                    !(s.starts_with("turn:") || s.starts_with("turns:")) || s.contains(['\r', '\n'])
                })
            {
                return Err(Error::InvalidRelay);
            }
            config.ice_servers = vec![RTCIceServer {
                urls,
                username,
                credential,
            }];
            config.ice_transport_policy = RTCIceTransportPolicy::Relay;
        }
        Ok(config)
    }
}

pub struct Peer {
    connection: Arc<RTCPeerConnection>,
}
impl Peer {
    /// STUN 是可选的显式配置；不内置第三方地址，不泄露 IP 给未选定的服务。
    pub async fn new(route: Route, stun_urls: Vec<String>) -> Result<Self, Error> {
        Self::new_with_settings(
            route,
            stun_urls,
            webrtc::api::setting_engine::SettingEngine::default(),
        )
        .await
    }
    /// 可注入 WebRTC 设置用于平台适配和显式虚拟网络协议测试。
    pub async fn new_with_settings(
        route: Route,
        stun_urls: Vec<String>,
        settings: webrtc::api::setting_engine::SettingEngine,
    ) -> Result<Self, Error> {
        let mut config = route.config()?;
        if stun_urls
            .iter()
            .any(|s| !s.starts_with("stun:") || s.contains(['\r', '\n']))
        {
            return Err(Error::InvalidRelay);
        }
        if !stun_urls.is_empty() {
            config.ice_servers.push(RTCIceServer {
                urls: stun_urls,
                ..Default::default()
            });
        }
        let mut media = MediaEngine::default();
        media.register_default_codecs()?;
        let registry = webrtc::api::interceptor_registry::register_default_interceptors(
            webrtc::interceptor::registry::Registry::new(),
            &mut media,
        )?;
        let api = APIBuilder::new()
            .with_interceptor_registry(registry)
            .with_media_engine(media)
            .with_setting_engine(settings)
            .build();
        Ok(Self {
            connection: Arc::new(api.new_peer_connection(config).await?),
        })
    }
    /// 媒体 track / data channel / 状态回调的最小 Rust 集成接口。
    pub fn connection(&self) -> Arc<RTCPeerConnection> {
        self.connection.clone()
    }
    async fn gather(&self, local: RTCSessionDescription) -> Result<RTCSessionDescription, Error> {
        let mut complete = self.connection.gathering_complete_promise().await;
        self.connection.set_local_description(local).await?;
        tokio::time::timeout(Duration::from_secs(15), complete.recv())
            .await
            .map_err(|_| Error::GatheringTimeout)?;
        let description = self
            .connection
            .local_description()
            .await
            .ok_or(Error::GatheringTimeout)?;
        if !description
            .sdp
            .lines()
            .any(|line| line.starts_with("a=candidate:"))
        {
            return Err(Error::NoCandidates);
        }
        Ok(description)
    }
    pub async fn offer(&self) -> Result<RTCSessionDescription, Error> {
        self.gather(self.connection.create_offer(None).await?).await
    }
    /// 必须先由宿主验证信令会话的用户、成员资格、会话 nonce 与 SDP 归属。
    pub async fn answer(
        &self,
        offer: RTCSessionDescription,
    ) -> Result<RTCSessionDescription, Error> {
        self.connection.set_remote_description(offer).await?;
        self.gather(self.connection.create_answer(None).await?)
            .await
    }
    pub async fn accept_answer(&self, answer: RTCSessionDescription) -> Result<(), Error> {
        Ok(self.connection.set_remote_description(answer).await?)
    }
    pub async fn close(&self) -> Result<(), Error> {
        Ok(self.connection.close().await?)
    }
}
pub mod chat;

pub mod transfer;
