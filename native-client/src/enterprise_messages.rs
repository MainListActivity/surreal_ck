//! 数据库聊天的 UI 接缝。公开输入输出均为展示数据，不包含 Session 或 token。
pub use crate::first_screen::ConversationFilter;
use crate::ui;
use nsh_base::theme;
use nsh_core::prelude::*;
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use surreal_ck_native_identity::chat::{
    ChatClient, ChatError, ChatEvent, ChatMessage, ChatSnapshot, ChatStatus, Conversation,
    ConversationKind, MessageCursor,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Person {
    pub id: String,
    pub name: String,
    pub pending: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Delivery {
    Sending,
    Sent,
    Failed,
}
#[derive(Clone, Debug)]
pub struct Row {
    pub id: Option<String>,
    pub room: String,
    pub client_id: String,
    pub sender: String,
    pub body: String,
    pub time: String,
    pub delivery: Delivery,
}
impl From<ChatMessage> for Row {
    fn from(message: ChatMessage) -> Self {
        Self {
            id: Some(message.id),
            room: message.conversation,
            client_id: message.client_id,
            sender: message.sender,
            body: message.body,
            time: message.created_at,
            delivery: Delivery::Sent,
        }
    }
}
#[derive(Clone)]
pub struct Model {
    pub epoch: u64,
    pub member_id: String,
    pub rooms: Vec<Conversation>,
    pub people: Vec<Person>,
    pub active: Option<String>,
    pub rows: Vec<Row>,
    pub outbox: Vec<Row>,
    pub connected: bool,
    pub status: String,
    pub more: bool,
}
impl Default for Model {
    fn default() -> Self {
        Self {
            epoch: 0,
            member_id: String::new(),
            rooms: Vec::new(),
            people: Vec::new(),
            active: None,
            rows: Vec::new(),
            outbox: Vec::new(),
            connected: false,
            status: "未连接企业聊天".into(),
            more: true,
        }
    }
}
#[derive(Clone, Debug)]
pub enum Action {
    Open(String),
    Older(String, Option<MessageCursor>),
    Direct(String),
    Group(String, Vec<String>),
    Send {
        room: String,
        body: String,
        client_id: String,
    },
    Read(String),
    Focused(bool),
}
#[derive(Clone)]
pub enum Update {
    Snapshot(Arc<ChatSnapshot>),
    Status(ChatStatus),
    Opened(String),
    History(String, Vec<ChatMessage>, bool),
    Message(ChatMessage),
    Receipt(String, Result<ChatMessage, ChatError>),
    Error(String),
}
#[derive(Clone, Copy)]
pub struct Ui {
    pub state: Signal<Model>,
    pub draft: Signal<String>,
    pub query: Signal<String>,
    pub filter: Signal<ConversationFilter>,
    dialog: Signal<bool>,
    group: Signal<bool>,
    title: Signal<String>,
    selected: Signal<Vec<String>>,
    send: Signal<Arc<dyn Fn(Action) -> bool>>,
}
impl Ui {
    pub fn new(send: impl Fn(Action) -> bool + 'static) -> Self {
        Self::injected(Model::default(), send)
    }
    pub fn injected(model: Model, send: impl Fn(Action) -> bool + 'static) -> Self {
        Self {
            state: signal_with(model, SignalEquals::Never),
            draft: signal(String::new()),
            query: signal(String::new()),
            filter: signal(ConversationFilter::All),
            dialog: signal(false),
            group: signal(false),
            title: signal(String::new()),
            selected: signal(Vec::new()),
            send: signal_with(Arc::new(send), SignalEquals::Never),
        }
    }
    pub(super) fn identity(self, epoch: u64, signed_in: bool, people: Vec<Person>, status: String) {
        let mut state = self.state.get_untracked();
        if epoch != state.epoch || !signed_in {
            state = Model {
                epoch,
                status,
                ..Model::default()
            };
            self.draft.set(String::new());
            self.dialog.set(false);
            self.selected.set(Vec::new());
        }
        state.people = people;
        self.state.set(state);
    }
    pub fn dispatch(self, action: Action) {
        let failed = match &action {
            Action::Send { client_id, .. } => Some(client_id.clone()),
            _ => None,
        };
        if !(self.send.get_untracked())(action) {
            if let Some(client_id) = failed {
                self.apply(Update::Receipt(client_id, Err(ChatError::Stopped)));
            }
            self.state
                .update(|s| s.status = "聊天后台繁忙或已停止，请重试。".into());
        }
    }
    pub fn apply(self, update: Update) {
        self.state.update(|state| match update {
            Update::Snapshot(snapshot) => {
                state.rooms = snapshot.conversations.clone();
                state.member_id = snapshot.member_id.clone();
                if state
                    .active
                    .as_ref()
                    .is_some_and(|id| !state.rooms.iter().any(|r| &r.id == id))
                {
                    state.active = None;
                    state.rows.clear();
                }
            }
            Update::Status(status) => {
                state.connected = status == ChatStatus::Connected;
                if matches!(status, ChatStatus::Ended(_)) {
                    for row in state.outbox.iter_mut().chain(state.rows.iter_mut()) {
                        if row.delivery == Delivery::Sending {
                            row.delivery = Delivery::Failed;
                        }
                    }
                }
                state.status = match status {
                    ChatStatus::Connecting => "正在连接企业聊天…".into(),
                    ChatStatus::Connected => "企业聊天已连接".into(),
                    ChatStatus::Reconnecting => "连接中断，正在重连并同步消息…".into(),
                    ChatStatus::Ended(error) => error.to_string(),
                };
            }
            Update::Opened(room) => {
                state.active = Some(room);
                state.rows.clear();
                state.more = true;
                self.draft.set(String::new());
                self.dialog.set(false);
            }
            Update::History(room, messages, older) => {
                if state.active.as_deref() != Some(&room) {
                    return;
                }
                if older {
                    state.more = messages.len() == 50;
                }
                for message in messages {
                    merge(&mut state.rows, message.into());
                }
                for row in &state.outbox {
                    if row.room == room {
                        merge(&mut state.rows, row.clone());
                    }
                }
                state
                    .rows
                    .sort_by(|a, b| a.time.cmp(&b.time).then(a.id.cmp(&b.id)));
                if state.rows.len() > 1000 {
                    state.rows.truncate(1000);
                    state.more = false;
                    state.status = "已加载 1000 条；重新打开会话可回到最新消息。".into();
                }
            }
            Update::Message(message) => {
                if state.active.as_deref() == Some(&message.conversation) {
                    merge(&mut state.rows, message.into());
                    if state.rows.len() > 1000 {
                        state.rows.remove(0);
                    }
                }
            }
            Update::Receipt(client_id, result) => match result {
                Ok(message) => {
                    state.outbox.retain(|r| r.client_id != client_id);
                    if state.active.as_deref() == Some(&message.conversation) {
                        merge(&mut state.rows, message.into());
                        bound_rows(&mut state.rows);
                    }
                }
                Err(error) => {
                    state.status = error.to_string();
                    for row in state.outbox.iter_mut().chain(state.rows.iter_mut()) {
                        if row.client_id == client_id {
                            row.delivery = Delivery::Failed;
                        }
                    }
                }
            },
            Update::Error(error) => state.status = error,
        });
    }
    fn open(self, id: String) {
        self.apply(Update::Opened(id.clone()));
        self.dispatch(Action::Open(id));
    }
    fn submit(self) {
        let state = self.state.get_untracked();
        let body = self.draft.get_untracked();
        let Some(room) = state.active else {
            return;
        };
        if !state.connected
            || body.trim().is_empty()
            || body.chars().count() > 4000
            || state.outbox.len() >= 128
        {
            return;
        }
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|v| v.as_nanos())
            .unwrap_or_default();
        let client_id = format!(
            "native-{}-{now}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let row = Row {
            id: None,
            room: room.clone(),
            client_id: client_id.clone(),
            sender: state.member_id,
            body: body.clone(),
            time: "~".into(),
            delivery: Delivery::Sending,
        };
        self.state.update(|s| {
            s.outbox.push(row.clone());
            s.rows.push(row);
            bound_rows(&mut s.rows);
        });
        self.draft.set(String::new());
        self.dispatch(Action::Send {
            room,
            body,
            client_id,
        });
    }
    fn retry(self, client_id: &str) {
        let state = self.state.get_untracked();
        if !state.connected {
            return;
        }
        if let Some(row) = state
            .outbox
            .iter()
            .find(|r| r.client_id == client_id)
            .cloned()
        {
            self.state.update(|s| {
                for r in s.rows.iter_mut().chain(s.outbox.iter_mut()) {
                    if r.client_id == row.client_id {
                        r.delivery = Delivery::Sending;
                    }
                }
            });
            self.dispatch(Action::Send {
                room: row.room,
                body: row.body,
                client_id: row.client_id,
            });
        }
    }
    pub fn visible(self) -> Vec<Conversation> {
        let state = self.state.get();
        let query = self.query.get().trim().to_lowercase();
        let filter = self.filter.get();
        let mut rooms: Vec<_> = state
            .rooms
            .into_iter()
            .filter(|r| {
                title(r).to_lowercase().contains(&query)
                    && match filter {
                        ConversationFilter::All => true,
                        ConversationFilter::Unread => r.unread_count > 0,
                        ConversationFilter::Group => r.kind == ConversationKind::Group,
                    }
            })
            .collect();
        rooms.sort_by(|a, b| {
            b.last_message
                .as_ref()
                .map(|m| &m.created_at)
                .cmp(&a.last_message.as_ref().map(|m| &m.created_at))
                .then(a.id.cmp(&b.id))
        });
        rooms
    }
    pub fn list(self) -> impl IntoElement {
        view()
            .flex_1()
            .gap_3()
            .child(
                view()
                    .flex_row()
                    .items_center()
                    .child(
                        text("消息")
                            .test_id("conversation-heading")
                            .text_size(px(22.0))
                            .font_weight(FontWeight::BOLD)
                            .line_height(px(30.0))
                            .text_color(move || theme().foreground),
                    )
                    .child(view().flex_1())
                    .child(ui::action(
                        "新建",
                        move || !self.state.get().connected,
                        move || {
                            self.selected.set(Vec::new());
                            self.title.set(String::new());
                            self.dialog.set(true);
                        },
                    )),
            )
            .child(when(crate::first_screen::is_preview, || {
                ui::badge(crate::first_screen::PREVIEW_BADGE)
            }))
            .child(when(move || !self.state.get().connected, || text("未连接")))
            .child(ui::search_field(
                self.query,
                crate::first_screen::SEARCH_PLACEHOLDER,
            ))
            .child(
                ui::segment_track()
                    .child(ui::segment(
                        "全部",
                        move || self.filter.get() == ConversationFilter::All,
                        move || self.filter.set(ConversationFilter::All),
                    ))
                    .child(ui::segment(
                        "未读",
                        move || self.filter.get() == ConversationFilter::Unread,
                        move || self.filter.set(ConversationFilter::Unread),
                    ))
                    .child(ui::segment(
                        "群聊",
                        move || self.filter.get() == ConversationFilter::Group,
                        move || self.filter.set(ConversationFilter::Group),
                    )),
            )
            .child(text(move || self.state.get().status).text_size(px(12.0)))
            .child(when(
                move || self.visible().is_empty(),
                move || {
                    ui::empty_state(
                        ui::icons::Icon::Chat,
                        move || {
                            if self.state.get().rooms.is_empty() {
                                "还没有团队会话".into()
                            } else {
                                "没有匹配的会话".into()
                            }
                        },
                        move || {
                            if self.state.get().rooms.is_empty() {
                                "登录并选择工作区，或新建一个对话。".into()
                            } else {
                                "调整搜索内容或会话筛选。".into()
                            }
                        },
                    )
                },
            ))
            .child(
                virtual_list(
                    move || self.visible().len(),
                    move |at| {
                        nsh_base::button()
                            .accessibility_label(move || {
                                self.visible().get(at.index()).map(|r| {
                                    format!(
                                        "{}{}",
                                        name(r),
                                        if r.unread_count > 0 {
                                            format!(" · {} 未读", r.unread_count)
                                        } else {
                                            String::new()
                                        }
                                    )
                                    .into()
                                })
                            })
                            .on_press(move || {
                                if let Some(room) = self.visible().get(at.index()) {
                                    self.open(room.id.clone());
                                }
                            })
                            .p_3()
                            .rounded(px(10.0))
                            .bg(move || {
                                if self.visible().get(at.index()).is_some_and(|r| {
                                    Some(&r.id) == self.state.get().active.as_ref()
                                }) {
                                    theme().accent
                                } else {
                                    theme().card
                                }
                            })
                            .child(
                                view()
                                    .gap_1()
                                    .child(
                                        view()
                                            .flex_row()
                                            .items_center()
                                            .gap_2()
                                            .child(
                                                text(move || {
                                                    self.visible()
                                                        .get(at.index())
                                                        .map(name)
                                                        .unwrap_or_default()
                                                })
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .flex_1()
                                                .truncate(),
                                            )
                                            .child(when(
                                                move || {
                                                    self.visible()
                                                        .get(at.index())
                                                        .is_some_and(|r| r.unread_count > 0)
                                                },
                                                move || {
                                                    text(move || {
                                                        self.visible()
                                                            .get(at.index())
                                                            .map(|r| r.unread_count.to_string())
                                                            .unwrap_or_default()
                                                    })
                                                    .text_size(px(11.0))
                                                    .px_2()
                                                    .py_1()
                                                    .rounded(px(12.0))
                                                    .bg(move || theme().primary)
                                                    .text_color(move || theme().primary_foreground)
                                                },
                                            )),
                                    )
                                    .child(
                                        view()
                                            .flex_row()
                                            .items_center()
                                            .gap_2()
                                            .child(
                                                text(move || {
                                                    self.visible()
                                                        .get(at.index())
                                                        .and_then(|r| {
                                                            r.last_message
                                                                .as_ref()
                                                                .map(|m| m.body.clone())
                                                        })
                                                        .unwrap_or_else(|| "暂无消息".into())
                                                })
                                                .flex_1()
                                                .truncate()
                                                .text_size(px(12.0))
                                                .text_color(move || theme().muted_foreground)
                                                .label(move || {
                                                    self.visible()
                                                        .get(at.index())
                                                        .and_then(|r| {
                                                            r.last_message.as_ref().map(|m| {
                                                                format!(
                                                                    "{} · {}",
                                                                    m.body,
                                                                    clock(&m.created_at)
                                                                )
                                                            })
                                                        })
                                                        .unwrap_or_else(|| "暂无消息".into())
                                                }),
                                            )
                                            .child(
                                                text(move || {
                                                    self.visible()
                                                        .get(at.index())
                                                        .and_then(|r| {
                                                            r.last_message
                                                                .as_ref()
                                                                .map(|m| clock(&m.created_at))
                                                        })
                                                        .unwrap_or_default()
                                                })
                                                .text_size(px(11.0))
                                                .text_color(move || theme().muted_foreground),
                                            ),
                                    ),
                            )
                    },
                )
                .keys(move || self.visible().into_iter().map(|r| r.id).collect::<Vec<_>>())
                .estimated_item_size(px(76.0))
                .flex_1(),
            )
    }
    pub fn conversation(self) -> impl IntoElement {
        let width = signal(600.0_f32);
        view()
            .flex_1()
            .gap_2()
            .on_layout(move |bounds: &Bounds<Points>| {
                if width.get_untracked() != bounds.size.width.0 {
                    width.set(bounds.size.width.0);
                }
            })
            .child(
                text(move || self.state.get().status)
                    .px_4()
                    .py_2()
                    .text_size(px(12.0))
                    .text_color(move || theme().muted_foreground),
            )
            .child(when(
                move || self.state.get().active.is_none(),
                move || {
                    ui::empty_state(
                        ui::icons::Icon::Chat,
                        || crate::first_screen::NO_CONVERSATION.into(),
                        || "企业消息保存在工作区，选择会话后加载历史记录。".into(),
                    )
                    .flex_1()
                },
            ))
            .child(when(
                move || self.state.get().active.is_some(),
                move || {
                    view()
                        .flex_1()
                        .gap_2()
                        .px_4()
                        .child(
                            text(move || {
                                let s = self.state.get();
                                s.rooms
                                    .iter()
                                    .find(|r| Some(&r.id) == s.active.as_ref())
                                    .map(name)
                                    .unwrap_or_else(|| "正在打开会话…".into())
                            })
                            .font_weight(FontWeight::BOLD)
                            .text_size(px(18.0)),
                        )
                        .child(ui::secondary(
                            "加载更早的消息",
                            move || !self.state.get().connected || !self.state.get().more,
                            move || {
                                let s = self.state.get_untracked();
                                if let Some(room) = s.active {
                                    let before = s.rows.iter().find(|r| r.id.is_some()).map(|r| {
                                        MessageCursor {
                                            id: r.id.clone().unwrap(),
                                            created_at: r.time.clone(),
                                        }
                                    });
                                    self.dispatch(Action::Older(room, before));
                                }
                            },
                        ))
                        .child(
                            virtual_list(
                                move || self.state.get().rows.len(),
                                move |at| {
                                    let mine = move || {
                                        let s = self.state.get();
                                        s.rows
                                            .get(at.index())
                                            .is_some_and(|r| r.sender == s.member_id)
                                    };
                                    view()
                                        .gap_1()
                                        .py_2()
                                        .items_start()
                                        .style_when(mine, |s| s.items_end())
                                        .child(
                                            text(move || {
                                                let s = self.state.get();
                                                s.rows
                                                    .get(at.index())
                                                    .map(|r| {
                                                        if r.sender == s.member_id {
                                                            "我".into()
                                                        } else {
                                                            s.people
                                                                .iter()
                                                                .find(|p| p.id == r.sender)
                                                                .map(|p| p.name.clone())
                                                                .unwrap_or_else(|| r.sender.clone())
                                                        }
                                                    })
                                                    .unwrap_or_default()
                                            })
                                            .text_size(px(12.0))
                                            .text_color(move || theme().muted_foreground),
                                        )
                                        .child(
                                            view()
                                                .max_w(move || {
                                                    px(((width.get() - 32.0) * 0.85).max(80.0))
                                                })
                                                .px_3()
                                                .py_2()
                                                .rounded(px(12.0))
                                                .border_1()
                                                .border_color(move || theme().border)
                                                .bg(move || crate::bubble_fill(mine()))
                                                .child(text(move || {
                                                    self.state
                                                        .get()
                                                        .rows
                                                        .get(at.index())
                                                        .map(|r| r.body.clone())
                                                        .unwrap_or_default()
                                                })),
                                        )
                                        .child(
                                            text(move || {
                                                self.state
                                                    .get()
                                                    .rows
                                                    .get(at.index())
                                                    .map(|r| {
                                                        format!(
                                                            "{} {}",
                                                            clock(&r.time),
                                                            if mine() {
                                                                match r.delivery {
                                                                    Delivery::Sending => "发送中…",
                                                                    Delivery::Sent => "已送出",
                                                                    Delivery::Failed => {
                                                                        "发送失败，可重发"
                                                                    }
                                                                }
                                                            } else {
                                                                ""
                                                            }
                                                        )
                                                    })
                                                    .unwrap_or_default()
                                            })
                                            .text_size(px(11.0))
                                            .text_color(move || {
                                                if self
                                                    .state
                                                    .get()
                                                    .rows
                                                    .get(at.index())
                                                    .is_some_and(|r| r.delivery == Delivery::Failed)
                                                {
                                                    theme().destructive
                                                } else {
                                                    theme().muted_foreground
                                                }
                                            }),
                                        )
                                        .child(when(
                                            move || {
                                                self.state
                                                    .get()
                                                    .rows
                                                    .get(at.index())
                                                    .is_some_and(|r| r.delivery == Delivery::Failed)
                                            },
                                            move || {
                                                view().self_end().child(ui::secondary(
                                                    "重发",
                                                    move || !self.state.get().connected,
                                                    move || {
                                                        if let Some(row) = self
                                                            .state
                                                            .get_untracked()
                                                            .rows
                                                            .get(at.index())
                                                        {
                                                            self.retry(&row.client_id);
                                                        }
                                                    },
                                                ))
                                            },
                                        ))
                                },
                            )
                            .keys(move || {
                                self.state
                                    .get()
                                    .rows
                                    .into_iter()
                                    .map(|r| (r.room, r.sender, r.client_id))
                                    .collect::<Vec<_>>()
                            })
                            .estimated_item_size(px(100.0))
                            .flex_1(),
                        )
                        .child(
                            view()
                                .flex_row()
                                .gap_2()
                                .pb(px(12.0))
                                .child(ui::composer(
                                    self.draft,
                                    crate::first_screen::COMPOSER_PLACEHOLDER,
                                    move || self.submit(),
                                ))
                                .child(ui::send_control(
                                    "发送消息",
                                    move || {
                                        !self.state.get().connected
                                            || self.draft.get().trim().is_empty()
                                            || self.draft.get().chars().count() > 4000
                                            || self.state.get().outbox.len() >= 128
                                    },
                                    move || self.submit(),
                                )),
                        )
                },
            ))
            .child(when(
                move || self.state.get().active.is_none(),
                move || {
                    view()
                        .flex_row()
                        .gap_2()
                        .px_4()
                        .pb(px(12.0))
                        .child(ui::composer(
                            self.draft,
                            crate::first_screen::COMPOSER_PLACEHOLDER,
                            move || self.submit(),
                        ))
                        .child(ui::send_control("发送消息", || true, || {}))
                },
            ))
            .child(self.new_dialog())
    }
    fn new_dialog(self) -> impl IntoElement {
        when(
            move || self.dialog.get(),
            move || {
                nsh_base::dialog()
                    .on_cancel(move || self.dialog.set(false))
                    .child(
                        view()
                            .test_id("new-conversation-dialog")
                            .flex_1()
                            .p_4()
                            .items_center()
                            .justify_center()
                            .bg(rgba(0x00000066))
                            .child(
                                scroll()
                                    .w_full()
                                    .max_w(px(480.0))
                                    .max_h(move || window().height - px(64.0))
                                    .child(
                                        view()
                                            .gap_2()
                                            .p_4()
                                            .rounded(px(12.0))
                                            .border_1()
                                            .border_color(move || theme().border)
                                            .bg(move || theme().card)
                                            .child(
                                                text("新建对话")
                                                    .font_weight(FontWeight::SEMIBOLD)
                                                    .text_size(px(20.0)),
                                            )
                                            .child(
                                                view()
                                                    .flex_row()
                                                    .gap_2()
                                                    .child(ui::secondary(
                                                        "私聊",
                                                        || false,
                                                        move || {
                                                            self.group.set(false);
                                                            self.selected.set(Vec::new());
                                                        },
                                                    ))
                                                    .child(ui::secondary(
                                                        "群聊模式",
                                                        || false,
                                                        move || {
                                                            self.group.set(true);
                                                            self.selected.set(Vec::new());
                                                        },
                                                    )),
                                            )
                                            .child(when(
                                                move || self.group.get(),
                                                move || {
                                                    view()
                                                        .h(px(44.0))
                                                        .child(ui::field(self.title, "群聊标题"))
                                                },
                                            ))
                                            .child(
                                                virtual_list(
                                                    move || self.state.get().people.len(),
                                                    move |at| {
                                                        nsh_base::button()
                                                            .disabled(move || {
                                                                self.state
                                                                    .get()
                                                                    .people
                                                                    .get(at.index())
                                                                    .is_none_or(|p| {
                                                                        p.pending
                                                                            || p.id
                                                                                == self
                                                                                    .state
                                                                                    .get()
                                                                                    .member_id
                                                                    })
                                                            })
                                                            .on_press(move || {
                                                                if let Some(person) = self
                                                                    .state
                                                                    .get_untracked()
                                                                    .people
                                                                    .get(at.index())
                                                                {
                                                                    self.selected.update(|s| {
                                                                        if s.contains(&person.id) {
                                                                            s.retain(|v| {
                                                                                v != &person.id
                                                                            });
                                                                        } else {
                                                                            if !self
                                                                                .group
                                                                                .get_untracked()
                                                                            {
                                                                                s.clear();
                                                                            }
                                                                            s.push(
                                                                                person.id.clone(),
                                                                            );
                                                                        }
                                                                    });
                                                                }
                                                            })
                                                            .py_2()
                                                            .child(text(move || {
                                                                self.state
                                                                    .get()
                                                                    .people
                                                                    .get(at.index())
                                                                    .map(|p| {
                                                                        format!(
                                                                            "{}{}",
                                                                            if self
                                                                                .selected
                                                                                .get()
                                                                                .contains(&p.id)
                                                                            {
                                                                                "✓ "
                                                                            } else {
                                                                                ""
                                                                            },
                                                                            p.name
                                                                        )
                                                                    })
                                                                    .unwrap_or_default()
                                                            }))
                                                    },
                                                )
                                                .estimated_item_size(px(42.0))
                                                .h(px(160.0)),
                                            )
                                            .child(
                                                view()
                                                    .flex_row()
                                                    .gap_2()
                                                    .child(ui::action(
                                                        "创建对话",
                                                        move || {
                                                            !self.state.get().connected
                                                                || self.selected.get().is_empty()
                                                                || self.selected.get().len() > 100
                                                                || (self.group.get()
                                                                    && (self
                                                                        .title
                                                                        .get()
                                                                        .trim()
                                                                        .is_empty()
                                                                        || self
                                                                            .title
                                                                            .get()
                                                                            .chars()
                                                                            .count()
                                                                            > 200))
                                                        },
                                                        move || {
                                                            let selected =
                                                                self.selected.get_untracked();
                                                            if self.group.get_untracked() {
                                                                self.dispatch(Action::Group(
                                                                    self.title.get_untracked(),
                                                                    selected,
                                                                ));
                                                            } else if let Some(peer) =
                                                                selected.first()
                                                            {
                                                                self.dispatch(Action::Direct(
                                                                    peer.clone(),
                                                                ));
                                                            }
                                                        },
                                                    ))
                                                    .child(ui::secondary(
                                                        "取消新建",
                                                        || false,
                                                        move || self.dialog.set(false),
                                                    )),
                                            ),
                                    ),
                            ),
                    )
            },
        )
    }
}
fn merge(rows: &mut Vec<Row>, row: Row) {
    if let Some(existing) = rows.iter_mut().find(|r| {
        (r.id.is_some() && r.id == row.id)
            || (r.sender == row.sender && r.client_id == row.client_id)
    }) {
        *existing = row;
    } else {
        rows.push(row);
    }
}
fn bound_rows(rows: &mut Vec<Row>) {
    if rows.len() > 1000 {
        rows.drain(..rows.len() - 1000);
    }
}
fn title(room: &Conversation) -> String {
    match room.kind {
        ConversationKind::Direct => room
            .peer
            .as_ref()
            .map(|p| p.display_name.clone())
            .unwrap_or_else(|| "私聊".into()),
        ConversationKind::Group => room.title.clone().unwrap_or_else(|| "群聊".into()),
    }
}
fn name(room: &Conversation) -> String {
    if room.kind == ConversationKind::Group {
        format!("{} · {} 人", title(room), room.member_count)
    } else {
        title(room)
    }
}
fn clock(value: &str) -> String {
    value.get(11..16).unwrap_or("").to_owned()
}

#[derive(Default)]
pub(super) struct Slot {
    commands: Option<async_channel::Sender<Action>>,
    stop: Option<tokio::sync::watch::Sender<bool>>,
    job: Option<tokio::task::JoinHandle<()>>,
}
impl Slot {
    pub fn dispatch(&self, action: Action) -> bool {
        self.commands
            .as_ref()
            .is_some_and(|s| s.try_send(action).is_ok())
    }
    pub async fn shutdown(&mut self) {
        self.commands.take();
        if let Some(stop) = self.stop.take() {
            stop.send_replace(true);
        }
        if let Some(mut job) = self.job.take()
            && tokio::time::timeout(Duration::from_secs(8), &mut job)
                .await
                .is_err()
        {
            job.abort();
            let _ = job.await;
        }
    }
    pub fn start(
        &mut self,
        epoch: u64,
        directory: &super::Directory,
        out: async_channel::Sender<(u64, super::Event)>,
    ) {
        let Some(slug) = directory.view.selected_slug.clone() else {
            let _ = out.try_send((
                epoch,
                super::Event::Messages(Update::Error(
                    "尚未进入工作区，请先选择可访问的工作区。".into(),
                )),
            ));
            return;
        };
        let Some(session) = directory.collaboration.clone() else {
            let _ = out.try_send((
                epoch,
                super::Event::Messages(Update::Error(
                    "需要有效的 participant 协作会话，请重新登录。".into(),
                )),
            ));
            return;
        };
        let (commands, rx) = async_channel::bounded(32);
        let (stop, mut stopping) = tokio::sync::watch::channel(false);
        self.commands = Some(commands);
        self.stop = Some(stop);
        self.job = Some(tokio::spawn(async move {
            let emit = |update| out.send((epoch, super::Event::Messages(update)));
            let Ok((identity, config)) = super::configured() else {
                return;
            };
            let _ = emit(Update::Status(ChatStatus::Connecting)).await;
            let result = tokio::select! {_=stopping.changed()=>return,result=ChatClient::connect(&identity,session,&config,&slug)=>result};
            let client = match result {
                Ok(client) => client,
                Err(error) => {
                    let _ = emit(Update::Status(ChatStatus::Ended(error))).await;
                    return;
                }
            };
            let mut events = client.subscribe();
            let mut statuses = client.status();
            let mut active: Option<String> = None;
            let mut focused = false;
            let _ = emit(Update::Snapshot(client.snapshot())).await;
            let status = *statuses.borrow_and_update();
            let _ = emit(Update::Status(status)).await;
            loop {
                tokio::select! {
                    _=stopping.changed()=>break,
                    changed=statuses.changed()=>{
                        if changed.is_err(){break;}
                        let status=*statuses.borrow_and_update();
                        let _=emit(Update::Status(status)).await;
                        if matches!(status,ChatStatus::Ended(_)){break;}
                    }
                    command=rx.recv()=> {
                        let Ok(action)=command else{break;};
                        let operation=async {
                            match action {
                                Action::Direct(peer)=>{let room=client.open_direct(&peer).await?;let _=emit(Update::Opened(room.clone())).await;active=Some(room.clone());let history=client.messages(&room,None,50).await?;client.mark_read(&room).await?;let _=emit(Update::History(room,history,true)).await;}
                                Action::Group(title,members)=>{let room=client.create_group(&title,&members).await?;let _=emit(Update::Opened(room.clone())).await;active=Some(room.clone());client.mark_read(&room).await?;let _=emit(Update::History(room,Vec::new(),true)).await;}
                                Action::Open(room)=>{active=Some(room.clone());let messages=client.messages(&room,None,50).await?;client.mark_read(&room).await?;let _=emit(Update::History(room,messages,true)).await;}
                                Action::Older(room,before)=>{let history=client.messages(&room,before,50).await?;let _=emit(Update::History(room,history,true)).await;}
                                Action::Read(room)=>{client.mark_read(&room).await?;}
                                Action::Focused(visible)=>{focused=visible;if visible && let Some(room)=&active {client.mark_read(room).await?;}}
                                Action::Send{room,body,client_id}=>{let result=client.send(&room,&body,&client_id).await;let _=emit(Update::Receipt(client_id,result)).await;}
                            }
                            let _=emit(Update::Snapshot(client.snapshot())).await;
                            Ok::<(),ChatError>(())
                        };
                        let result=tokio::select! {_=stopping.changed()=>break,result=operation=>result};
                        if let Err(error)=result {let _=emit(Update::Error(error.to_string())).await;}
                    }
                    event=events.recv()=>match event {
                        Ok(ChatEvent::Snapshot(snapshot))=>{let _=emit(Update::Snapshot(snapshot)).await;}
                        Ok(ChatEvent::Message(message))=>{let read=focused && active.as_deref()==Some(&message.conversation);let room=message.conversation.clone();let _=emit(Update::Message(message)).await;if read {let _=tokio::select!{_=stopping.changed()=>break,result=client.mark_read(&room)=>result};}}
                        Ok(ChatEvent::Reconnecting{..})=>{let _=emit(Update::Status(ChatStatus::Reconnecting)).await;}
                        Ok(ChatEvent::Ended(error))=>{let _=emit(Update::Status(ChatStatus::Ended(error))).await;break;}
                        Ok(ChatEvent::Membership{conversation,joined})=>{if !joined && active.as_deref()==Some(&conversation){active=None;}}
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>{let _=emit(Update::Snapshot(client.snapshot())).await;if let Some(room)=&active {match tokio::select!{_=stopping.changed()=>break,result=client.messages(room,None,50)=>result} {Ok(messages)=>{let _=emit(Update::Opened(room.clone())).await;let _=emit(Update::History(room.clone(),messages,true)).await;let _=emit(Update::Error("消息同步已恢复，已刷新最近 50 条消息。".into())).await;},Err(error)=>{let _=emit(Update::Error(error.to_string())).await;}}}}
                        Err(_)=>break,
                    }
                }
            }
            let _ = client.stop().await;
        }));
    }
}
