//! Real authenticated enterprise negotiation + OS UDP + VP8 decode + FramePublisher.
//! Synthetic encoded input only. No capture device, speaker, or GUI acceptance claim.
use super::*;
use crate::{
    call_bridge::{CapturePhase, Control},
    signaling,
};
use std::{io::Cursor, time::Duration};
use surreal_ck_native_video_view::{FrameReceiver, FrameUpdate};
use surreal_ck_peer_transport::{
    chat::Event as ChatEvent, webrtc::media::io::ivf_reader::IVFReader,
};
use tokio::{
    sync::mpsc::Receiver,
    time::{sleep, timeout},
};

async fn opened(events: &mut Receiver<ChatEvent>) {
    timeout(Duration::from_secs(20), async {
        loop {
            if matches!(
                events.recv().await.expect("chat closed before open"),
                ChatEvent::Open
            ) {
                break;
            }
        }
    })
    .await
    .expect("real OS UDP did not connect; no VNet fallback");
}
fn fixture_frames() -> Vec<bytes::Bytes> {
    let path = std::env::var("MEDIA_E2E_IVF").expect("explicit synthetic IVF path required");
    let bytes = std::fs::read(path).unwrap();
    assert!(bytes.len() < 256 * 1024, "fixture exceeds source budget");
    let (mut reader, _) = IVFReader::new(Cursor::new(bytes)).unwrap();
    let mut frames = Vec::new();
    while let Ok((frame, _)) = reader.parse_next_frame() {
        frames.push(frame.freeze());
    }
    assert!(
        frames.len() >= 2,
        "need at least two all-keyframe synthetic frames"
    );
    frames
}
async fn run(revoke: bool) {
    let binary = std::env::var("SURREAL_TEST_BINARY").expect("verified local fork required");
    let mut fixture = signaling::tests::ForkFixture::start(&binary).await;
    let a_connection = fixture.connection("a", "ws_signal").await;
    let mut b_connection = fixture.connection("b", "ws_signal").await;
    let (mut a, mut a_chat) = EnterprisePeer::invite(a_connection, "user:b", vec![])
        .await
        .unwrap();
    let inbox = b_connection.inbox().await.unwrap();
    assert_eq!(inbox.len(), 1);
    let (b, mut b_chat) = EnterprisePeer::accept(b_connection, &inbox[0].id, vec![])
        .await
        .unwrap();
    assert!(a.poll_answer().await.unwrap());
    tokio::join!(opened(&mut a_chat), opened(&mut b_chat));
    let a_handle = a.media_handle().unwrap();
    let b_handle = b.media_handle().unwrap();
    let a_states = a.media_capture_state().unwrap();
    let mut states = b.media_capture_state().unwrap();
    // No Start command: all three capture devices remain genuinely unused.
    for s in &states.borrow().sources {
        assert_eq!(s.status, CapturePhase::Stopped);
    }
    b_handle.submit(Control::RemoteVideo(true)).unwrap();
    let id = timeout(Duration::from_secs(5), async {
        loop {
            if let Some(id) = states.borrow().video_streams[0].clone() {
                break id;
            }
            states.changed().await.unwrap();
        }
    })
    .await
    .expect("real playback enable/FramePublisher did not open");
    let mut view: FrameReceiver = surreal_ck_native_video_view::subscribe(&id).unwrap();
    let frames = fixture_frames();
    let mut seen = 0;
    let mut last = 0;
    timeout(Duration::from_secs(15), async {
        while seen < 3 {
            a.synthetic_camera_sample(frames[seen % frames.len()].clone())
                .await
                .unwrap();
            sleep(Duration::from_millis(120)).await;
            if let FrameUpdate::Frame { frame, sequence } = view.poll() {
                assert!(sequence > last);
                last = sequence;
                assert_eq!((frame.width(), frame.height()), (64, 48));
                assert_eq!(frame.pixels().len(), 64 * 48 * 4);
                // Fixture is solid red; lossy VP8/YUV conversion permits a small tolerance.
                for p in frame.pixels().chunks_exact(4) {
                    assert!(
                        p[0] > 220 && p[1] < 35 && p[2] < 35 && p[3] == 255,
                        "decoded color mismatch"
                    );
                }
                seen += 1;
            }
        }
    })
    .await
    .expect("real decoded RGBA was not published");
    if revoke {
        fixture.revoke("b").await;
        timeout(Duration::from_secs(25), async {
            while a.lease_active() || b.lease_active() {
                // Keep injecting until the actual lease changes, rather than stopping the
                // producer when revocation is requested. Errors after close are expected.
                let _ = a.synthetic_camera_sample(frames[0].clone()).await;
                sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("actual enterprise lease did not revoke");
        assert!(a_handle.submit(Control::RemoteVideo(true)).is_err());
        assert!(b_handle.submit(Control::RemoteVideo(true)).is_err());
        assert!(
            a.synthetic_camera_sample(frames[0].clone()).await.is_err(),
            "test-input guard only"
        );
        // Require automatic revocation cleanup BEFORE calling explicit Peer.close.
        // Otherwise an explicit close could mask a broken revocation path.
        timeout(Duration::from_secs(10), async {
            loop {
                if a_states.borrow().shutdown.is_some() && states.borrow().shutdown.is_some() {
                    break;
                }
                sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("lease revoked but real media cleanup did not finish automatically");
        assert!(matches!(view.poll(), FrameUpdate::Closed));
    }
    drop(a_chat);
    drop(b_chat);
    let (a_closed, b_closed) = tokio::join!(a.close(), b.close());
    assert!(a_closed.unwrap().local_closed);
    assert!(b_closed.unwrap().local_closed);
    for rx in [&a_states, &states] {
        let final_state = rx.borrow();
        assert_eq!(final_state.shutdown, Some(Ok(())));
        for source in &final_state.sources {
            assert_eq!(source.status, CapturePhase::Stopped);
        }
        for source in final_state
            .playback
            .as_ref()
            .expect("desktop playback watch")
        {
            assert_eq!(source.status, CapturePhase::Stopped);
        }
    }
    for _ in 0..5 {
        assert!(matches!(view.poll(), FrameUpdate::Closed));
        sleep(Duration::from_millis(100)).await;
    }
    assert!(b_handle.submit(Control::RemoteVideo(true)).is_err());
    println!(
        "PASS synthetic VP8 / real enterprise OS UDP / native decoder / FramePublisher RGBA / real final close; revocation={revoke}; no device or GTK display claim"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires verified local RECORD fork and real OS UDP"]
async fn authenticated_vp8_decode_publish_and_close() {
    timeout(Duration::from_secs(90), run(false)).await.unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires verified local RECORD fork and real OS UDP"]
async fn authenticated_revocation_closes_real_playback() {
    timeout(Duration::from_secs(90), run(true)).await.unwrap();
}
