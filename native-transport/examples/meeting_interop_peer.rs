use axum::{
    extract::{rejection::StringRejection, DefaultBodyLimit, State},
    http::{header, HeaderValue, Method, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::any,
    Router,
};
use bytes::Bytes;
use ogg::PacketReader;
use serde_json::{json, Value};
use std::{
    error::Error,
    io::Cursor,
    process::{Command, ExitCode},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use surreal_ck_peer_transport::{
    media::{Event, Source},
    meeting::{
        offer_hash, Attempt, EdgeKey, EdgeRole, JoinId, MeetingEdge, ObservedRoute, RoomId,
        RouteKind,
    },
    webrtc::{
        api::setting_engine::SettingEngine,
        ice::mdns::MulticastDnsMode,
        media::io::ivf_reader::IVFReader,
        peer_connection::{
            peer_connection_state::RTCPeerConnectionState as Connection,
            sdp::{sdp_type::RTCSdpType, session_description::RTCSessionDescription},
        },
    },
    Route,
};
use tokio::{
    net::TcpListener,
    time::{self, MissedTickBehavior},
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const LIMIT: usize = 49_152;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(40);
const SOURCES: [Source; 3] = [Source::Microphone, Source::Camera, Source::Screen];
const NAMES: [&str; 3] = ["microphone", "camera", "screen"];
const AUDIO: Duration = Duration::from_millis(20);
const VIDEO: Duration = Duration::from_nanos(1_000_000_000 / 15);

struct Options {
    role: EdgeRole,
    port: u16,
    seconds: u64,
    expect: [bool; 3],
}

impl Options {
    fn parse() -> Result<Self> {
        let mut options = Self {
            role: EdgeRole::Offerer,
            port: 8765,
            seconds: 20,
            expect: [true; 3],
        };
        let mut has_role = false;
        let mut args = std::env::args().skip(1);
        while let Some(flag) = args.next() {
            let value = args.next().ok_or_else(|| format!("{flag} 缺少值"))?;
            match flag.as_str() {
                "--role" => {
                    options.role = match value.as_str() {
                        "offerer" => EdgeRole::Offerer,
                        "answerer" => EdgeRole::Answerer,
                        _ => return Err("--role 必须为 offerer 或 answerer".into()),
                    };
                    has_role = true;
                }
                "--port" => options.port = value.parse()?,
                "--seconds" => options.seconds = value.parse()?,
                "--expect" => {
                    options.expect = [false; 3];
                    for name in value.split(',').filter(|_| !value.is_empty()) {
                        let index = NAMES
                            .iter()
                            .position(|&s| s == name)
                            .ok_or_else(|| format!("未知媒体源：{name}"))?;
                        options.expect[index] = true;
                    }
                }
                _ => return Err(format!("未知参数：{flag}").into()),
            }
        }
        if !has_role || options.seconds == 0 {
            return Err("需要 --role offerer|answerer；--seconds 必须大于零".into());
        }
        Ok(options)
    }
}

struct Mailbox {
    role: EdgeRole,
    incoming: Option<RTCSessionDescription>,
    posted: bool,
    outgoing: Option<String>,
    report: Report,
}

#[derive(Default)]
struct Report {
    connected: bool,
    route: ObservedRoute,
    received: [u64; 3],
    sent: [u64; 3],
}

impl Report {
    fn json(&self) -> Value {
        let counts = |v: [u64; 3]| json!({"microphone": v[0], "camera": v[1], "screen": v[2]});
        json!({
            "connected": self.connected,
            "route": match self.route {
                ObservedRoute::Direct => "direct",
                ObservedRoute::Relay => "relay",
                ObservedRoute::Unknown => "unknown",
            },
            "received": counts(self.received),
            "sent": counts(self.sent),
        })
    }
}

type Shared = Arc<Mutex<Mailbox>>;

async fn http(
    State(shared): State<Shared>,
    method: Method,
    uri: axum::http::Uri,
    body: std::result::Result<String, StringRejection>,
) -> Response {
    let mut mailbox = shared.lock().unwrap();
    let (get, post, expected) = match mailbox.role {
        EdgeRole::Offerer => ("/offer", "/answer", RTCSdpType::Answer),
        EdgeRole::Answerer => ("/answer", "/offer", RTCSdpType::Offer),
    };
    let mut response = match (method, uri.path(), body) {
        (Method::POST, path, Err(error)) if path == post => (
            error.status(),
            axum::Json(json!({"error": "无法读取 SDP 请求体"})),
        )
            .into_response(),
        (Method::OPTIONS, _, _) => StatusCode::NO_CONTENT.into_response(),
        (Method::GET, "/", _) => Html(include_str!("meeting_interop_peer.html")).into_response(),
        (Method::GET, "/report", _) => axum::Json(mailbox.report.json()).into_response(),
        (Method::GET, path, _) if path == get => match &mailbox.outgoing {
            Some(raw) => {
                ([(header::CONTENT_TYPE, "application/json")], raw.clone()).into_response()
            }
            None => (
                StatusCode::NOT_FOUND,
                axum::Json(json!({"error": "SDP 未就绪"})),
            )
                .into_response(),
        },
        (Method::POST, path, Ok(body)) if path == post => {
            match serde_json::from_str::<RTCSessionDescription>(&body) {
                Ok(sdp) if body.is_ascii() && sdp.sdp_type == expected && !mailbox.posted => {
                    eprintln!("收到 {expected}：{} 字节", body.len());
                    mailbox.incoming = Some(sdp);
                    mailbox.posted = true;
                    axum::Json(json!({"ok": true})).into_response()
                }
                _ => (
                    StatusCode::BAD_REQUEST,
                    axum::Json(json!({"error": "无效或重复 SDP"})),
                )
                    .into_response(),
            }
        }
        _ => (
            StatusCode::NOT_FOUND,
            axum::Json(json!({"error": "未知端点"})),
        )
            .into_response(),
    };
    response.headers_mut().extend([
        (
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("*"),
        ),
        (
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("content-type"),
        ),
        (
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, OPTIONS"),
        ),
    ]);
    response
}

fn ffmpeg(args: &[&str]) -> Result<Vec<u8>> {
    let output = Command::new("ffmpeg")
        .args(["-nostdin", "-hide_banner", "-loglevel", "error"])
        .args(args)
        .output()
        .map_err(|e| format!("无法运行 FFmpeg：{e}"))?;
    if !output.status.success() {
        return Err(format!("FFmpeg 失败：{}", String::from_utf8_lossy(&output.stderr)).into());
    }
    Ok(output.stdout)
}

fn opus() -> Result<Vec<Bytes>> {
    let bytes = ffmpeg(&[
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000",
        "-t",
        "2",
        "-c:a",
        "libopus",
        "-frame_duration",
        "20",
        "-f",
        "opus",
        "pipe:1",
    ])?;
    let mut reader = PacketReader::new(Cursor::new(bytes));
    reader.read_packet_expected()?;
    reader.read_packet_expected()?;
    (0..100)
        .map(|_| Ok(Bytes::from(reader.read_packet_expected()?.data)))
        .collect()
}

fn vp8(filter: &str) -> Result<Vec<Bytes>> {
    let bytes = ffmpeg(&[
        "-f",
        "lavfi",
        "-i",
        filter,
        "-frames:v",
        "30",
        "-c:v",
        "libvpx",
        "-pix_fmt",
        "yuv420p",
        "-deadline",
        "realtime",
        "-lag-in-frames",
        "0",
        "-threads",
        "2",
        "-g",
        "30",
        "-f",
        "ivf",
        "pipe:1",
    ])?;
    let (mut reader, _) = IVFReader::new(bytes.as_slice())?;
    let frames = (0..30)
        .map(|_| reader.parse_next_frame().map(|(data, _)| data.freeze()))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if frames[0][0] & 1 != 0 {
        return Err("FFmpeg 未在 VP8 序列开头生成关键帧".into());
    }
    Ok(frames)
}

fn publish(shared: &Shared, sdp: &RTCSessionDescription) -> Result<()> {
    let raw = serde_json::to_string(sdp)?;
    if !raw.is_ascii() || raw.len() > LIMIT {
        return Err("原生 SDP 超出会议信令限制".into());
    }
    eprintln!("发布 {}：{} 字节", sdp.sdp_type, raw.len());
    shared.lock().unwrap().outgoing = Some(raw);
    Ok(())
}

async fn negotiate(edge: &mut MeetingEdge, shared: &Shared, role: EdgeRole) -> Result<()> {
    let hash = if role == EdgeRole::Offerer {
        let offer = edge.offer().await?;
        publish(shared, &offer)?;
        Some(offer_hash(&offer))
    } else {
        None
    };
    let incoming = loop {
        if let Some(sdp) = shared.lock().unwrap().incoming.take() {
            break sdp;
        }
        time::sleep(Duration::from_millis(10)).await;
    };
    if let Some(hash) = hash {
        edge.accept_answer(incoming, hash).await?;
    } else {
        publish(shared, &edge.answer(incoming).await?)?;
    }
    loop {
        match edge.connection_state() {
            Connection::Connected => return Ok(()),
            Connection::Failed | Connection::Closed => return Err("WebRTC 连接失败".into()),
            _ => time::sleep(Duration::from_millis(10)).await,
        }
    }
}

async fn exchange(
    edge: &mut MeetingEdge,
    shared: &Shared,
    options: &Options,
    frames: [Vec<Bytes>; 3],
) -> Result<()> {
    time::timeout(CONNECT_TIMEOUT, negotiate(edge, shared, options.role))
        .await
        .map_err(|_| "WebRTC 信令或连接超时")??;
    {
        let route = edge.stats().await.route;
        let mut mailbox = shared.lock().unwrap();
        mailbox.report.connected = true;
        mailbox.report.route = route;
    }
    let media = edge.media();
    let mut events = edge.take_events().ok_or("媒体事件不可用")?;
    for source in SOURCES {
        media.set_enabled(source, true);
    }
    let mut audio = time::interval(AUDIO);
    let mut video = time::interval(VIDEO);
    audio.set_missed_tick_behavior(MissedTickBehavior::Skip);
    video.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut next = [0; 3];
    let stop = time::sleep(Duration::from_secs(options.seconds));
    tokio::pin!(stop);
    loop {
        let range = tokio::select! {
            _ = &mut stop => break,
            _ = audio.tick() => 0..1,
            _ = video.tick() => 1..3,
            event = events.recv() => {
                match event.ok_or("媒体事件流已关闭")? {
                    Event::Frame {source, ..} => {
                        shared.lock().unwrap().report.received[source as usize] += 1;
                    }
                    Event::KeyframeRequested(source) if source != Source::Microphone => {
                        // 每段 VP8 样本从关键帧开始；下一次发送立即回到该帧。
                        next[source as usize] = 0;
                    }
                    _ => {}
                }
                continue;
            }
        };
        for i in range {
            media
                .send(
                    SOURCES[i],
                    frames[i][next[i]].clone(),
                    if i == 0 { AUDIO } else { VIDEO },
                )
                .await?;
            next[i] = (next[i] + 1) % frames[i].len();
            shared.lock().unwrap().report.sent[i] += 1;
        }
    }
    let route = edge.stats().await.route;
    let mut mailbox = shared.lock().unwrap();
    mailbox.report.connected = edge.connection_state() == Connection::Connected;
    mailbox.report.route = route;
    Ok(())
}

async fn run() -> Result<()> {
    let options = Options::parse()?;
    let frames = [
        opus()?,
        vp8("testsrc2=size=320x240:rate=15")?,
        vp8("testsrc2=size=320x240:rate=15,hflip")?,
    ];
    let a = JoinId::new("a")?;
    let b = JoinId::new("b")?;
    let attempt = Attempt {
        edge: EdgeKey::new(RoomId::new("interop")?, a.clone(), b.clone())?,
        attempt_no: 1,
        nonce: [0; 16],
        route: RouteKind::Direct,
        expires_at: Instant::now() + CONNECT_TIMEOUT,
    };
    let mut settings = SettingEngine::default();
    settings.set_include_loopback_candidate(true);
    settings.set_ice_multicast_dns_mode(MulticastDnsMode::Disabled);
    let local = if options.role == EdgeRole::Offerer {
        a
    } else {
        b
    };
    let mut edge = MeetingEdge::new(attempt, local, Route::Direct, vec![], settings).await?;
    let shared = Arc::new(Mutex::new(Mailbox {
        role: options.role,
        incoming: None,
        posted: false,
        outgoing: None,
        report: Report::default(),
    }));
    let app = Router::new()
        .fallback(any(http))
        .layer(DefaultBodyLimit::max(LIMIT))
        .with_state(shared.clone());
    let listener = TcpListener::bind(("127.0.0.1", options.port)).await?;
    eprintln!("邮箱：http://{}", listener.local_addr()?);
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let result = exchange(&mut edge, &shared, &options, frames).await;
    let passed = {
        let mut mailbox = shared.lock().unwrap();
        mailbox.report.connected = edge.connection_state() == Connection::Connected;
        println!("{}", mailbox.report.json());
        mailbox
            .report
            .received
            .iter()
            .zip(options.expect)
            .all(|(&n, expected)| !expected || n >= 10)
    };
    edge.close().await?;
    time::sleep(Duration::from_secs(1)).await;
    server.abort();
    result?;
    if !passed {
        return Err("至少一个 --expect 媒体源收到的帧数不足 10".into());
    }
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
