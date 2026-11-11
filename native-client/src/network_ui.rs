//! 服务均由用户明确填写。只有直连失败，才显示可用的手动中继重试操作。
use crate::{bridge::Command, network_config::ConnectionSettings, ui};
use async_channel::Sender;
use nsh_base::{input, theme};
use nsh_core::prelude::*;

#[derive(Clone, Copy)]
pub struct NetworkUi {
    stun: Signal<String>,
    turn: Signal<String>,
    username: Signal<String>,
    credential: Signal<String>,
    can_relay: Signal<bool>,
}
impl NetworkUi {
    pub fn new() -> Self {
        Self {
            stun: signal(String::new()),
            turn: signal(String::new()),
            username: signal(String::new()),
            credential: signal(String::new()),
            can_relay: signal(false),
        }
    }
    pub fn direct_settings(self) -> Result<ConnectionSettings, String> {
        ConnectionSettings::direct(&self.stun.get_untracked())
    }
    pub fn direct_failed(self) {
        self.can_relay.set(true);
    }
    /// 在用户发起新一轮直连或主动断开时调用；不把旧会话失败当作新会话授权。
    pub fn reset(self) {
        self.can_relay.set(false);
    }
    pub fn panel(
        self,
        sender: Sender<Command>,
        remote: Signal<String>,
        local: Signal<String>,
        connected: Signal<bool>,
        busy: Signal<bool>,
        status: Signal<String>,
    ) -> impl IntoElement {
        let offer_sender = sender.clone();
        view().gap_2()
            .child(text("高级连接设置：P2P 优先，TURN 仅手动备选"))
            .child(text("默认不联系第三方，只使用本地网络候选。可选 STUN 仅帮助发现公网地址，不承载媒体或文件；留空可用于局域网。本版本不支持 stuns:，不会自动降级。"))
            .child(ui::field(self.stun, "可选 stun:你选择的主机:3478（多个地址用空格分隔）"))
            .child(text("明确接受可信对端的连接码时，可能联系对端配置的中继；无需双方都有 TURN 账户。对端提供中继候选不代表已经选择该路径，界面会标明路径待核验。"))
            .child(text("STUN / TURN 服务可见你的网络地址。TURN 将承载加密媒体和文件，可能计费；请选择可信且获准使用的服务。不会通过 surreal_ck 转发这些流量。凭据仅留在内存，不保存。"))
            .child(ui::field(self.turn, "备选 turn:你选择的主机:3478 或 turns:主机:5349"))
            .child(ui::field(self.username, "TURN 用户名"))
            .child(input().masked(true)
                .value(move || self.credential.get())
                .on_change(move |value: &str| self.credential.set(value.to_owned()))
                .placeholder("TURN 密码（仅内存）")
                .px_3().py_3().border_1()
                .border_color(move || theme().input)
                .text_color(move || theme().foreground))
            .child(text(move || if self.can_relay.get() {
                "直连已失败。双方需重新交换完整连接码：一方创建中继邀请，另一方接受新邀请并返回新应答；旧连接码不可复用。"
            } else { "先尝试直连。只有确认直连失败后，才能明确选择下面的中继重试。" }))
            .child(view().flex_row().gap_2()
                .child(ui::action("改用 TURN 中继创建新邀请", move || busy.get() || !self.can_relay.get(), move || {
                    self.retry(&offer_sender, None, local, connected, busy, status);
                }))
                .child(ui::action("改用 TURN 中继接受新邀请", move || busy.get() || !self.can_relay.get() || remote.get().trim().is_empty(), move || {
                    self.retry(&sender, Some(remote.get_untracked()), local, connected, busy, status);
                })))
    }
    fn retry(
        self,
        sender: &Sender<Command>,
        answer: Option<String>,
        local: Signal<String>,
        connected: Signal<bool>,
        busy: Signal<bool>,
        status: Signal<String>,
    ) {
        if busy.get_untracked() || !self.can_relay.get_untracked() {
            return;
        }
        let settings = match ConnectionSettings::relay(
            &self.turn.get_untracked(),
            &self.username.get_untracked(),
            &self.credential.get_untracked(),
        ) {
            Ok(settings) => settings,
            Err(error) => {
                status.set(error);
                return;
            }
        };
        let command = match answer {
            Some(code) => Command::Answer(code, settings),
            None => Command::Offer(settings),
        };
        if sender.try_send(command).is_err() {
            status.set("操作繁忙，请重试".into());
            return;
        }
        self.credential.set(String::new());
        busy.set(true);
        connected.set(false);
        local.set(String::new());
        status.set("正在新建 TURN 中继会话，需重新交换连接码…".into());
    }
}
