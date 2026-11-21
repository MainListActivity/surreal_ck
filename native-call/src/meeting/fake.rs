//! 无设备、无网络操作的会议控制替身。
use super::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Start(Source),
    Stop(Source),
    Attach(MemberSlot),
    Detach(MemberSlot),
    RemoteAudio(bool),
    RemoteVideo(bool),
    Shutdown,
}
pub struct FakeMeetingMedia {
    commands: Vec<Command>,
    events: mpsc::Sender<MeetingEvent>,
    states: watch::Sender<CaptureState>,
    playback: Vec<(MemberSlot, watch::Sender<CaptureState>)>,
    stopped: bool,
    remote_audio: bool,
    remote_video: bool,
}
impl FakeMeetingMedia {
    pub fn new() -> (Self, mpsc::Receiver<MeetingEvent>) {
        let (events, received) = mpsc::channel(64);
        (
            Self {
                commands: Vec::new(),
                events,
                states: watch::channel(CaptureState::default()).0,
                playback: Vec::new(),
                stopped: false,
                remote_audio: false,
                remote_video: false,
            },
            received,
        )
    }
    pub fn commands(&self) -> &[Command] {
        &self.commands
    }
    pub fn emit(&self, event: MeetingEvent) -> Result<(), mpsc::error::TrySendError<MeetingEvent>> {
        self.events.try_send(event)
    }
    fn active(&self) -> Result<(), Error> {
        if self.stopped {
            Err(Error::Stopped)
        } else {
            Ok(())
        }
    }
}
impl MeetingMediaControl for FakeMeetingMedia {
    fn start_capture(&mut self, source: Source, _input: CaptureInput) -> MediaFuture<'_, ()> {
        Box::pin(async move {
            self.active()?;
            self.commands.push(Command::Start(source));
            capture_state_changed(&self.states, source, CaptureStatus::Running, None);
            emit(&self.events, MeetingEvent::CaptureStarted(source));
            Ok(())
        })
    }
    fn stop_capture(&mut self, source: Source) -> MediaFuture<'_, ()> {
        Box::pin(async move {
            self.commands.push(Command::Stop(source));
            capture_state_changed(&self.states, source, CaptureStatus::Stopped, None);
            emit(&self.events, MeetingEvent::CaptureStopped(source));
            Ok(())
        })
    }
    fn attach_edge(
        &mut self,
        slot: MemberSlot,
        _media: Arc<Media>,
        _events: mpsc::Receiver<Event>,
    ) -> MediaFuture<'_, ()> {
        Box::pin(async move {
            self.active()?;
            for (old, state) in &self.playback {
                if old.member_id == slot.member_id {
                    for source in ALL_SOURCES {
                        capture_state_changed(state, source, CaptureStatus::Stopped, None);
                    }
                }
            }
            self.playback
                .retain(|(old, _)| old.member_id != slot.member_id);
            if self.playback.len() >= MAX_EDGES {
                return Err(Error::Invalid);
            }
            self.commands.push(Command::Attach(slot.clone()));
            let state = watch::channel(CaptureState::default()).0;
            for source in ALL_SOURCES {
                let enabled = if source == Source::Microphone {
                    self.remote_audio
                } else {
                    self.remote_video
                };
                capture_state_changed(
                    &state,
                    source,
                    if enabled {
                        CaptureStatus::Running
                    } else {
                        CaptureStatus::Stopped
                    },
                    None,
                );
            }
            self.playback.push((slot.clone(), state));
            emit(&self.events, MeetingEvent::EdgeAttached(slot));
            Ok(())
        })
    }
    fn detach_edge<'a>(&'a mut self, slot: &'a MemberSlot) -> MediaFuture<'a, ()> {
        Box::pin(async move {
            self.commands.push(Command::Detach(slot.clone()));
            for (old, state) in &self.playback {
                if old == slot {
                    for source in ALL_SOURCES {
                        capture_state_changed(state, source, CaptureStatus::Stopped, None);
                    }
                }
            }
            self.playback.retain(|(old, _)| old != slot);
            emit(&self.events, MeetingEvent::EdgeDetached(slot.clone()));
            Ok(())
        })
    }
    fn set_remote_audio_enabled(&mut self, enabled: bool) -> MediaFuture<'_, ()> {
        Box::pin(async move {
            self.active()?;
            self.commands.push(Command::RemoteAudio(enabled));
            self.remote_audio = enabled;
            for (_, state) in &self.playback {
                capture_state_changed(
                    state,
                    Source::Microphone,
                    if enabled {
                        CaptureStatus::Running
                    } else {
                        CaptureStatus::Stopped
                    },
                    None,
                );
            }
            Ok(())
        })
    }
    fn set_remote_video_enabled(&mut self, enabled: bool) -> MediaFuture<'_, ()> {
        Box::pin(async move {
            self.active()?;
            self.commands.push(Command::RemoteVideo(enabled));
            self.remote_video = enabled;
            for (_, state) in &self.playback {
                for source in [Source::Camera, Source::Screen] {
                    capture_state_changed(
                        state,
                        source,
                        if enabled {
                            CaptureStatus::Running
                        } else {
                            CaptureStatus::Stopped
                        },
                        None,
                    );
                }
            }
            Ok(())
        })
    }
    fn capture_state(&self) -> watch::Receiver<CaptureState> {
        self.states.subscribe()
    }
    fn playback_state(&self, slot: &MemberSlot) -> Option<watch::Receiver<CaptureState>> {
        self.playback
            .iter()
            .find(|(old, _)| old == slot)
            .map(|(_, state)| state.subscribe())
    }
    fn shutdown(&mut self) -> MediaFuture<'_, ()> {
        Box::pin(async move {
            self.commands.push(Command::Shutdown);
            self.stopped = true;
            for source in ALL_SOURCES {
                capture_state_changed(&self.states, source, CaptureStatus::Stopped, None);
            }
            for (_, state) in &self.playback {
                for source in ALL_SOURCES {
                    capture_state_changed(state, source, CaptureStatus::Stopped, None);
                }
            }
            Ok(())
        })
    }
}
