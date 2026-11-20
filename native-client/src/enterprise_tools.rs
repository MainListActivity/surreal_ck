//! 企业媒体UI常驻所有者；身份面板折叠和旧身份事件不能隐藏采集风险。
use crate::{
    bridge::Command,
    call_bridge::{EnterpriseCaptureState, EnterpriseMediaHandle, Notice},
    call_ui::CallUi,
    enterprise_peer::LeaseObserver,
};
use nsh_core::prelude::*;
use tokio::sync::watch;

#[derive(Clone)]
struct Binding {
    epoch: u64,
    generation: u64,
    session: u64,
    lease: LeaseObserver,
    handle: EnterpriseMediaHandle,
}
#[derive(Clone, Copy)]
pub(crate) struct MediaTools {
    call: CallUi,
    binding: Signal<Option<Binding>>,
    connected: Signal<bool>,
    accepting: Signal<bool>,
    input: Signal<Option<async_channel::Receiver<Command>>>,
}
impl MediaTools {
    pub(crate) fn new() -> Self {
        Self {
            call: CallUi::new(),
            binding: signal_with(None, SignalEquals::Never),
            connected: signal(false),
            accepting: signal(false),
            input: signal_with(None, SignalEquals::Never),
        }
    }
    pub(crate) fn invalidate(self) {
        self.accepting.set(false);
        self.connected.set(false);
        self.drain_commands();
        if let Some(binding) = self.binding.get_untracked() {
            binding.handle.request_stop();
        }
        // 断线只增加不确定性；真实快照负责逐源消除，不能伪造关闭。
        self.call.disconnected();
    }
    pub(crate) fn bind(
        self,
        epoch: u64,
        generation: u64,
        lease: LeaseObserver,
        handle: EnterpriseMediaHandle,
        mut states: watch::Receiver<EnterpriseCaptureState>,
    ) {
        if self.call.needs_stop() {
            handle.request_stop();
            self.call.event(Notice::Failed {
                source: None,
                message: "旧企业媒体尚有未确认的设备或播放状态，新媒体未启用；请先确认停止。"
                    .into(),
            });
            return;
        }
        self.drain_commands();
        if !self.call.apply_enterprise_snapshot(&states.borrow()) {
            handle.request_stop();
            return;
        }
        let session = states.borrow().session_id;
        self.connected.set(false);
        self.accepting.set(true);
        self.binding.set(Some(Binding {
            epoch,
            generation,
            session,
            lease,
            handle,
        }));
        spawn(async move {
            loop {
                let snapshot = states.borrow_and_update().clone();
                if self
                    .binding
                    .get_untracked()
                    .is_none_or(|b| b.session != session)
                {
                    break;
                }
                // 不检查已撤销lease：最终设备停止事实必须继续展示在原常驻UI。
                self.call.apply_enterprise_snapshot(&snapshot);
                if snapshot.shutdown.is_some() {
                    self.accepting.set(false);
                    self.connected.set(false);
                }
                if states.changed().await.is_err() {
                    if snapshot.shutdown.is_none() {
                        self.invalidate();
                    }
                    break;
                }
            }
        });
    }
    pub(crate) fn opened(self, epoch: u64, generation: u64) {
        self.connected.set(
            self.accepting.get_untracked()
                && self.binding.get_untracked().is_some_and(|b| {
                    b.epoch == epoch && b.generation == generation && b.lease.is_active()
                }),
        );
    }
    pub(crate) fn event(self, epoch: u64, generation: u64, notice: Notice) {
        // 采集状态只采用可重放真实watch；普通队列迟到通知不能覆盖较新revision。
        if matches!(notice, Notice::Capture { .. } | Notice::Stopped { .. }) {
            return;
        }
        #[cfg(all(target_os = "android", feature = "android-native-media"))]
        if matches!(
            notice,
            Notice::CapturePending(_) | Notice::CaptureStopping(_) | Notice::CaptureUnconfirmed(_)
        ) {
            return;
        }
        if self.accepting.get_untracked()
            && self.binding.get_untracked().is_some_and(|b| {
                b.epoch == epoch && b.generation == generation && b.lease.is_active()
            })
        {
            self.call.event(notice);
        }
    }
    fn drain_commands(self) {
        if let Some(input) = self.input.get_untracked() {
            while input.try_recv().is_ok() {}
        }
    }
    pub(crate) fn view(self) -> impl IntoElement {
        let (tx, rx) = async_channel::bounded(16);
        self.input.set(Some(rx.clone()));
        spawn(async move {
            while let Ok(command) = rx.recv().await {
                if let Command::Media(control) = command {
                    if let Some(binding) = self.binding.get_untracked() {
                        match binding.handle.submit(control.clone()) {
                            Ok(operation) => {
                                self.call.enterprise_control_submitted(&control, operation)
                            }
                            Err(message) => {
                                self.call.enterprise_control_rejected(&control, &message)
                            }
                        }
                    } else {
                        self.call.disconnected();
                    }
                }
            }
        });
        view()
            .style_when(
                move || self.binding.get().is_none() && !self.call.needs_stop(),
                |style| style.hidden(),
            )
            .child(text("企业会话媒体 · 隐私与停止"))
            .child(crate::ui::action(
                "立即停止企业媒体",
                || false,
                move || self.invalidate(),
            ))
            .child(self.call.view(tx, self.connected))
    }
}
