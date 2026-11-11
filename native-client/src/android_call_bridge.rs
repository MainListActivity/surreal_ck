//! Android只通过显式原生Activity操作权限与设备，NSH保留权威隐私指示。
use crate::{
    bridge::Update,
    call_bridge::{Control, Notice, Source},
};
use async_channel::Sender;
use surreal_ck_native_call::{AndroidCall, AndroidCallState, android::CaptureStatus};
use surreal_ck_peer_transport::chat::Chat;
use tokio::{sync::watch, task::JoinHandle};
const SOURCES: [Source; 3] = [Source::Microphone, Source::Camera, Source::Screen];
pub struct Call {
    session: AndroidCall,
    states: watch::Receiver<AndroidCallState>,
    output: Sender<Update>,
    pump: Option<JoinHandle<()>>,
}
impl Call {
    #[cfg(feature = "experimental-enterprise-media")]
    pub fn capture_state(&self) -> watch::Receiver<AndroidCallState> {
        self.states.clone()
    }
    pub async fn attach(chat: &Chat, output: Sender<Update>) -> Result<Self, String> {
        let (session, states) = AndroidCall::attach(chat).await?;
        let mut incoming = states.clone();
        let out = output.clone();
        let pump = tokio::spawn(async move {
            let mut previous = None;
            loop {
                let current = incoming.borrow_and_update().clone();
                forward(&out, previous.as_ref(), &current).await;
                previous = Some(current);
                if incoming.changed().await.is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            session,
            states,
            output,
            pump: Some(pump),
        })
    }
    pub async fn control(&mut self, control: Control) {
        let source = control.source();
        let result = match control {
            Control::OpenNativeMedia => self.session.show_controls(),
            Control::StopAllNativeMedia => self.shutdown().await,
            _ => Err("请在原生通话控制页逐项操作设备权限和播放；不会隐式启用媒体。".into()),
        };
        if let Err(message) = result {
            let _ = self
                .output
                .send(Update::Media(Notice::Failed { source, message }))
                .await;
        }
    }
    pub async fn shutdown(&mut self) -> Result<(), String> {
        let result = self.session.stop().await;
        // 等待旧事件泵退出，防止迟到状态覆盖下面的最终权威快照。
        if let Some(pump) = self.pump.take() {
            pump.abort();
            let _ = pump.await;
        }
        let current = self.states.borrow().clone();
        let result = if result.is_ok() && !current.closed {
            Err("Android设备释放没有权威确认，媒体会话保持阻止重用。".into())
        } else {
            result
        };
        forward(&self.output, None, &current).await;
        let _ = self
            .output
            .send(Update::Media(Notice::Stopped {
                confirmed: result.is_ok() && current.closed,
                message: result.as_ref().err().cloned(),
            }))
            .await;
        result
    }
}
impl Drop for Call {
    fn drop(&mut self) {
        if let Some(pump) = &self.pump {
            pump.abort();
        }
    }
}
async fn forward(
    output: &Sender<Update>,
    previous: Option<&AndroidCallState>,
    current: &AndroidCallState,
) {
    for (at, source) in SOURCES.into_iter().enumerate() {
        if previous.is_some_and(|p| {
            p.statuses[at] == current.statuses[at] && p.revisions[at] == current.revisions[at]
        }) {
            continue;
        }
        let notice = match current.statuses[at] {
            CaptureStatus::Stopped => Notice::Capture {
                source,
                active: false,
            },
            CaptureStatus::Running => Notice::Capture {
                source,
                active: true,
            },
            CaptureStatus::Starting => Notice::CapturePending(source),
            CaptureStatus::Stopping => Notice::CaptureStopping(source),
            CaptureStatus::Unconfirmed => Notice::CaptureUnconfirmed(source),
        };
        let _ = output.send(Update::Media(notice)).await;
    }
    if previous.and_then(|s| s.error.as_ref()) != current.error.as_ref()
        && let Some(message) = current.error.as_ref()
    {
        let _ = output
            .send(Update::Media(Notice::Failed {
                source: None,
                message: message.clone(),
            }))
            .await;
    }
}
