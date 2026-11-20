//! 人工核对只记录一次用户断言，不代表企业身份、角色或持续连接认证。
use crate::{bridge::Command, ui};
use async_channel::Sender;
use nsh_base::theme;
use nsh_core::prelude::*;
use std::sync::{Arc, Mutex};
use surreal_ck_peer_transport::{chat::ConnectionEpoch, manual_verification::ManualVerification};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ticket {
    generation: u64,
    request: u64,
    connection: u64,
}

#[derive(Debug)]
pub enum Notice {
    Material(Ticket, String),
    Compared(Ticket),
    Failed(Ticket, String),
}

#[derive(Default)]
struct State {
    generation: u64,
    request: u64,
    session: u64,
    source: Option<ConnectionEpoch>,
    snapshot: Option<(Ticket, ManualVerification)>,
    exhausted: bool,
}
impl State {
    fn next(value: &mut u64, exhausted: &mut bool) {
        match value.checked_add(1) {
            Some(next) => *value = next,
            None => *exhausted = true,
        }
    }
    fn matches(&self, ticket: Ticket) -> bool {
        !self.exhausted
            && ticket.connection != 0
            && ticket.generation == self.generation
            && ticket.request == self.request
            && self
                .source
                .as_ref()
                .is_some_and(|s| s.current() == ticket.connection)
    }
    fn discard(&mut self) {
        if let Some((_, mut snapshot)) = self.snapshot.take() {
            snapshot.invalidate();
        }
    }
}

/// 回调计数独立于有界 output 队列。UI 和 actor 都在使用结果时重新读取它。
#[derive(Clone, Default)]
pub struct Gate(Arc<Mutex<State>>);
impl PartialEq for Gate {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}
impl Gate {
    pub fn negotiating(&self) {
        let mut state = self.0.lock().unwrap();
        state.discard();
        let State {
            generation,
            exhausted,
            ..
        } = &mut *state;
        State::next(generation, exhausted);
    }
    pub fn connection_changed(&self) {
        self.negotiating();
        self.0.lock().unwrap().source = None;
    }
    pub fn bind(&self, source: ConnectionEpoch) -> u64 {
        self.connection_changed();
        let mut state = self.0.lock().unwrap();
        state.source = Some(source);
        state.session = state.generation;
        state.session
    }
    pub fn ended(&self, session: u64) {
        let mut state = self.0.lock().unwrap();
        if state.session == session {
            state.discard();
            state.source = None;
            let State {
                generation,
                exhausted,
                ..
            } = &mut *state;
            State::next(generation, exhausted);
        }
    }
    pub fn cancel(&self) {
        let mut state = self.0.lock().unwrap();
        state.discard();
        let State {
            request, exhausted, ..
        } = &mut *state;
        State::next(request, exhausted);
    }
    pub fn current(&self, ticket: Ticket) -> bool {
        self.0.lock().unwrap().matches(ticket)
    }
    fn begin(&self) -> Option<Ticket> {
        let mut state = self.0.lock().unwrap();
        state.discard();
        let State {
            request, exhausted, ..
        } = &mut *state;
        State::next(request, exhausted);
        let ticket = Ticket {
            generation: state.generation,
            request: state.request,
            connection: state.source.as_ref()?.current(),
        };
        state.matches(ticket).then_some(ticket)
    }
    pub fn connection_epoch(&self, ticket: Ticket) -> Option<u64> {
        self.current(ticket).then_some(ticket.connection)
    }
    pub fn store(&self, ticket: Ticket, mut snapshot: ManualVerification) -> bool {
        let mut state = self.0.lock().unwrap();
        if !state.matches(ticket) {
            snapshot.invalidate();
            return false;
        }
        state.discard();
        state.snapshot = Some((ticket, snapshot));
        true
    }
    pub fn take(&self, ticket: Ticket) -> Option<ManualVerification> {
        let mut state = self.0.lock().unwrap();
        if !state.matches(ticket) {
            return None;
        }
        match state.snapshot.take() {
            Some((stored, snapshot)) if stored == ticket => Some(snapshot),
            _ => None,
        }
    }
    pub fn prune(&self) {
        let mut state = self.0.lock().unwrap();
        if state
            .snapshot
            .as_ref()
            .is_some_and(|(ticket, _)| !state.matches(*ticket))
        {
            state.discard();
        }
    }
}

#[derive(Clone, Default, PartialEq)]
struct Display {
    open: bool,
    ticket: Option<Ticket>,
    material: String,
    pending: bool,
    confirming: bool,
    compared: bool,
    message: String,
}
impl Display {
    fn requested(ticket: Ticket) -> Self {
        Self {
            open: true,
            ticket: Some(ticket),
            pending: true,
            ..Self::default()
        }
    }
    fn accepts(&self, ticket: Ticket, live: bool) -> bool {
        self.open && self.ticket == Some(ticket) && live
    }
    fn apply(&mut self, notice: Notice, live: bool) {
        match notice {
            Notice::Material(ticket, material) if self.accepts(ticket, live) && self.pending => {
                self.material = material;
                self.pending = false;
            }
            Notice::Compared(ticket) if self.accepts(ticket, live) && self.confirming => {
                self.confirming = false;
                self.compared = true;
            }
            Notice::Failed(ticket, message) if self.accepts(ticket, live) => {
                self.pending = false;
                self.confirming = false;
                self.material.clear();
                self.compared = false;
                self.message = message;
            }
            _ => {}
        }
    }
    fn confirm(&mut self) -> Option<(Ticket, String)> {
        if self.pending || self.confirming || self.compared || self.material.is_empty() {
            return None;
        }
        let ticket = self.ticket?;
        self.confirming = true;
        Some((ticket, self.material.clone()))
    }
}

#[derive(Clone, Copy)]
pub struct VerificationUi {
    gate: Signal<Gate>,
    display: Signal<Display>,
}
impl VerificationUi {
    pub fn new(gate: Gate, connected: Signal<bool>, busy: Signal<bool>) -> Self {
        let this = Self {
            gate: signal(gate),
            display: signal(Display::default()),
        };
        // 包括高级 TURN 面板发起的新连接，无须依赖旧连接事件的到达顺序。
        effect(move || {
            if busy.get() || !connected.get() {
                this.cancel();
            }
        });
        // 即使事件泵阻塞在文件背压，仍清除回调计数已失效的显示。
        set_interval(std::time::Duration::from_millis(100), move || this.sync());
        this
    }
    pub fn cancel(self) {
        self.gate.get_untracked().cancel();
        self.display.set(Display::default());
    }
    pub fn sync(self) {
        let gate = self.gate.get_untracked();
        gate.prune();
        if self
            .display
            .get_untracked()
            .ticket
            .is_some_and(|ticket| !gate.current(ticket))
        {
            self.display.set(Display {
                open: true,
                message: "连接已变化，旧核对材料和人工断言已清除，请重新查看指纹。".into(),
                ..Display::default()
            });
        }
    }
    pub fn event(self, notice: Notice) {
        self.sync();
        let ticket = match &notice {
            Notice::Material(t, _) | Notice::Compared(t) | Notice::Failed(t, _) => *t,
        };
        let live = self.gate.get_untracked().current(ticket);
        self.display.update(|display| display.apply(notice, live));
    }
    fn request(self, sender: &Sender<Command>) {
        self.sync();
        if self.display.get_untracked().pending || self.display.get_untracked().confirming {
            return;
        }
        let Some(ticket) = self.gate.get_untracked().begin() else {
            self.display.set(Display {
                open: true,
                message: "请先与对方建立连接，再查看实际连接指纹。".into(),
                ..Display::default()
            });
            return;
        };
        self.display.set(Display::requested(ticket));
        if sender
            .try_send(Command::InspectVerification(ticket))
            .is_err()
        {
            self.event(Notice::Failed(
                ticket,
                "操作队列已满，请重新查看指纹。".into(),
            ));
        }
    }
    fn confirm(self, sender: &Sender<Command>) {
        self.sync();
        let mut request = None;
        self.display.update(|display| request = display.confirm());
        if let Some((ticket, displayed)) = request
            && sender
                .try_send(Command::ConfirmVerification(ticket, displayed))
                .is_err()
        {
            self.event(Notice::Failed(
                ticket,
                "确认未送达，请重新查看并核对完整材料。".into(),
            ));
        }
    }
    pub fn panel(self, sender: Sender<Command>, busy: Signal<bool>) -> impl IntoElement {
        let inspect = sender.clone();
        view().gap_2()
            .child(ui::action("查看连接指纹", move || busy.get() || self.display.get().pending || self.display.get().confirming,
                move || self.request(&inspect)))
            .child(view().gap_2().style_when(move || !self.display.get().open, |s| s.hidden())
                .child(text("人工连接核对：请通过既有可信渠道（例如当面）逐字对照双方完整材料。不要使用本次待核对聊天发送材料来自证身份。"))
                .child(text("这里只记录此次快照的人工断言，不是持续连接认证，也不代表企业身份、成员资格或角色。"))
                .child(text(move || self.display.get().material))
                .child(text(move || {
                    let display = self.display.get();
                    if display.pending { "正在读取当前实际连接…".into() }
                    else if display.confirming { "正在复核原显示材料与当前连接…".into() }
                    else if display.compared { "已记录：你声明通过可信渠道对照了此次快照的完整材料。".into() }
                    else { display.message }
                }).text_color(move || theme().muted_foreground))
                .child(ui::action("复制完整核对材料", move || self.display.get().material.is_empty(), move || {
                    self.sync();
                    let material = self.display.get_untracked().material;
                    if !material.is_empty() { set_clipboard(material); }
                }))
                .child(ui::action("已通过可信渠道对照完整材料", move || {
                    let display = self.display.get();
                    display.material.is_empty() || display.pending || display.confirming || display.compared
                }, move || self.confirm(&sender)))
                .child(ui::action("取消并清除核对", || false, move || self.cancel())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ticket(request: u64) -> Ticket {
        Ticket {
            generation: 1,
            request,
            connection: 2,
        }
    }
    #[test]
    fn cancelled_or_replaced_request_never_revives_from_queued_material() {
        let old = ticket(1);
        let mut display = Display::default();
        display.apply(Notice::Material(old, "old".into()), true);
        assert!(display.material.is_empty());
        display = Display::requested(ticket(2));
        display.apply(Notice::Material(old, "old".into()), true);
        assert!(display.material.is_empty());
        assert!(display.pending);
    }
    #[test]
    fn live_epoch_is_rechecked_on_material_and_confirmation_delivery() {
        let ticket = ticket(1);
        let mut display = Display::requested(ticket);
        display.apply(
            Notice::Material(ticket, "all three full hashes".into()),
            false,
        );
        assert!(display.material.is_empty());
        display.apply(
            Notice::Material(ticket, "all three full hashes".into()),
            true,
        );
        let (_, original) = display.confirm().unwrap();
        assert_eq!(original, "all three full hashes");
        display.apply(Notice::Compared(ticket), false);
        assert!(!display.compared);
    }
    #[test]
    fn repeated_buttons_and_unsolicited_confirmation_do_not_confirm() {
        let ticket = ticket(1);
        let mut display = Display::requested(ticket);
        assert!(display.confirm().is_none());
        display.apply(Notice::Compared(ticket), true);
        assert!(!display.compared);
        display.apply(Notice::Material(ticket, "complete original".into()), true);
        assert!(display.confirm().is_some());
        assert!(display.confirm().is_none());
        display.apply(Notice::Material(ticket, "replacement".into()), true);
        assert_eq!(display.material, "complete original");
        display.apply(Notice::Compared(ticket), true);
        assert!(display.compared);
        assert!(display.confirm().is_none());
    }
    #[test]
    fn request_counter_never_wraps_into_an_old_ticket() {
        let gate = Gate::default();
        gate.0.lock().unwrap().request = u64::MAX;
        gate.cancel();
        assert!(gate.0.lock().unwrap().exhausted);
        assert!(gate.begin().is_none());
    }
    #[tokio::test]
    async fn cancellation_renegotiation_and_replacement_revoke_real_observer_tickets() {
        use surreal_ck_peer_transport::{Route, chat::Chat};
        let (first, _events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
        let (second, _events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
        let gate = Gate::default();
        let first_session = gate.bind(first.connection_epoch_observer());
        let cancelled = gate.begin().unwrap();
        assert!(gate.current(cancelled));
        gate.cancel();
        assert!(!gate.current(cancelled));
        let before_await = gate.begin().unwrap();
        assert!(first.accept_answer_json("{}").await.is_err());
        assert!(!gate.current(before_await));
        // 不依赖 Event::State 或 output 队列消费。
        assert!(gate.connection_epoch(before_await).is_none());
        let renegotiated = gate.begin().unwrap();
        gate.negotiating();
        assert!(!gate.current(renegotiated));
        let first_ticket = gate.begin().unwrap();
        let second_session = gate.bind(second.connection_epoch_observer());
        let second_ticket = gate.begin().unwrap();
        assert!(!gate.current(first_ticket));
        // 旧 Peer 延迟到达的 Closed 不能撤销新 Peer。
        gate.ended(first_session);
        assert!(gate.current(second_ticket));
        gate.ended(second_session);
        assert!(!gate.current(second_ticket));
        assert!(gate.begin().is_none());
        first.close().await.unwrap();
        second.close().await.unwrap();
    }
    #[tokio::test]
    async fn backpressured_old_output_cannot_restore_material_after_connection_changes() {
        use surreal_ck_peer_transport::{Route, chat::Chat};
        let (chat, _events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
        let gate = Gate::default();
        gate.bind(chat.connection_epoch_observer());
        let ticket = gate.begin().unwrap();
        let mut display = Display::requested(ticket);
        let (output, updates) = async_channel::bounded(1);
        output
            .send(Notice::Material(ticket, "old material".into()))
            .await
            .unwrap();
        // 实际 Chat 入口先撤销，再等待；此时旧 Material 仍排在 output 里。
        chat.close().await.unwrap();
        display.apply(updates.recv().await.unwrap(), gate.current(ticket));
        assert!(display.material.is_empty());
        assert!(!display.compared);
    }
}
