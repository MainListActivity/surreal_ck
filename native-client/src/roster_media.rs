use std::{collections::BTreeMap, time::Duration};

use futures_util::StreamExt;
use livekit::{
    prelude::*,
    webrtc::{
        desktop_capturer::{DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions},
        native::yuv_helper::argb_to_nv12,
        video_frame::{NV12Buffer, VideoFormatType, VideoFrame, VideoRotation},
        video_source::{RtcVideoSource, VideoResolution, native::NativeVideoSource},
        video_stream::native::NativeVideoStream,
    },
};
use surreal_ck_native_identity::roster::Focus;
use surreal_ck_native_video_view::{FramePublisher, MAX_FRAME_SIDE, RgbaFrame};
use tokio::{sync::watch, task::JoinHandle, time};

use crate::roster_actor::View;

#[derive(Default)]
pub(crate) struct Video {
    tracks: BTreeMap<String, (TrackSource, RemoteVideoTrack)>,
    active: Option<Rendered>,
}

struct Rendered {
    sid: String,
    frames: FramePublisher,
    task: JoinHandle<()>,
}

impl Drop for Rendered {
    fn drop(&mut self) {
        self.frames.close();
        self.task.abort();
    }
}

impl Video {
    pub fn event(&mut self, event: RoomEvent, view: &watch::Sender<View>) {
        match event {
            RoomEvent::TrackSubscribed {
                track: RemoteTrack::Video(track),
                publication,
                participant,
            } if participant.metadata() == "host" => {
                self.tracks
                    .insert(publication.sid().to_string(), (publication.source(), track));
            }
            RoomEvent::TrackUnsubscribed {
                track: RemoteTrack::Video(_),
                publication,
                ..
            } => {
                self.tracks.remove(&publication.sid().to_string());
            }
            _ => return,
        }
        self.refresh(view);
    }

    pub fn refresh(&mut self, view: &watch::Sender<View>) {
        let focus = view.borrow().focus;
        let find = |source| self.tracks.iter().find(|(_, (kind, _))| *kind == source);
        let selected = match focus {
            Focus::Screen => find(TrackSource::Screenshare),
            Focus::Speaker => find(TrackSource::Camera),
            Focus::Auto => find(TrackSource::Screenshare).or_else(|| find(TrackSource::Camera)),
        };
        if self.active.as_ref().map(|active| &active.sid) == selected.map(|(sid, _)| sid) {
            return;
        }
        self.active = None;
        self.active = selected.and_then(|(sid, (_, track))| {
            let frames = surreal_ck_native_video_view::open_stream().ok()?;
            let out = frames.clone();
            let mut input = NativeVideoStream::new(track.rtc_track());
            let task = tokio::spawn(async move {
                while let Some(frame) = input.next().await {
                    let width = frame.buffer.width();
                    let height = frame.buffer.height();
                    if width == 0
                        || height == 0
                        || width > MAX_FRAME_SIDE
                        || height > MAX_FRAME_SIDE
                        || width as usize * height as usize * 4
                            > surreal_ck_native_video_view::MAX_FRAME_BYTES
                    {
                        continue;
                    }
                    let mut bytes = vec![0; width as usize * height as usize * 4];
                    frame.buffer.to_argb(
                        VideoFormatType::ABGR,
                        &mut bytes,
                        width * 4,
                        width as i32,
                        height as i32,
                    );
                    if let Ok(frame) = RgbaFrame::packed(width, height, bytes.into())
                        && out.present(frame).is_err()
                    {
                        break;
                    }
                }
            });
            Some(Rendered {
                sid: sid.clone(),
                frames,
                task,
            })
        });
        view.send_modify(|v| {
            v.video = self
                .active
                .as_ref()
                .map(|active| active.frames.id().to_owned())
        });
    }
}

pub(crate) struct Share {
    sid: TrackSid,
    track: LocalVideoTrack,
    stop: std::sync::mpsc::Sender<()>,
}

impl Share {
    pub async fn start(room: &Room) -> Result<Self, &'static str> {
        let source = NativeVideoSource::new(
            VideoResolution {
                width: 1280,
                height: 720,
            },
            true,
        );
        let input = source.clone();
        let (stop, stopped) = std::sync::mpsc::channel();
        let (ready, started) = tokio::sync::oneshot::channel();
        std::thread::spawn(move || {
            let Some(mut capture) = DesktopCapturer::new(DesktopCapturerOptions::new(
                DesktopCaptureSourceType::Screen,
            )) else {
                return;
            };
            let Some(display) = capture.get_source_list().into_iter().next() else {
                return;
            };
            let mut ready = Some(ready);
            capture.start_capture(Some(display), move |frame| {
                let Ok(frame) = frame else { return };
                let width = frame.width();
                let height = frame.height();
                if width <= 0
                    || height <= 0
                    || width > MAX_FRAME_SIDE as i32
                    || height > MAX_FRAME_SIDE as i32
                {
                    return;
                }
                let mut buffer = NV12Buffer::new(width as u32, height as u32);
                let (stride_y, stride_uv) = buffer.strides();
                let (y, uv) = buffer.data_mut();
                argb_to_nv12(
                    frame.data(),
                    frame.stride(),
                    y,
                    stride_y,
                    uv,
                    stride_uv,
                    width,
                    height,
                );
                if input.capture_frame(&VideoFrame::new(VideoRotation::VideoRotation0, buffer))
                    && let Some(ready) = ready.take()
                {
                    let _ = ready.send(());
                }
            });
            while let Err(std::sync::mpsc::RecvTimeoutError::Timeout) =
                stopped.recv_timeout(Duration::from_millis(66))
            {
                capture.capture_frame();
            }
        });
        if !matches!(
            time::timeout(Duration::from_millis(950), started).await,
            Ok(Ok(()))
        ) {
            return Err("无法捕获屏幕，请检查显示环境与系统授权");
        }
        let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source));
        let published = time::timeout(
            Duration::from_millis(900),
            room.local_participant().publish_track(
                LocalTrack::Video(track.clone()),
                TrackPublishOptions {
                    source: TrackSource::Screenshare,
                    simulcast: false,
                    ..Default::default()
                },
            ),
        )
        .await;
        let Ok(Ok(publication)) = published else {
            track.mute();
            return Err("屏幕共享发布失败");
        };
        Ok(Self {
            sid: publication.sid(),
            track,
            stop,
        })
    }

    pub async fn stop(self, room: &Room) {
        self.track.mute();
        let _ = self.stop.send(());
        let _ = room.local_participant().unpublish_track(&self.sid).await;
    }
}
