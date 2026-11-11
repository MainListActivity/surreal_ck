//! 原生编码器/解码器桥接。这里传输真正的 Opus/VP8 编码帧，不生成设备权限或假画面。
use crate::Peer;
use bytes::{Bytes, BytesMut};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Weak,
    },
    time::Duration,
};
use tokio::sync::{mpsc, Mutex};
use webrtc::{
    media::Sample,
    peer_connection::{peer_connection_state::RTCPeerConnectionState, RTCPeerConnection},
    rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication,
    rtp::{codecs::vp8::Vp8Packet, packet::Packet, packetizer::Depacketizer},
    rtp_transceiver::rtp_codec::RTCRtpCodecCapability,
    track::track_local::track_local_static_sample::TrackLocalStaticSample,
};
pub const MAX_VIDEO_FRAME: usize = 4 * 1024 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Microphone,
    Camera,
    Screen,
}
impl Source {
    fn id(self) -> &'static str {
        match self {
            Self::Microphone => "microphone",
            Self::Camera => "camera",
            Self::Screen => "screen",
        }
    }
    fn from_id(s: &str) -> Option<Self> {
        match s {
            "microphone" => Some(Self::Microphone),
            "camera" => Some(Self::Camera),
            "screen" => Some(Self::Screen),
            _ => None,
        }
    }
}
#[derive(Debug)]
pub enum Event {
    /// 解码后渲染由原生宿主负责；timestamp 为 RTP 时钟（Opus 48k / VP8 90k）。
    Frame {
        source: Source,
        timestamp: u32,
        data: Bytes,
    },
    /// 宿主编码器必须响应，尽快输出关键帧。
    KeyframeRequested(Source),
    Ended(Source),
}
struct LocalTrack {
    track: Arc<TrackLocalStaticSample>,
    enabled: AtomicBool,
    write: Mutex<()>,
}
pub struct Media {
    tracks: [LocalTrack; 3],
    connection: Weak<RTCPeerConnection>,
}
fn index(source: Source) -> usize {
    match source {
        Source::Microphone => 0,
        Source::Camera => 1,
        Source::Screen => 2,
    }
}
impl Media {
    /// 必须在 offer/answer 之前 attach。独占该 Peer 的 on_track 回调。
    /// 默认全部静音，宿主完成真实系统许可和设备启动后才 set_enabled。
    pub async fn attach(peer: &Peer) -> Result<(Self, mpsc::Receiver<Event>), crate::Error> {
        let pc = peer.connection();
        let (tx, rx) = mpsc::channel(16);
        let mut tracks = Vec::new();
        for source in [Source::Microphone, Source::Camera, Source::Screen] {
            let capability = if source == Source::Microphone {
                RTCRtpCodecCapability {
                    mime_type: "audio/opus".into(),
                    clock_rate: 48000,
                    channels: 2,
                    ..Default::default()
                }
            } else {
                RTCRtpCodecCapability {
                    mime_type: "video/VP8".into(),
                    clock_rate: 90000,
                    ..Default::default()
                }
            };
            let track = Arc::new(TrackLocalStaticSample::new(
                capability,
                source.id().into(),
                "native-media".into(),
            ));
            let sender = pc.add_track(track.clone()).await?;
            let feedback = tx.clone();
            tokio::spawn(async move {
                while let Ok((packets, _)) = sender.read_rtcp().await {
                    if packets
                        .iter()
                        .any(|p| p.as_any().is::<PictureLossIndication>())
                    {
                        let _ = feedback.try_send(Event::KeyframeRequested(source));
                    }
                }
            });
            tracks.push(LocalTrack {
                track,
                enabled: AtomicBool::new(false),
                write: Mutex::new(()),
            });
        }
        let weak = Arc::downgrade(&pc);
        pc.on_track(Box::new(move |track, _, _| {
            let tx = tx.clone();
            let weak = weak.clone();
            Box::pin(async move {
                tokio::spawn(async move {
                    let Some(source) = Source::from_id(&track.id()) else {
                        return;
                    };
                    let expected = if source == Source::Microphone {
                        "audio/opus"
                    } else {
                        "video/vp8"
                    };
                    if track.codec().capability.mime_type.to_ascii_lowercase() != expected {
                        return;
                    }
                    let mut assembler = Vp8Assembler::default();
                    let mut last_pli = tokio::time::Instant::now() - Duration::from_secs(1);
                    while let Ok((packet, _)) = track.read_rtp().await {
                        let timestamp = packet.header.timestamp;
                        let data = if source == Source::Microphone {
                            if packet.payload.len() > 1275 {
                                continue;
                            }
                            Some(packet.payload)
                        } else {
                            match assembler.push(packet) {
                                Ok(frame) => frame,
                                Err(()) => {
                                    if last_pli.elapsed() >= Duration::from_millis(500) {
                                        if let Some(pc) = weak.upgrade() {
                                            request_keyframe(&pc, track.ssrc()).await;
                                        }
                                        last_pli = tokio::time::Instant::now();
                                    }
                                    None
                                }
                            }
                        };
                        if let Some(data) = data {
                            if tx
                                .try_send(Event::Frame {
                                    source,
                                    timestamp,
                                    data,
                                })
                                .is_err()
                                && source != Source::Microphone
                                && last_pli.elapsed() >= Duration::from_millis(500)
                            {
                                if let Some(pc) = weak.upgrade() {
                                    request_keyframe(&pc, track.ssrc()).await;
                                }
                                last_pli = tokio::time::Instant::now();
                            }
                        }
                    }
                    let _ = tx.try_send(Event::Ended(source));
                });
            })
        }));
        let tracks: [LocalTrack; 3] = tracks.try_into().unwrap_or_else(|_| unreachable!());
        Ok((
            Self {
                tracks,
                connection: Arc::downgrade(&pc),
            },
            rx,
        ))
    }
    /// 只控制网络发送。撤销许可/停止共享时宿主必须同步停止采集设备。
    pub fn set_enabled(&self, source: Source, enabled: bool) {
        self.tracks[index(source)]
            .enabled
            .store(enabled, Ordering::SeqCst);
    }
    pub async fn send(
        &self,
        source: Source,
        data: Bytes,
        duration: Duration,
    ) -> Result<(), String> {
        let local = &self.tracks[index(source)];
        let _guard = local.write.lock().await;
        // 空/已解绑的TrackLocal可能吞掉样本并返回Ok，不能视作有效发送。
        let connection = self
            .connection
            .upgrade()
            .ok_or("media peer no longer exists")?;
        if connection.connection_state() != RTCPeerConnectionState::Connected {
            return Err("media peer is not connected".into());
        }
        if !local.enabled.load(Ordering::SeqCst) {
            return Err(
                "source disabled; acquire OS permission and start native capture first".into(),
            );
        }
        let limit = if source == Source::Microphone {
            1275
        } else {
            MAX_VIDEO_FRAME
        };
        if data.is_empty()
            || data.len() > limit
            || duration.is_zero()
            || duration > Duration::from_secs(1)
        {
            return Err("invalid encoded frame or duration".into());
        }
        local
            .track
            .write_sample(&Sample {
                data,
                duration,
                ..Default::default()
            })
            .await
            .map_err(|e| e.to_string())?;
        if connection.connection_state() != RTCPeerConnectionState::Connected {
            return Err("media peer disconnected during send".into());
        }
        // 仅确认仍连接的发送通道接受样本，不代表对端收到/播放。
        Ok(())
    }
}
async fn request_keyframe(pc: &RTCPeerConnection, ssrc: u32) {
    let _ = pc
        .write_rtcp(&[Box::new(PictureLossIndication {
            sender_ssrc: 0,
            media_ssrc: ssrc,
        })])
        .await;
}
/// 保守的低延迟重组：序号不连续就丢帧并请求关键帧，不把残缺帧送入解码器。
/// 还不是完整 jitter buffer；乱序网络会降低质量，不承诺生产质量。
#[derive(Default)]
struct Vp8Assembler {
    timestamp: Option<u32>,
    next: u16,
    data: BytesMut,
}
impl Vp8Assembler {
    fn push(&mut self, packet: Packet) -> Result<Option<Bytes>, ()> {
        let mut descriptor = Vp8Packet::default();
        let payload = descriptor.depacketize(&packet.payload).map_err(|_| ())?;
        let starts = descriptor.s == 1 && descriptor.pid == 0;
        if starts {
            self.timestamp = Some(packet.header.timestamp);
            self.next = packet.header.sequence_number;
            self.data.clear();
        }
        if self.timestamp != Some(packet.header.timestamp)
            || self.next != packet.header.sequence_number
            || self.data.len() + payload.len() > MAX_VIDEO_FRAME
        {
            self.timestamp = None;
            self.data.clear();
            return Err(());
        }
        self.next = self.next.wrapping_add(1);
        self.data.extend_from_slice(&payload);
        if packet.header.marker {
            self.timestamp = None;
            Ok(Some(self.data.split().freeze()))
        } else {
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn packet(seq: u16, start: bool, marker: bool, payload: &[u8]) -> Packet {
        let mut bytes = vec![if start { 0x10 } else { 0 }];
        bytes.extend_from_slice(payload);
        Packet {
            header: webrtc::rtp::header::Header {
                sequence_number: seq,
                timestamp: 123,
                marker,
                ..Default::default()
            },
            payload: Bytes::from(bytes),
        }
    }
    #[tokio::test]
    async fn enabled_samples_are_rejected_before_connection_and_after_close() {
        let peer = Peer::new(crate::Route::Direct, vec![]).await.unwrap();
        let (media, _events) = Media::attach(&peer).await.unwrap();
        for source in [Source::Microphone, Source::Camera, Source::Screen] {
            media.set_enabled(source, true);
            assert!(media
                .send(
                    source,
                    Bytes::from_static(b"encoded"),
                    Duration::from_millis(20)
                )
                .await
                .is_err());
        }
        peer.close().await.unwrap();
        for source in [Source::Microphone, Source::Camera, Source::Screen] {
            assert!(media
                .send(
                    source,
                    Bytes::from_static(b"encoded"),
                    Duration::from_millis(20)
                )
                .await
                .is_err());
        }
    }
    #[test]
    fn reconstructs_fragments_and_rejects_loss() {
        let mut a = Vp8Assembler::default();
        assert!(a
            .push(packet(65535, true, false, b"abc"))
            .unwrap()
            .is_none());
        assert_eq!(
            a.push(packet(0, false, true, b"def")).unwrap().unwrap(),
            b"abcdef"[..]
        );
        assert!(a.push(packet(1, false, true, b"bad")).is_err());
        assert!(a.push(packet(3, true, false, b"aaa")).unwrap().is_none());
        assert!(a.push(packet(5, false, true, b"bbb")).is_err());
        assert_eq!(
            a.push(packet(6, true, true, b"recovery")).unwrap().unwrap(),
            b"recovery"[..]
        );
        assert!(a.push(Packet::default()).is_err());
    }
}
