use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use livekit::prelude::*;
use surreal_ck_native_identity::{
    IdentityClient, IdentityError, Result, Session, Workspace,
    roster::{Command, Credentials, Focus, Guest, Host, Moderation, State, Status},
};
use tokio::{sync::watch, time};
use zeroize::Zeroizing;

const POLL: Duration = Duration::from_millis(750);
const LEASE_MARGIN_MS: u64 = 30_000;
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Clone, Default, PartialEq)]
pub(crate) struct View {
    pub title: String,
    pub message: String,
    pub connected: bool,
    pub may_speak: bool,
    pub microphone: bool,
    pub focus: Focus,
    pub video: Option<String>,
    pub busy: bool,
    pub host_available: bool,
    pub host: Option<HostView>,
}

pub(crate) enum Action {
    Join(Zeroizing<String>, Zeroizing<String>, Zeroizing<String>),
    Host,
    Open(String, Option<String>, String),
    Lock(bool),
    Focus(Focus),
    Speak(String, bool),
    MuteAll,
    Revoke(String),
    End,
    Share(bool),
    Leave,
    Raise,
    Microphone(bool),
}

#[derive(Clone)]
pub(crate) struct HostScope {
    client: IdentityClient,
    session: Arc<Session>,
    workspace: Workspace,
}

impl HostScope {
    pub fn new(
        client: &IdentityClient,
        session: &Arc<Session>,
        workspace: &Workspace,
    ) -> Option<Self> {
        client.roster_host(session, workspace).ok()?;
        Some(Self {
            client: client.clone(),
            session: session.clone(),
            workspace: workspace.clone(),
        })
    }

    fn api(&self) -> Result<Host<'_>> {
        self.client.roster_host(&self.session, &self.workspace)
    }
}

#[derive(Clone, Default, PartialEq)]
pub(crate) struct HostView {
    pub meetings: Vec<(String, Option<String>, String)>,
    pub locked: bool,
    pub participants: Vec<Attendee>,
    pub sharing: bool,
}

#[derive(Clone, PartialEq)]
pub(crate) struct Attendee {
    pub id: String,
    pub name: String,
    pub raised_at: Option<u64>,
    pub speaking: bool,
}

pub(crate) fn start(
    mut scope: watch::Receiver<Option<HostScope>>,
) -> (async_channel::Sender<Action>, watch::Receiver<View>) {
    let (tx, rx) = async_channel::unbounded();
    let (view, updates) = watch::channel(View::default());
    std::thread::spawn(move || {
        let Ok(runtime) = tokio::runtime::Runtime::new() else {
            view.send_modify(|v| v.message = "无法启动原生名册会议".into());
            return;
        };
        runtime.block_on(async move {
            loop {
                let current = scope.borrow_and_update().clone();
                view.send_modify(|v| v.host_available = current.is_some());
                let action = tokio::select! {
                    biased;
                    changed = scope.changed() => {
                        if changed.is_err() { break; }
                        continue;
                    }
                    action = rx.recv() => match action {
                        Ok(action) => action,
                        Err(_) => break,
                    },
                };
                let result = match action {
                    Action::Join(invitation, code, check) => {
                        view.send_modify(|v| {
                            v.busy = true;
                            v.message = "正在核验名册".into();
                        });
                        join(invitation, code, check, &rx, &view).await
                    }
                    Action::Host if current.is_some() => {
                        view.send_modify(|v| {
                            v.busy = true;
                            v.host = Some(HostView::default());
                            v.message = "正在读取名册会议".into();
                        });
                        host(current.unwrap(), &mut scope, &rx, &view).await
                    }
                    _ => continue,
                };
                view.send_modify(|v| {
                    let message = result
                        .err()
                        .map_or_else(|| std::mem::take(&mut v.message), |error| error.to_string());
                    *v = View {
                        message,
                        ..View::default()
                    };
                });
            }
        });
    });
    (tx, updates)
}

async fn join(
    invitation: Zeroizing<String>,
    code: Zeroizing<String>,
    check: Zeroizing<String>,
    actions: &async_channel::Receiver<Action>,
    view: &watch::Sender<View>,
) -> Result<()> {
    let Some(verified) = until_left(
        actions,
        request(move || {
            let (client, _) =
                crate::identity_ui::configured().map_err(|_| IdentityError::Configuration)?;
            client.verify_roster(
                &invitation,
                &code,
                (!check.is_empty()).then_some(check.as_str()),
            )
        }),
    )
    .await
    else {
        return Ok(());
    };
    let (session, status) = verified?;
    guest(session, status, actions, view).await
}

async fn host(
    account: HostScope,
    scope: &mut watch::Receiver<Option<HostScope>>,
    actions: &async_channel::Receiver<Action>,
    view: &watch::Sender<View>,
) -> Result<()> {
    let meetings = {
        let account = account.clone();
        tokio::select! {
            _ = scope.changed() => return Ok(()),
            reply = until_left(actions, request(move || account.api()?.meetings())) => {
                let Some(meetings) = reply else { return Ok(()) };
                meetings?
            }
        }
    };
    view.send_modify(|v| {
        v.host = Some(HostView {
            meetings: meetings
                .into_iter()
                .filter(|m| m.status == "open")
                .map(|m| (m.id, m.room_id, m.title))
                .collect(),
            ..HostView::default()
        });
        v.message = "选择要主持的正式会议".into();
    });
    let (meeting, room, title) = loop {
        tokio::select! {
            biased;
            _ = scope.changed() => return Ok(()),
            action = actions.recv() => match action {
                Ok(Action::Open(meeting, room, title)) => break (meeting, room, title),
                Err(_) | Ok(Action::Leave) => return Ok(()),
                _ => {}
            }
        }
    };
    view.send_modify(|v| {
        v.title = title;
        v.message = "正在连接主持席位".into();
    });
    let (credentials, room_id) = {
        let account = account.clone();
        let meeting = meeting.clone();
        tokio::select! {
            _ = scope.changed() => return Ok(()),
            reply = until_left(actions, request(move || {
                let api = account.api()?;
                let room = match room { Some(room) => room, None => api.start(&meeting)? };
                Ok((api.credentials(&room)?, room))
            })) => {
                let Some(reply) = reply else { return Ok(()) };
                reply?
            }
        }
    };
    let mut lease = credentials.lease_expires_at;
    let (room, mut events) = tokio::select! {
        _ = scope.changed() => return Ok(()),
        reply = until_left(actions, connect(credentials)) => {
            let Some(reply) = reply else { return Ok(()) };
            reply?
        }
    };
    let audio = PlatformAudio::new().ok();
    view.send_modify(|v| {
        v.connected = true;
        v.message = "已进入主持席位".into();
        v.host = Some(HostView::default());
    });
    let mut ticks = time::interval(POLL);
    ticks.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    let mut moderation = None::<Moderation>;
    let mut pending = None::<tokio::task::JoinHandle<Result<HostUpdate>>>;
    let mut queued = std::collections::VecDeque::new();
    let mut share = None;
    let mut video = crate::roster_media::Video::default();
    let result = loop {
        tokio::select! {
            biased;
            _ = scope.changed() => break Ok(()),
            event = events.recv() => match event {
                None | Some(RoomEvent::Disconnected { .. } | RoomEvent::Reconnecting) => break Ok(()),
                Some(event) => video.event(event, view),
            },
            action = actions.recv() => match action {
                Err(_) | Ok(Action::Leave) => break Ok(()),
                Ok(Action::Share(true)) if share.is_none() => {
                    match crate::roster_media::Share::start(&room).await {
                        Ok(active) => {
                            share = Some(active);
                            view.send_modify(|v| {
                                if let Some(host) = &mut v.host { host.sharing = true; }
                            });
                        }
                        Err(message) => view.send_modify(|v| v.message = message.into()),
                    }
                }
                Ok(Action::Share(false)) => {
                    if let Some(active) = share.take() { active.stop(&room).await; }
                    view.send_modify(|v| {
                        if let Some(host) = &mut v.host { host.sharing = false; }
                    });
                }
                Ok(action @ (Action::Lock(_) | Action::Focus(_) | Action::Speak(..) | Action::MuteAll | Action::Revoke(_) | Action::End)) if queued.len() < 16 => queued.push_back(action),
                _ => {}
            },
            reply = async { pending.as_mut().unwrap().await }, if pending.is_some() => {
                pending = None;
                match reply {
                    Ok(Ok(HostUpdate::Ended)) => {
                        view.send_modify(|v| v.message = "已结束全体会议".into());
                        break Ok(());
                    }
                    Ok(Ok(HostUpdate::Snapshot(next, next_lease))) => {
                        lease = next_lease;
                        view.send_modify(|v| {
                            v.focus = next.focus;
                            if let Some(host) = &mut v.host {
                                host.locked = next.locked;
                                host.participants = next.participants.iter().map(|p| Attendee {
                                    id: p.id.clone(), name: p.name.clone(), raised_at: p.raised_at, speaking: p.speaking,
                                }).collect();
                            }
                        });
                        video.refresh(view);
                        moderation = Some(next);
                    }
                    Ok(Err(error @ (IdentityError::Http(401 | 403 | 404 | 409) | IdentityError::SessionExpired))) => break Err(error),
                    Ok(Err(error)) => view.send_modify(|v| v.message = error.to_string()),
                    Err(_) => break Err(IdentityError::Network),
                }
            }
            _ = ticks.tick() => {
                if now_ms() >= lease { break Err(IdentityError::MeetingExpired); }
                if pending.is_none() {
                    let account = account.clone();
                    let meeting = meeting.clone();
                    let room_id = room_id.clone();
                    let action = queued.pop_front();
                    let pass = match (&action, &moderation) {
                        (Some(Action::Revoke(identity)), Some(current)) => current.participants.iter()
                            .find(|p| &p.id == identity).map(|p| p.pass.clone()),
                        _ => None,
                    };
                    pending = Some(tokio::spawn(request(move || {
                        let api = account.api()?;
                        let command = match &action {
                            Some(Action::Lock(locked)) => Some(Command::Lock { locked: *locked }),
                            Some(Action::Focus(focus)) => Some(Command::Focus { focus: *focus }),
                            Some(Action::Speak(identity, true)) => Some(Command::Allow { identity }),
                            Some(Action::Speak(identity, false)) => Some(Command::Withdraw { identity }),
                            Some(Action::MuteAll) => Some(Command::MuteAll),
                            Some(Action::Revoke(_)) => {
                                api.revoke(&meeting, pass.as_deref().ok_or(IdentityError::MeetingRetry)?)?;
                                None
                            }
                            Some(Action::End) => {
                                api.end(&meeting)?;
                                return Ok(HostUpdate::Ended);
                            }
                            _ => None,
                        };
                        let snapshot = api.moderation(&meeting, command)?;
                        let lease = if lease.saturating_sub(now_ms()) <= LEASE_MARGIN_MS {
                            api.credentials(&room_id)?.lease_expires_at
                        } else { lease };
                        Ok(HostUpdate::Snapshot(snapshot, lease))
                    })));
                }
            }
        }
    };
    if let Some(task) = pending {
        task.abort();
    }
    if let Some(active) = share {
        active.stop(&room).await;
    }
    drop(video);
    drop(audio);
    let _ = room.close().await;
    result
}

enum HostUpdate {
    Ended,
    Snapshot(Moderation, u64),
}

async fn request<T: Send + 'static>(run: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(run)
        .await
        .map_err(|_| IdentityError::Network)?
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(u64::MAX, |elapsed| elapsed.as_millis() as u64)
}

fn terminal(status: &Status) -> Option<&'static str> {
    if status.ended {
        return Some("主持人已结束会议");
    }
    match status.state {
        State::Waiting | State::Admitted => None,
        State::Replaced => Some("此席位已在另一台设备核验"),
        State::Kicked => Some("主持人已移出此席位"),
        State::Revoked => Some("本场参会资格已失效"),
    }
}

async fn until_left<T>(
    actions: &async_channel::Receiver<Action>,
    operation: impl Future<Output = T>,
) -> Option<T> {
    tokio::pin!(operation);
    loop {
        tokio::select! {
            biased;
            action = actions.recv() => {
                if matches!(action, Err(_) | Ok(Action::Leave)) {
                    return None;
                }
            }
            result = &mut operation => return Some(result),
        }
    }
}

pub(crate) async fn guest(
    guest: Guest,
    mut status: Status,
    actions: &async_channel::Receiver<Action>,
    view: &watch::Sender<View>,
) -> Result<()> {
    let guest = Arc::new(guest);
    let credentials = loop {
        if let Some(message) = terminal(&status) {
            view.send_modify(|v| v.message = message.into());
            return Ok(());
        }
        let mut message = "等待主持人准入";
        if status.state == State::Admitted {
            let guest = guest.clone();
            match until_left(actions, request(move || guest.credentials())).await {
                None => return Ok(()),
                Some(Ok(credentials)) => break credentials,
                Some(Err(IdentityError::Http(409))) => message = "等待主持人开启媒体",
                Some(Err(IdentityError::Http(423))) => message = "会议已锁定，暂不接受新入场",
                Some(Err(error)) => return Err(error),
            }
        }
        view.send_modify(|v| {
            v.title.clone_from(&status.title);
            v.message = message.into();
        });
        let guest = guest.clone();
        let Some(next) = until_left(actions, async move {
            time::sleep(POLL).await;
            request(move || guest.status()).await
        })
        .await
        else {
            return Ok(());
        };
        status = next?;
    };
    view.send_modify(|v| {
        v.title = status.title;
        v.focus = status.focus;
        v.message = "正在加入私有 SFU".into();
    });
    let lease = credentials.lease_expires_at;
    let Some((room, events)) = until_left(actions, connect(credentials))
        .await
        .transpose()?
    else {
        return Ok(());
    };
    let control = GuestControl { guest, lease };
    run_room(room, events, actions, view, control).await
}

pub(crate) async fn connect(
    credentials: Credentials,
) -> Result<(Room, tokio::sync::mpsc::UnboundedReceiver<RoomEvent>)> {
    let mut options = RoomOptions::default();
    options.single_peer_connection = false;
    time::timeout(
        CONNECTION_TIMEOUT,
        Room::connect(credentials.url.as_str(), &credentials.token, options),
    )
    .await
    .map_err(|_| IdentityError::Network)?
    .map_err(|_| IdentityError::MeetingUnavailable)
}

struct GuestControl {
    guest: Arc<Guest>,
    lease: u64,
}

struct Update {
    status: Status,
    lease: u64,
}

impl GuestControl {
    async fn poll(&self) -> Result<Update> {
        let guest = self.guest.clone();
        let lease = self.lease;
        request(move || {
            let status = guest.status()?;
            let lease = if terminal(&status).is_none()
                && status.state == State::Admitted
                && lease.saturating_sub(now_ms()) <= LEASE_MARGIN_MS
            {
                guest.credentials()?.lease_expires_at
            } else {
                lease
            };
            Ok(Update { status, lease })
        })
        .await
    }
}

struct Microphone {
    track: LocalAudioTrack,
    sid: TrackSid,
}

impl Microphone {
    async fn publish(room: &Room) -> Result<Self> {
        let track = LocalAudioTrack::create_audio_track("microphone", RtcAudioSource::Device);
        let publication = time::timeout(
            Duration::from_millis(900),
            room.local_participant().publish_track(
                LocalTrack::Audio(track.clone()),
                TrackPublishOptions {
                    source: TrackSource::Microphone,
                    ..Default::default()
                },
            ),
        )
        .await
        .map_err(|_| IdentityError::Network)?
        .map_err(|_| IdentityError::MeetingDenied)?;
        Ok(Self {
            track,
            sid: publication.sid(),
        })
    }

    async fn stop(self, room: &Room, audio: &PlatformAudio) -> Result<()> {
        self.track.mute();
        let stopped = audio.stop_recording();
        let _ = room.local_participant().unpublish_track(&self.sid).await;
        stopped.map_err(|_| IdentityError::MeetingUnavailable)
    }
}

fn may_publish(can_publish: bool, sources: &[i32]) -> bool {
    const MICROPHONE: i32 = 2;
    can_publish && (sources.is_empty() || sources.contains(&MICROPHONE))
}

async fn run_room(
    room: Room,
    mut events: tokio::sync::mpsc::UnboundedReceiver<RoomEvent>,
    actions: &async_channel::Receiver<Action>,
    view: &watch::Sender<View>,
    mut control: GuestControl,
) -> Result<()> {
    let Ok(audio) = PlatformAudio::new() else {
        let _ = room.close().await;
        return Err(IdentityError::MeetingUnavailable);
    };
    let local = room.local_participant();
    let mut grant = local.permission().is_some_and(|permission| {
        may_publish(permission.can_publish, &permission.can_publish_sources)
    });
    let mut microphone = None::<Microphone>;
    let mut poller = time::interval(POLL);
    poller.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    let mut pending = None::<tokio::task::JoinHandle<Result<Update>>>;
    let mut raised = None::<tokio::task::JoinHandle<Result<()>>>;
    let mut video = crate::roster_media::Video::default();
    view.send_modify(|v| {
        v.connected = true;
        v.may_speak = grant;
        v.message = "已加入 · 默认只听".into();
    });
    let result = loop {
        tokio::select! {
            biased;
            event = events.recv() => match event {
                None | Some(RoomEvent::Disconnected { .. } | RoomEvent::Reconnecting) => {
                    view.send_modify(|v| v.message = "会议连接已关闭".into());
                    break Ok(());
                }
                Some(RoomEvent::ParticipantPermissionChanged { participant: Participant::Local(_), permission }) => {
                    grant = permission.is_some_and(|p| may_publish(p.can_publish, &p.can_publish_sources));
                    if !grant && let Some(track) = microphone.take() && let Err(error) = track.stop(&room, &audio).await {
                        break Err(error);
                    }
                    view.send_modify(|v| {
                        v.may_speak = grant;
                        v.microphone = microphone.is_some();
                    });
                }
                Some(event) => video.event(event, view),
            },
            action = actions.recv() => match action {
                Err(_) | Ok(Action::Leave) => {
                    view.send_modify(|v| v.message = "已离开会议".into());
                    break Ok(());
                }
                Ok(Action::Raise) if raised.is_none() => {
                    let guest = control.guest.clone();
                    raised = Some(tokio::spawn(request(move || guest.raise_hand())));
                }
                Ok(Action::Microphone(true)) if grant && microphone.is_none()
                    && local.permission().is_some_and(|p| may_publish(p.can_publish, &p.can_publish_sources)) => {
                    match Microphone::publish(&room).await {
                        Ok(track) => {
                            microphone = Some(track);
                            view.send_modify(|v| v.microphone = true);
                        }
                        Err(error) => {
                            let _ = audio.stop_recording();
                            break Err(error);
                        }
                    }
                }
                Ok(Action::Microphone(false)) => {
                    if let Some(track) = microphone.take() && let Err(error) = track.stop(&room, &audio).await {
                        break Err(error);
                    }
                    view.send_modify(|v| v.microphone = false);
                }
                _ => {}
            },
            _ = poller.tick() => {
                if now_ms() >= control.lease {
                    break Err(IdentityError::MeetingExpired);
                }
                if pending.is_none() {
                    let work = GuestControl { guest: control.guest.clone(), lease: control.lease };
                    pending = Some(tokio::spawn(async move { work.poll().await }));
                }
            }
            reply = async { pending.as_mut().unwrap().await }, if pending.is_some() => {
                pending = None;
                match reply {
                    Ok(Ok(update)) => {
                        if let Some(message) = terminal(&update.status) {
                            view.send_modify(|v| v.message = message.into());
                            break Ok(());
                        }
                        if update.status.state != State::Admitted {
                            break Err(IdentityError::MeetingDenied);
                        }
                        control.lease = update.lease;
                        view.send_modify(|v| v.focus = update.status.focus);
                        video.refresh(view);
                    }
                    Ok(Err(error)) => break Err(error),
                    Err(_) => break Err(IdentityError::Network),
                }
            }
            reply = async { raised.as_mut().unwrap().await }, if raised.is_some() => {
                raised = None;
                view.send_modify(|v| {
                    v.message = match reply {
                        Ok(Ok(())) => "已提交举手申请".into(),
                        Ok(Err(error)) => error.to_string(),
                        Err(_) => IdentityError::Network.to_string(),
                    };
                });
            }
        }
    };
    if let Some(task) = pending {
        task.abort();
    }
    if let Some(task) = raised {
        task.abort();
    }
    let stopped = if let Some(track) = microphone {
        track.stop(&room, &audio).await
    } else {
        Ok(())
    };
    drop(video);
    drop(audio);
    view.send_modify(|v| {
        v.connected = false;
        v.may_speak = false;
        v.microphone = false;
        v.video = None;
    });
    let _ = room.close().await;
    result.and(stopped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roster_mic_requires_server_mic_permission() {
        assert!(!may_publish(false, &[2]));
        assert!(!may_publish(true, &[1, 3]));
        assert!(may_publish(true, &[2]));
        assert!(may_publish(true, &[]));
    }
}
