//! NSH 引擎与 Tokio 的有界消息桥；网络任务不占用 UI 线程。
use crate::call_bridge::{Call, Control, Notice};
use crate::network_config::{ConnectionMode, ConnectionSettings};
use crate::verification_ui::{Gate, Notice as VerificationNotice, Ticket};
use async_channel::{Receiver, Sender};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use surreal_ck_peer_transport::{
    chat::{Chat, Event},
    manual_verification::ManualVerification,
    transfer::{Event as FileEvent, Transfer},
};
#[derive(Debug)]
pub enum Command {
    Offer(ConnectionSettings),
    Answer(String, ConnectionSettings),
    Accept(String),
    Send(String),
    Close,
    OfferFile(PathBuf),
    AcceptFile(String, PathBuf),
    RejectFile(String),
    CancelFile(String),
    Media(Control),
    InspectVerification(Ticket),
    ConfirmVerification(Ticket, String),
}
#[derive(Debug)]
pub enum Update {
    Code(String),
    Connected(ConnectionMode),
    DirectFailed,
    Text(String),
    Queued(String),
    Status(String),
    Error(String),
    Closed,
    FileOffered(String),
    File(FileEvent),
    Media(Notice),
    Verification(VerificationNotice),
}
struct Current {
    chat: Arc<Chat>,
    files: Transfer,
    file_commands: FileCommands,
    call: Call,
    remote_relay: Arc<AtomicBool>,
}
enum FileCommand {
    Binary(Vec<u8>),
    Offer(PathBuf),
    Accept(String, PathBuf),
    Reject(String),
    Cancel(String),
}
/// 文件hash/协议通知可能等待磁盘或背压，不能占住媒体停止的命令actor。
struct FileCommands {
    input: Sender<FileCommand>,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl FileCommands {
    fn start(files: Transfer, output: Sender<Update>) -> Self {
        let (input, commands) = async_channel::bounded(8);
        let task = tokio::spawn(async move {
            while let Ok(command) = commands.recv().await {
                let result = match command {
                    FileCommand::Binary(bytes) => files.handle_binary(&bytes).await,
                    FileCommand::Offer(path) => match files.offer(path).await {
                        Ok(id) => {
                            let _ = output.send(Update::FileOffered(id)).await;
                            Ok(())
                        }
                        Err(error) => Err(error),
                    },
                    FileCommand::Accept(id, path) => files.accept(&id, path).await,
                    FileCommand::Reject(id) => files.reject(&id).await,
                    FileCommand::Cancel(id) => files.cancel(&id).await,
                };
                if let Err(error) = result {
                    let _ = output.send(Update::Error(error)).await;
                }
            }
        });
        Self {
            input,
            task: Some(task),
        }
    }
    fn enqueue(&self, command: FileCommand) -> Result<(), String> {
        self.input
            .try_send(command)
            .map_err(|_| "文件操作队列已满或已关闭，请重试；未改变媒体状态".into())
    }
    async fn stop(&mut self) {
        self.input.close();
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
    }
}
impl Drop for FileCommands {
    fn drop(&mut self) {
        self.input.close();
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
/// 远端存在 relay 候选只说明可能经中继，并不证明已选中该路径。
/// 用户明确接受对端连接码后允许单端 TURN；Direct + 远端 relay 标为路径待核验。
/// Relay 标签仅用于本端强制 Relay-only 策略，不冒充 selected-pair 测量。
fn has_relay_candidates(code: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(code)
        .ok()
        .and_then(|value| {
            value.get("sdp").and_then(|sdp| sdp.as_str()).map(|sdp| {
                sdp.lines()
                    .filter(|line| line.starts_with("a=candidate:"))
                    .any(|line| {
                        line.split_ascii_whitespace()
                            .collect::<Vec<_>>()
                            .windows(2)
                            .any(|pair| pair == ["typ", "relay"])
                    })
            })
        })
        .unwrap_or(false)
}
type EventTasks = (tokio::task::JoinHandle<()>, tokio::task::JoinHandle<()>);
async fn close_current(
    current: &mut Option<Current>,
    task: &mut Option<EventTasks>,
    output: &Sender<Update>,
) -> Result<(), String> {
    // 先阻断文件准入与有界事件队列，再并行关闭网络、设备与文件工作。
    // 文件命令future被取消不等于阻塞磁盘任务已退出；shutdown必须等待core登记工作。
    let mut result = Ok(());
    if let Some(mut state) = current.take() {
        state.files.request_stop();
        state.file_commands.stop().await;
        if let Some((chat_task, file_task)) = task.take() {
            chat_task.abort();
            file_task.abort();
            let _ = tokio::join!(chat_task, file_task);
        }
        let (network, media, files) = tokio::join!(
            state.chat.close(),
            state.call.shutdown(),
            state.files.shutdown(),
        );
        let mut failures = Vec::new();
        if let Err(error) = network {
            failures.push(format!("网络关闭未确认：{error}"));
        }
        if let Err(error) = media {
            failures.push(format!("媒体关闭未确认：{error}"));
        }
        match files {
            Err(error) => failures.push(format!("文件清理未确认：{error}")),
            Ok(report) if !report.committed.is_empty() => {
                for file in &report.committed {
                    if output
                        .try_send(Update::File(FileEvent::Completed {
                            id: file.id.clone(),
                            destination: file.destination.clone(),
                        }))
                        .is_err()
                    {
                        failures.push("已保存文件的最终回执未送达，结果需要核查".into());
                    }
                }
                let saved = report
                    .committed
                    .iter()
                    .map(|file| {
                        file.destination
                            .as_ref()
                            .map(|path| path.display().to_string())
                            .unwrap_or_else(|| format!("对端已确认的文件 {}", file.id))
                    })
                    .collect::<Vec<_>>()
                    .join("；");
                if output
                    .try_send(Update::Status(format!(
                        "会话已停止；以下文件先于停止完成，未撤回或删除：{saved}"
                    )))
                    .is_err()
                {
                    failures.push(
                        "存在先于停止完成的文件；保存结果通知未送达，不能声称全部已取消".into(),
                    );
                }
            }
            Ok(_) => {}
        }
        if !failures.is_empty() {
            result = Err(failures.join("；"));
            // 保留未知设备/文件状态，阻止新会话默认状态擦除隐私警告。
            *current = Some(state);
        }
    }
    result
}
pub fn start() -> (Sender<Command>, Receiver<Update>, Gate) {
    let (commands, input) = async_channel::bounded(32);
    let (output, events) = async_channel::bounded(128);
    let verification = Gate::default();
    let gate = verification.clone();
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Runtime::new() {
            Ok(rt) => rt,
            Err(e) => {
                let _ = output.send_blocking(Update::Error(e.to_string()));
                return;
            }
        };
        rt.block_on(async move {
            let mut current: Option<Current> = None;
            let mut event_task = None;
            let direct_failed = Arc::new(AtomicBool::new(false));
            // DataChannel关闭不保证PeerConnection关闭。由唯一Current所有者完成全部清理。
            let (remote_stop, mut remote_stops) = tokio::sync::mpsc::unbounded_channel::<(u64, &'static str)>();
            let mut generation = 0_u64;
            loop {
                let (command, remote_reason) = tokio::select! {
                    biased;
                    stopped = remote_stops.recv() => {
                        let Some((stopped, reason)) = stopped else { break; };
                        if stopped != generation || current.is_none() { continue; }
                        (Command::Close, Some(reason))
                    }
                    command = input.recv() => {
                        let Ok(command) = command else { break; };
                        (command, None)
                    }
                };
                match &command {
                    Command::Offer(_) | Command::Answer(_, _) | Command::Close => {
                        gate.connection_changed()
                    }
                    Command::Accept(_) => gate.negotiating(),
                    _ => gate.prune(),
                }
                let mut replacement_started = false;
                let result: Result<(), String> = async {
                    match command {
                        Command::Offer(_) | Command::Answer(_, _) => {
                            let (answer, settings) = match command {
                                Command::Offer(settings) => (None, settings),
                                Command::Answer(code, settings) => (Some(code), settings),
                                _ => unreachable!(),
                            };
                            if answer.as_ref().is_some_and(|code| code.len() > 256 * 1024) {
                                return Err("连接码过长".into());
                            }
                            let mode = settings.mode();
                            let remote_relay = Arc::new(AtomicBool::new(
                                answer.as_deref().is_some_and(has_relay_candidates),
                            ));
                            if mode == ConnectionMode::Relay
                                && !direct_failed.load(Ordering::SeqCst)
                            {
                                return Err(
                                    "请先尝试直连；仅直连失败后可明确选择 TURN 中继重试".into()
                                );
                            }
                            close_current(&mut current, &mut event_task, &output).await?;
                            replacement_started = true;
                            generation = generation.wrapping_add(1);
                            let peer_generation = generation;
                            if mode == ConnectionMode::Direct {
                                direct_failed.store(false, Ordering::SeqCst);
                            }
                            let (route, stun) = settings.into_transport();
                            let (chat, mut incoming) = Chat::new(answer.is_none(), route, stun)
                                .await
                                .map_err(|_| "无法初始化连接，请检查网络服务配置".to_owned())?;
                            let chat = Arc::new(chat);
                            let verification_session = gate.bind(chat.connection_epoch_observer());
                            // 在任何 offer/answer 之前附加默认关闭的音视频轨。
                            let call = match Call::attach(&chat, output.clone()).await {
                                Ok(call) => call,
                                Err(error) => {
                                    let _ = chat.close().await;
                                    return Err(error);
                                }
                            };
                            let (file_tx, mut file_rx) = tokio::sync::mpsc::channel(128);
                            let files = Transfer::new(chat.clone(), file_tx);
                            let file_commands = FileCommands::start(files.clone(), output.clone());
                            let file_input = file_commands.input.clone();
                            let file_events = files.clone();
                            let out = output.clone();
                            let file_out = output.clone();
                            let file_task = tokio::spawn(async move {
                                while let Some(event) = file_rx.recv().await {
                                    if file_out.send(Update::File(event)).await.is_err() {
                                        break;
                                    }
                                }
                            });
                            let failure = direct_failed.clone();
                            let event_remote_relay = remote_relay.clone();
                            let event_verification = gate.clone();
                            let remote_stop = remote_stop.clone();
                            let chat_task = tokio::spawn(async move {
                                loop {
                                    let update = match incoming.recv().await {
                                        Some(Event::Open) => {
                                            Update::Connected(mode.with_remote_relay(
                                                event_remote_relay.load(Ordering::SeqCst),
                                            ))
                                        }
                                        Some(Event::Text(s)) => Update::Text(s),
                                        Some(Event::Binary(bytes)) => {
                                            // 磁盘/通知背压不能挡住后面的DataChannel关闭事件。
                                            if file_input
                                                .try_send(FileCommand::Binary(bytes))
                                                .is_err()
                                            {
                                                file_events.request_stop();
                                                let _ = remote_stop.send((peer_generation, "文件接收队列已满，已停止会话；未完成文件不算成功。"));
                                                break;
                                            }
                                            continue;
                                        }
                                        Some(Event::State(s)) => {
                                            event_verification.prune();
                                            if s == "failed" && mode == ConnectionMode::Direct {
                                                failure.store(true, Ordering::SeqCst);
                                                let _ = out.try_send(Update::DirectFailed);
                                            }
                                            if matches!(
                                                s.as_str(),
                                                "failed" | "closed" | "disconnected"
                                            ) {
                                                file_events.request_stop();
                                                let _ = remote_stop.send((peer_generation, "连接已中断，已请求停止全部媒体和文件。"));
                                                break;
                                            }
                                            Update::Status(s)
                                        }
                                        Some(Event::Closed) | None => {
                                            event_verification.ended(verification_session);
                                            file_events.request_stop();
                                            let _ = remote_stop.send((peer_generation, "聊天通道已关闭，已请求停止全部媒体和文件。"));
                                            break;
                                        }
                                    };
                                    if out.try_send(update).is_err() {
                                        file_events.request_stop();
                                        let _ = remote_stop.send((peer_generation, "界面事件队列已满或关闭，已停止会话；未确认数据不算送达。"));
                                        break;
                                    }
                                }
                            });
                            event_task = Some((chat_task, file_task));
                            current = Some(Current {
                                chat: chat.clone(),
                                file_commands,
                                files,
                                call,
                                remote_relay,
                            });
                            let code = match answer {
                                Some(code) => chat.answer_json(&code).await,
                                None => chat.offer_json().await,
                            };
                            match code {
                                Ok(code) => {
                                    let _ = output.send(Update::Code(code)).await;
                                }
                                Err(error) => {
                                    // 仅真实 ICE 候选收集失败开放回退；格式错误不算直连失败。
                                    if mode == ConnectionMode::Direct
                                        && (error.contains("ICE gathering timed out")
                                            || error.contains("ICE gathered no candidates"))
                                    {
                                        direct_failed.store(true, Ordering::SeqCst);
                                        let _ = output.send(Update::DirectFailed).await;
                                    }
                                    // 底层错误可能包含服务配置，不把原始错误或长期 TURN 凭据发到UI。
                                    return Err(
                                        "生成连接码失败，请检查连接码格式、网络及所选 ICE 服务"
                                            .into(),
                                    );
                                }
                            }
                        }
                        Command::Accept(code) => {
                            if code.len() > 256 * 1024 {
                                return Err("连接码过长".into());
                            }
                            let state = current.as_ref().ok_or("请先创建邀请")?;
                            // 在应用 SDP 前发布候选提示，避免 Open 回调抢先显示 P2P。
                            if has_relay_candidates(&code) {
                                state.remote_relay.store(true, Ordering::SeqCst);
                            }
                            state.chat.accept_answer_json(&code).await.map_err(|_| {
                                "应用应答失败，请检查完整连接码和当前邀请".to_owned()
                            })?;
                        }
                        Command::Send(text) => {
                            current
                                .as_ref()
                                .ok_or("尚未连接")?
                                .chat
                                .send_text(&text)
                                .await?;
                            let _ = output.send(Update::Queued(text)).await;
                        }
                        Command::InspectVerification(ticket) => {
                            let Some(epoch) = gate.connection_epoch(ticket) else {
                                return Ok(());
                            };
                            let Some(state) = current.as_ref() else {
                                return Ok(());
                            };
                            let result =
                                ManualVerification::capture(state.chat.peer(), epoch).await;
                            // 实际回调可在 await 中增代，即使 State 尚在满队列里也拒绝。
                            if !gate.current(ticket) {
                                return Ok(());
                            }
                            let notice = match result {
                                Ok(snapshot) => {
                                    let displayed = snapshot.material().comparison_text();
                                    if !gate.store(ticket, snapshot) {
                                        return Ok(());
                                    }
                                    VerificationNotice::Material(ticket, displayed)
                                }
                                Err(error) => VerificationNotice::Failed(ticket, error.to_string()),
                            };
                            let _ = output.send(Update::Verification(notice)).await;
                        }
                        Command::ConfirmVerification(ticket, displayed) => {
                            let Some(epoch) = gate.connection_epoch(ticket) else {
                                return Ok(());
                            };
                            let Some(state) = current.as_ref() else {
                                return Ok(());
                            };
                            let Some(mut snapshot) = gate.take(ticket) else {
                                return Ok(());
                            };
                            let result = snapshot
                                .confirm_after_trusted_channel_comparison(
                                    state.chat.peer(),
                                    epoch,
                                    &displayed,
                                )
                                .await;
                            if !gate.current(ticket) {
                                snapshot.invalidate();
                                return Ok(());
                            }
                            let notice = match result {
                                Ok(()) => VerificationNotice::Compared(ticket),
                                Err(error) => VerificationNotice::Failed(ticket, error.to_string()),
                            };
                            // 不保留可授予权限的“已认证”对象，只送一次人工断言记录。
                            let _ = output.send(Update::Verification(notice)).await;
                        }
                        Command::OfferFile(path) => current
                            .as_ref()
                            .ok_or("尚未连接")?
                            .file_commands
                            .enqueue(FileCommand::Offer(path))?,
                        Command::AcceptFile(id, path) => current
                            .as_ref()
                            .ok_or("尚未连接")?
                            .file_commands
                            .enqueue(FileCommand::Accept(id, path))?,
                        Command::RejectFile(id) => current
                            .as_ref()
                            .ok_or("尚未连接")?
                            .file_commands
                            .enqueue(FileCommand::Reject(id))?,
                        Command::CancelFile(id) => current
                            .as_ref()
                            .ok_or("尚未连接")?
                            .file_commands
                            .enqueue(FileCommand::Cancel(id))?,
                        Command::Media(control) => {
                            if let Some(state) = current.as_mut() {
                                state.call.control(control).await;
                            } else {
                                let _ = output
                                    .send(Update::Media(Notice::Failed {
                                        source: control.source(),
                                        message: "请先建立与对方的连接，再明确开启媒体".into(),
                                    }))
                                    .await;
                            }
                        }
                        Command::Close => {
                            if remote_reason.is_none() {
                                direct_failed.store(false, Ordering::SeqCst);
                            }
                            let stopped =
                                close_current(&mut current, &mut event_task, &output).await;
                            let _ = output.send(Update::Closed).await;
                            if remote_reason.is_some() && direct_failed.load(Ordering::SeqCst) {
                                let _ = output.send(Update::DirectFailed).await;
                            }
                            stopped?;
                            if let Some(reason) = remote_reason {
                                let _ = output.send(Update::Status(reason.into())).await;
                            }
                        }
                    }
                    Ok(())
                }
                .await;
                if let Err(error) = result {
                    if replacement_started {
                        gate.connection_changed();
                        let _ = close_current(&mut current, &mut event_task, &output).await;
                    }
                    let _ = output.send(Update::Error(error)).await;
                }
            }
            gate.connection_changed();
            let _ = close_current(&mut current, &mut event_task, &output).await;
        });
    });
    (commands, events, verification)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn file_output_backpressure_is_isolated_and_worker_stop_is_bounded() {
        use std::time::Duration;
        use surreal_ck_peer_transport::Route;
        let (chat, _events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
        let chat = Arc::new(chat);
        let (file_events, _receiver) = tokio::sync::mpsc::channel(1);
        let files = Transfer::new(chat.clone(), file_events);
        let (output, updates) = async_channel::bounded(1);
        output
            .send(Update::Status("queue full".into()))
            .await
            .unwrap();
        let mut commands = FileCommands::start(files.clone(), output);
        commands
            .enqueue(FileCommand::Cancel("invalid".into()))
            .unwrap();
        tokio::task::yield_now().await;
        // 文件worker等待发送错误；主actor只try_send，不await该文件操作。
        commands
            .enqueue(FileCommand::Reject("invalid".into()))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), commands.stop())
            .await
            .unwrap();
        commands.stop().await;
        assert!(
            commands
                .enqueue(FileCommand::Cancel("invalid".into()))
                .is_err()
        );
        assert!(matches!(updates.recv().await.unwrap(), Update::Status(_)));
        assert!(updates.try_recv().is_err());
        files.close().await.unwrap();
        chat.close().await.unwrap();
    }
    #[tokio::test]
    async fn session_close_waits_for_file_network_and_media_cleanup() {
        let (chat, chat_events) = Chat::new(true, surreal_ck_peer_transport::Route::Direct, vec![])
            .await
            .unwrap();
        let chat = Arc::new(chat);
        let (file_output, file_events) = tokio::sync::mpsc::channel(1);
        let files = Transfer::new(chat.clone(), file_output);
        let (output, updates) = async_channel::bounded(1);
        let drain = tokio::spawn(async move { while updates.recv().await.is_ok() {} });
        let call = Call::attach(&chat, output.clone()).await.unwrap();
        let commands = FileCommands::start(files.clone(), output.clone());
        let mut current = Some(Current {
            chat,
            files: files.clone(),
            file_commands: commands,
            call,
            remote_relay: Arc::new(AtomicBool::new(false)),
        });
        let mut tasks = None;
        drop(chat_events);
        drop(file_events);
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            close_current(&mut current, &mut tasks, &output),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(current.is_none());
        assert_eq!(files.shutdown().await.unwrap(), Default::default());
        close_current(&mut current, &mut tasks, &output)
            .await
            .unwrap();
        drop(output);
        drain.await.unwrap();
    }
    #[test]
    fn remote_relay_candidates_only_indicate_possible_relay() {
        let relay = serde_json::json!({"type":"offer", "sdp":"v=0\r\na=candidate:1 1 udp 1 192.0.2.1 5000 typ relay raddr 192.0.2.2 rport 5001\r\n"}).to_string();
        assert!(has_relay_candidates(&relay));
        assert!(!has_relay_candidates("{}"));
        assert_eq!(
            ConnectionMode::Direct.with_remote_relay(has_relay_candidates(&relay)),
            ConnectionMode::RelayPossible
        );
        assert_eq!(
            ConnectionMode::Relay.with_remote_relay(has_relay_candidates(&relay)),
            ConnectionMode::Relay
        );
    }
    #[test]
    fn relay_requires_a_real_direct_failure_without_contacting_service() {
        let (tx, rx, _) = start();
        let settings =
            ConnectionSettings::relay("turn:unused.invalid:3478", "test-user", "secret").unwrap();
        assert!(!format!("{settings:?}").contains("secret"));
        tx.send_blocking(Command::Offer(settings)).unwrap();
        match rx.recv_blocking().unwrap() {
            Update::Error(error) => assert!(error.contains("请先尝试直连")),
            other => panic!("unexpected {other:?}"),
        }
        tx.send_blocking(Command::Close).unwrap();
        assert!(matches!(rx.recv_blocking().unwrap(), Update::Closed));
        tx.close();
    }
    #[test]
    fn invalid_sequence_reports_error_then_can_close() {
        let (tx, rx, _) = start();
        tx.send_blocking(Command::Accept("{}".into())).unwrap();
        match rx.recv_blocking().unwrap() {
            Update::Error(s) => assert!(s.contains("请先创建邀请")),
            other => panic!("unexpected {other:?}"),
        }
        tx.send_blocking(Command::Close).unwrap();
        assert!(matches!(rx.recv_blocking().unwrap(), Update::Closed));
        tx.close();
    }
    #[test]
    fn media_before_connect_is_an_explicit_failure_without_capture() {
        let (tx, rx, _) = start();
        tx.send_blocking(Command::Media(Control::Start {
            source: crate::call_bridge::Source::Camera,
            selection: String::new(),
        }))
        .unwrap();
        assert!(matches!(
            rx.recv_blocking().unwrap(),
            Update::Media(Notice::Failed { .. })
        ));
        tx.send_blocking(Command::Close).unwrap();
        assert!(matches!(rx.recv_blocking().unwrap(), Update::Closed));
        tx.close();
    }
}
