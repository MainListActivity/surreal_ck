// TEST-ONLY extension, appended after an exact byte-for-byte production source prefix.
// Bypasses CaptureInput and Media.enabled. Never claims device capture or device release.
#[cfg(test)]
impl EnterprisePeer {
    async fn synthetic_camera_sample(&self, bytes: bytes::Bytes) -> Result<(), String> {
        use surreal_ck_peer_transport::webrtc::{
            media::Sample, peer_connection::peer_connection_state::RTCPeerConnectionState,
            track::track_local::track_local_static_sample::TrackLocalStaticSample,
        };
        if !self.lease_active() {
            return Err("test input lease revoked".into());
        }
        let pc = self.chat.peer().connection();
        if pc.connection_state() != RTCPeerConnectionState::Connected {
            return Err("test input peer not connected".into());
        }
        for sender in pc.get_senders().await {
            if let Some(track) = sender.track().await {
                if track.id() == "camera" {
                    let sample = track
                        .as_any()
                        .downcast_ref::<TrackLocalStaticSample>()
                        .ok_or("camera track is not the production static sample track")?;
                    // Recheck immediately before input. This is a test-input guard, not
                    // evidence that the production Media.send gate was exercised.
                    if !self.lease_active() {
                        return Err("test input lease revoked".into());
                    }
                    return sample
                        .write_sample(&Sample {
                            data: bytes,
                            duration: std::time::Duration::from_millis(100),
                            ..Default::default()
                        })
                        .await
                        .map_err(|e| e.to_string());
                }
            }
        }
        Err("production camera sender missing".into())
    }
}
#[cfg(test)]
#[path = "media-tests.rs"]
mod enterprise_media_e2e;
