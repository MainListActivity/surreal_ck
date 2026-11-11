#![cfg(target_os = "linux")]
// 完整文件接收闭环仅在已实现安全FD发布的平台运行；未适配桌面另测明确拒绝。
//! 同一对 Peer 的真实 ICE/DTLS/SCTP/SRTP 闭环：默认虚拟网，显式 ignored 用例走 OS UDP。
//! 只使用仓库明确标注的 FFmpeg 合成素材，不访问设备、扬声器或公网。
use bytes::Bytes;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use surreal_ck_native_call::{CallSession, Source};
use surreal_ck_peer_transport::{
    chat::{Chat, Event as ChatEvent},
    file,
    media::Media,
    transfer::{Event as FileEvent, Transfer},
    webrtc::{
        api::setting_engine::SettingEngine,
        media::io::ivf_reader::IVFReader,
        stats::StatsReportType,
        util::vnet::{
            net::{Net, NetConfig},
            router::{Router, RouterConfig},
        },
    },
    Peer, Route,
};
use tokio::{
    sync::{mpsc, Mutex},
    task::JoinHandle,
    time::{sleep, timeout},
};

const FILE_BYTES: usize = 16 * 1024 * 5 + 137;
// 对固定 i%251 合成文件独立预计算，避免只比较发送端和接收端共享的同一错误实现。
const EXPECTED_SHA256: &str = "14e189ee28724f8ae6055fc06a2e886ce178bf5cb7d60b73f3ca610c420153d8";
const HEADER: usize = 21;
const OFFER: u8 = 1;
const CHUNK: u8 = 4;
const CHUNK_ACK: u8 = 5;

struct TestDir(PathBuf);
impl TestDir {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "surreal-ck-one-to-one-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
    fn no_partials(&self) {
        assert!(std::fs::read_dir(&self.0).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".part")));
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct Tasks(Vec<JoinHandle<()>>);
impl Drop for Tasks {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}
#[derive(Debug)]
enum ChatNotice {
    Open,
    Text(String),
    Closed,
}
#[derive(Default)]
struct Gate {
    hold_ack: AtomicBool,
    corrupt_next_chunk: AtomicBool,
    held: Mutex<Option<Vec<u8>>>,
    chunks: AtomicUsize,
    offer_hash: Mutex<Option<Vec<u8>>>,
    protocol_errors: Mutex<Vec<String>>,
}
fn pump(
    mut incoming: mpsc::Receiver<ChatEvent>,
    files: Transfer,
    gate: Arc<Gate>,
    notices: mpsc::Sender<ChatNotice>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(event) = incoming.recv().await {
            match event {
                ChatEvent::Open => {
                    let _ = notices.send(ChatNotice::Open).await;
                }
                ChatEvent::Text(text) => {
                    let _ = notices.send(ChatNotice::Text(text)).await;
                }
                ChatEvent::Binary(mut bytes) => {
                    if bytes.len() >= HEADER && &bytes[..4] == b"CKF1" {
                        match bytes[4] {
                            OFFER if bytes.len() >= HEADER + 40 => {
                                *gate.offer_hash.lock().await =
                                    Some(bytes[HEADER + 8..HEADER + 40].to_vec());
                            }
                            CHUNK => {
                                gate.chunks.fetch_add(1, Ordering::SeqCst);
                                if gate.corrupt_next_chunk.swap(false, Ordering::SeqCst) {
                                    *bytes.last_mut().unwrap() ^= 1;
                                }
                            }
                            CHUNK_ACK if gate.hold_ack.load(Ordering::SeqCst) => {
                                let mut held = gate.held.lock().await;
                                assert!(
                                    held.is_none(),
                                    "stop-and-wait should allow only one unacknowledged chunk"
                                );
                                *held = Some(bytes);
                                continue;
                            }
                            _ => {}
                        }
                    }
                    // 与生产桥一致：按实际DataChannel到达顺序处理，不为各chunk另起并发任务。
                    if let Err(error) = files.handle_binary(&bytes).await {
                        gate.protocol_errors.lock().await.push(error);
                    }
                }
                ChatEvent::Closed => {
                    let _ = notices.send(ChatNotice::Closed).await;
                    break;
                }
                ChatEvent::State(_) => {}
            }
        }
        let _ = files.close().await;
    })
}
async fn pair(
    real_udp: bool,
) -> (
    Arc<Chat>,
    mpsc::Receiver<ChatEvent>,
    Arc<Chat>,
    mpsc::Receiver<ChatEvent>,
    Option<Arc<Mutex<Router>>>,
) {
    if real_udp {
        let (a, ae) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
        let (b, be) = Chat::new(false, Route::Direct, vec![]).await.unwrap();
        return (Arc::new(a), ae, Arc::new(b), be, None);
    }
    let router = Arc::new(Mutex::new(
        Router::new(RouterConfig {
            cidr: "10.7.0.0/24".into(),
            ..Default::default()
        })
        .unwrap(),
    ));
    let mut peers = Vec::new();
    for ip in ["10.7.0.1", "10.7.0.2"] {
        let net = Arc::new(Net::new(Some(NetConfig {
            static_ips: vec![ip.into()],
            ..Default::default()
        })));
        let nic = net.get_nic().unwrap();
        router.lock().await.add_net(nic.clone()).await.unwrap();
        nic.lock().await.set_router(router.clone()).await.unwrap();
        let mut settings = SettingEngine::default();
        settings.set_vnet(Some(net));
        peers.push(
            Peer::new_with_settings(Route::Direct, vec![], settings)
                .await
                .unwrap(),
        );
    }
    router.lock().await.start().await.unwrap();
    let (a, ae) = Chat::from_peer(peers.remove(0), true).await.unwrap();
    let (b, be) = Chat::from_peer(peers.remove(0), false).await.unwrap();
    (Arc::new(a), ae, Arc::new(b), be, Some(router))
}
async fn next_chat(events: &mut mpsc::Receiver<ChatNotice>) -> ChatNotice {
    timeout(Duration::from_secs(5), events.recv())
        .await
        .expect("chat observation timeout")
        .expect("chat observation closed")
}
async fn next_file(events: &mut mpsc::Receiver<FileEvent>) -> FileEvent {
    timeout(Duration::from_secs(5), events.recv())
        .await
        .expect("file event timeout")
        .expect("file events closed")
}
async fn terminal(events: &mut mpsc::Receiver<FileEvent>, id: &str) -> (FileEvent, Vec<u64>) {
    let mut progress = Vec::new();
    loop {
        let event = next_file(events).await;
        match event {
            FileEvent::Progress {
                id: actual,
                done,
                total,
            } => {
                assert_eq!(actual, id);
                assert_eq!(total, FILE_BYTES as u64);
                assert!(progress.last().is_none_or(|previous| done > *previous));
                progress.push(done);
            }
            other => return (other, progress),
        }
    }
}
async fn expect_offer(events: &mut mpsc::Receiver<FileEvent>, id: &str) {
    assert_eq!(
        next_file(events).await,
        FileEvent::Offer {
            id: id.into(),
            name: "同会话中文文件.bin".into(),
            size: FILE_BYTES as u64
        }
    );
}
async fn send_three_tracks(media: &Media, frame: &Bytes, opus: &Bytes) {
    for source in [Source::Camera, Source::Screen] {
        media
            .send(source, frame.clone(), Duration::from_millis(100))
            .await
            .unwrap();
    }
    media
        .send(Source::Microphone, opus.clone(), Duration::from_millis(20))
        .await
        .unwrap();
}
type Pixels = (Source, u16, u16, Bytes);
async fn receive_two_video_frames(frames: &mut mpsc::Receiver<Pixels>) {
    let mut seen = [false; 2];
    while !seen.iter().all(|seen| *seen) {
        let (source, width, height, pixels) = timeout(Duration::from_secs(5), frames.recv())
            .await
            .expect("RGBA timeout")
            .expect("RGBA sink closed");
        assert_eq!((width, height), (320, 180));
        assert_eq!(pixels.len(), 320 * 180 * 4);
        assert!(pixels.as_chunks::<4>().0.iter().all(|p| p[3] == 255));
        assert!(pixels.as_chunks::<4>().0.iter().any(|p| p[0] != p[1]));
        seen[match source {
            Source::Camera => 0,
            Source::Screen => 1,
            Source::Microphone => panic!("audio sent to RGBA"),
        }] = true;
    }
}
async fn confirm_three_inbound_tracks(chat: &Chat, expected_opus_packets: u64, opus_size: usize) {
    timeout(Duration::from_secs(5), async {
        loop {
            let report = chat.peer().connection().get_stats().await;
            let mut seen = [false; 3];
            for stat in report.reports.values() {
                if let StatsReportType::InboundRTP(stat) = stat {
                    match stat.track_identifier.as_str() {
                        "microphone"
                            if stat.kind == "audio"
                                && stat.packets_received >= expected_opus_packets
                                && stat.bytes_received
                                    >= expected_opus_packets * opus_size as u64 =>
                        {
                            seen[0] = true
                        }
                        "camera" if stat.kind == "video" && stat.packets_received > 0 => {
                            seen[1] = true
                        }
                        "screen" if stat.kind == "video" && stat.packets_received > 0 => {
                            seen[2] = true
                        }
                        _ => {}
                    }
                }
            }
            if seen.iter().all(|seen| *seen) {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("three real inbound SRTP tracks were not observed");
}
async fn held_ack(gate: &Gate) -> Vec<u8> {
    timeout(Duration::from_secs(5), async {
        loop {
            if let Some(bytes) = gate.held.lock().await.take() {
                break bytes;
            }
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("sender did not reach chunk ACK backpressure")
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn assert_file(path: &Path, data: &[u8]) {
    assert_eq!(std::fs::read(path).unwrap(), data);
}

#[tokio::test]
async fn same_session_chinese_chat_accepted_files_three_media_tracks_and_backpressured_stop() {
    run_same_session(false).await;
}

#[tokio::test]
#[ignore = "requires real OS UDP interfaces; no external STUN/TURN or devices"]
async fn real_udp_same_session_chat_files_three_tracks_and_negative_cases() {
    run_same_session(true).await;
}

async fn run_same_session(real_udp: bool) {
    timeout(Duration::from_secs(35), async {
        let dir = TestDir::new();
        let data: Vec<u8> = (0..FILE_BYTES).map(|i| (i % 251) as u8).collect();
        let source = dir.file("同会话中文文件.bin");
        std::fs::write(&source, &data).unwrap();
        let (a, ae, b, be, router) = pair(real_udp).await;
        let (a_file_tx, mut a_files) = mpsc::channel(1);
        let (b_file_tx, mut b_files) = mpsc::channel(1);
        let af = Transfer::new(a.clone(), a_file_tx);
        let bf = Transfer::new(b.clone(), b_file_tx);
        let ag = Arc::new(Gate::default());
        let bg = Arc::new(Gate::default());
        let (a_notice_tx, mut a_chat) = mpsc::channel(16);
        let (b_notice_tx, mut b_chat) = mpsc::channel(16);
        let mut tasks = Tasks(vec![pump(ae, af.clone(), ag.clone(), a_notice_tx), pump(be, bf.clone(), bg.clone(), b_notice_tx)]);
        // A仅发送明确标注的编码fixture，B用真实CallSession解码；没有生产设备注入入口。
        let (media, mut feedback) = Media::attach(a.peer()).await.unwrap();
        tasks.0.push(tokio::spawn(async move { while feedback.recv().await.is_some() {} }));
        let (pixels_tx, mut pixels) = mpsc::channel(8);
        let (mut call, mut call_events) = CallSession::attach(&b, Arc::new(move |s, w, h, rgba| pixels_tx.try_send((s, w, h, rgba)).map_err(|e| e.to_string()))).await.unwrap();
        tasks.0.push(tokio::spawn(async move { while call_events.recv().await.is_some() {} }));
        let offer = a.offer_json().await.unwrap();
        assert!(!offer.contains(" typ relay"));
        a.accept_answer_json(&b.answer_json(&offer).await.unwrap()).await.unwrap();
        assert!(matches!(next_chat(&mut a_chat).await, ChatNotice::Open));
        assert!(matches!(next_chat(&mut b_chat).await, ChatNotice::Open));
        a.send_text("你好，开始同一会话的文件与音视频测试。🦀").await.unwrap();
        assert!(matches!(next_chat(&mut b_chat).await, ChatNotice::Text(text) if text == "你好，开始同一会话的文件与音视频测试。🦀"));
        b.send_text("已收到中文，等待我明确接受文件。").await.unwrap();
        assert!(matches!(next_chat(&mut a_chat).await, ChatNotice::Text(text) if text == "已收到中文，等待我明确接受文件。"));

        let (mut ivf, _) = IVFReader::new(include_bytes!("../../native-transport/tests/fixtures/test.vp8.ivf").as_slice()).unwrap();
        let frame = ivf.parse_next_frame().unwrap().0.freeze();
        let opus = Bytes::from_static(include_bytes!("../../native-transport/tests/fixtures/test.opus.packet"));
        assert!(media.send(Source::Camera, frame.clone(), Duration::from_millis(100)).await.is_err());
        for source in [Source::Camera, Source::Screen, Source::Microphone] { media.set_enabled(source, true); }
        call.set_remote_video_enabled(true).await.unwrap();
        // 音频保持默认不播放，只验证真实Opus轨已通过SRTP到达；不启动扬声器。
        let id = af.offer(source.clone()).await.unwrap();
        expect_offer(&mut b_files, &id).await;
        assert_eq!(hex(bg.offer_hash.lock().await.as_ref().unwrap()), EXPECTED_SHA256);
        sleep(Duration::from_millis(75)).await;
        assert_eq!(bg.chunks.load(Ordering::SeqCst), 0, "ACCEPT前不得发送文件内容");
        dir.no_partials();
        let saved = dir.file("用户明确批准保存.bin");
        assert!(!saved.exists());
        bf.accept(&id, saved.clone()).await.unwrap();
        let (sent, received, ()) = tokio::join!(
            terminal(&mut a_files, &id),
            terminal(&mut b_files, &id),
            async {
                send_three_tracks(&media, &frame, &opus).await;
                a.send_text("文件分块期间中文聊天仍可达。").await.unwrap();
                assert!(matches!(next_chat(&mut b_chat).await, ChatNotice::Text(text) if text == "文件分块期间中文聊天仍可达。"));
                receive_two_video_frames(&mut pixels).await;
            }
        );
        assert_eq!(sent.0, FileEvent::Completed { id: id.clone(), destination: None });
        assert_eq!(received.0, FileEvent::Completed { id, destination: Some(saved.clone()) });
        assert_eq!(sent.1.len(), 6);
        assert_eq!(received.1.len(), 6);
        assert_eq!(sent.1.last(), Some(&(FILE_BYTES as u64)));
        assert_eq!(bg.chunks.load(Ordering::SeqCst), 6);
        assert_file(&saved, &data);
        dir.no_partials();
        confirm_three_inbound_tracks(&b, 1, opus.len()).await;

        // 同一连接中篡改交给文件协议的一块内容，SHA-256必须阻止最终文件出现。
        bg.corrupt_next_chunk.store(true, Ordering::SeqCst);
        let corrupt_id = af.offer(source.clone()).await.unwrap();
        expect_offer(&mut b_files, &corrupt_id).await;
        let corrupt = dir.file("不得保存的损坏文件.bin");
        bf.accept(&corrupt_id, corrupt.clone()).await.unwrap();
        let (sent, received) = tokio::join!(terminal(&mut a_files, &corrupt_id), terminal(&mut b_files, &corrupt_id));
        assert_eq!(sent.0, FileEvent::Cancelled { id: corrupt_id });
        assert!(matches!(received.0, FileEvent::Error { message, .. } if message.contains("digest mismatch")));
        assert!(!corrupt.exists());
        assert_file(&saved, &data);
        dir.no_partials();

        // ACK不交给发送器，且接收端Progress队列保持满。取消必须独立完成，不等UI消费。
        ag.hold_ack.store(true, Ordering::SeqCst);
        let chunks_before = bg.chunks.load(Ordering::SeqCst);
        let cancel_id = af.offer(source.clone()).await.unwrap();
        expect_offer(&mut b_files, &cancel_id).await;
        let cancelled = dir.file("取消后不得保存.bin");
        bf.accept(&cancel_id, cancelled.clone()).await.unwrap();
        let held = held_ack(&ag).await;
        sleep(Duration::from_millis(50)).await;
        assert_eq!(bg.chunks.load(Ordering::SeqCst), chunks_before + 1, "ACK背压应限制到一块在途");
        send_three_tracks(&media, &frame, &opus).await;
        receive_two_video_frames(&mut pixels).await;
        confirm_three_inbound_tracks(&b, 2, opus.len()).await;
        let cancelling_files = bf.clone();
        let cancelling_id = cancel_id.clone();
        assert_eq!(b_files.max_capacity(), 1);
        assert_eq!(b_files.len(), 1, "取消前真实容量1事件队列必须已满");
        timeout(Duration::from_secs(2), cancelling_files.cancel(&cancelling_id))
            .await.expect("满UI事件队列不得阻断真实文件取消").unwrap();
        assert_eq!(b_files.len(), 1, "取消完成前后均未消费UI事件");
        assert!(!cancelled.exists());
        dir.no_partials();
        b.send_text("文件事件队列满时，取消、聊天和停止控制仍独立。").await.unwrap();
        assert!(matches!(next_chat(&mut a_chat).await, ChatNotice::Text(text) if text == "文件事件队列满时，取消、聊天和停止控制仍独立。"));
        let stopping_at = Instant::now();
        timeout(Duration::from_secs(2), call.stop()).await.expect("文件背压不能阻断媒体停止").unwrap();
        eprintln!("同一会话(real_udp={real_udp})：文件cancel已在满事件队列下完成，媒体stop耗时 {:?}", stopping_at.elapsed());
        assert!(call.set_remote_video_enabled(true).await.is_err());
        assert!(call.set_remote_audio_enabled(true).await.is_err());
        while pixels.try_recv().is_ok() {}
        send_three_tracks(&media, &frame, &opus).await;
        assert!(!matches!(timeout(Duration::from_millis(75), pixels.recv()).await, Ok(Some(_))), "stop完成后不得继续交付RGBA");

        // 消费仍保留的Progress后，再核实异步终态通知；终态投递与已完成的取消分离。
        assert!(matches!(next_file(&mut b_files).await, FileEvent::Progress { done, .. } if done == file::CHUNK_SIZE as u64));
        let (sent, received) = tokio::join!(terminal(&mut a_files, &cancel_id), terminal(&mut b_files, &cancel_id));
        assert_eq!(sent.0, FileEvent::Cancelled { id: cancel_id.clone() });
        assert_eq!(received.0, FileEvent::Cancelled { id: cancel_id });
        ag.hold_ack.store(false, Ordering::SeqCst);
        b.send_binary(&held).await.unwrap(); // 已取消传输的迟到ACK必须被retired列表吞掉。
        sleep(Duration::from_millis(50)).await;
        assert_eq!(bg.chunks.load(Ordering::SeqCst), chunks_before + 1);
        assert!(!cancelled.exists());
        dir.no_partials();
        assert_file(&saved, &data);
        assert!(ag.protocol_errors.lock().await.is_empty());
        assert!(bg.protocol_errors.lock().await.iter().all(|e| e.contains("digest mismatch")));

        af.close().await.unwrap();
        bf.close().await.unwrap();
        a.close().await.unwrap();
        b.close().await.unwrap();
        assert!(a.send_text("关闭后不得发送").await.is_err());
        assert!(a.send_binary(b"closed").await.is_err());
        assert!(af.offer(source).await.is_err());
        let mut accepted_after_close = Vec::new();
        for source in [Source::Camera, Source::Screen, Source::Microphone] {
            let packet = if source == Source::Microphone { opus.clone() } else { frame.clone() };
            if media.send(source, packet, Duration::from_millis(20)).await.is_ok() { accepted_after_close.push(source); }
        }
        assert!(accepted_after_close.is_empty(), "关闭Peer后仍接受这些轨发送：{accepted_after_close:?}");
        drop(call);
        drop(tasks);
        if let Some(router) = router { router.lock().await.stop().await.unwrap(); }
        eprintln!("PASS real_udp={real_udp}: 双向中文聊天；{FILE_BYTES}字节文件及独立SHA256；三路SRTP/双视频RGBA；损坏文件拒绝；ACK背压取消与迟到ACK；停止后帧拒绝；关闭后全部发送拒绝");
    }).await.expect("同一会话聊天/文件/三媒体轨闭环超时");
}
