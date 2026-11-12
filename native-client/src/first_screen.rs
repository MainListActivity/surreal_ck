//! 首屏信息架构：产品主路径是企业身份 + 会话 + 消息；调试/安全工具在设置与开发者诊断。
//! 这里只放可单测的纯状态与文案，不产生假联系人、假会话或假成功。

/// 首屏主标题：说明产品用途。
pub const PURPOSE: &str = "吉吉协同：团队消息、会议和屏幕共享";
/// 预览构建在首屏明确标注实验性质。
pub const PREVIEW_LABEL: &str = "实验预览版 · 非正式发布，功能仍在验证，请勿用于正式工作";
/// 会议与屏幕共享尚未接入首屏企业会话：只显示说明文字，不渲染可用按钮。
pub const MEETING_NOT_CONNECTED: &str = "会议与屏幕共享：尚未接入企业会话，当前版本不提供入口。";
pub const EMPTY_MESSAGES: &str = "暂无消息。消息只保存在本次会话内存中。";
pub const DIAGNOSTICS_TITLE: &str = "开发者诊断";
pub const DIAGNOSTICS_NOTICE: &str = "仅供开发与排障：手动 P2P 连接码、STUN/TURN、连接指纹、媒体与文件调试。这不是默认产品路径；连接码含网络地址，仅交给可信对方。";

/// 当前构建是否为手动更新的实验预览（GitHub 预览渠道）。
pub const fn is_preview() -> bool {
    cfg!(feature = "github-manual-updates")
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Page {
    Messages,
    Settings,
    Diagnostics,
}

/// 企业身份面板对首屏公开的摘要；只来自真实身份状态机。
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct IdentitySummary {
    pub configured: bool,
    pub signed_in: bool,
    pub loading: bool,
    pub workspace: Option<String>,
}

impl IdentitySummary {
    pub fn line(&self) -> String {
        if !self.configured {
            return "企业身份：未配置（此构建未接入企业登录，不会模拟登录）".into();
        }
        if self.loading {
            return "企业身份：正在登录或切换工作区…".into();
        }
        match (self.signed_in, &self.workspace) {
            (false, _) => "企业身份：未登录".into(),
            (true, None) => "企业身份：已登录 · 尚未进入工作区".into(),
            (true, Some(name)) => format!("企业身份：已登录 · 工作区 {name}"),
        }
    }
}

/// 首屏会话通道的真实状态（来自传输事件，不推测网络质量）。
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Session {
    Offline,
    Connecting,
    Connected,
    Failed(String),
}

impl Session {
    pub fn line(&self) -> String {
        match self {
            Session::Offline => "离线：当前没有已连接的会话".into(),
            Session::Connecting => "正在连接…".into(),
            Session::Connected => "已连接".into(),
            Session::Failed(reason) => format!("连接失败：{reason}"),
        }
    }
}

/// 会话列表为空时的说明；有真实会话时返回 None。
pub fn conversation_placeholder(
    identity: &IdentitySummary,
    conversations: usize,
) -> Option<String> {
    if conversations > 0 {
        return None;
    }
    Some(
        if !identity.configured {
            "暂无团队会话：企业登录未配置。"
        } else if identity.loading {
            "正在加载会话…"
        } else if !identity.signed_in {
            "暂无团队会话：请先登录企业账号。"
        } else if identity.workspace.is_none() {
            "暂无团队会话：请先进入一个工作区。"
        } else {
            "暂无会话。不会生成示例联系人或聊天记录。"
        }
        .into(),
    )
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Delivery {
    /// 已提交给后台，尚未确认交给加密通道。
    Sending,
    /// 已交给加密数据通道；协议没有送达/已读回执，不宣称对方已收到。
    Sent,
    Failed,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Message {
    pub mine: bool,
    pub text: String,
    pub delivery: Delivery,
}

pub const MESSAGE_LIMIT: usize = 1000;

impl Message {
    pub fn label(&self) -> String {
        if !self.mine {
            return format!("对方：{}", self.text);
        }
        let state = match self.delivery {
            Delivery::Sending => "发送中…",
            Delivery::Sent => "已送出 · 无送达回执",
            Delivery::Failed => "发送失败，可重试",
        };
        format!("我（{state}）：{}", self.text)
    }
}

fn push(messages: &mut Vec<Message>, message: Message) {
    if messages.len() >= MESSAGE_LIMIT {
        messages.remove(0);
    }
    messages.push(message);
}

pub fn pending(messages: &mut Vec<Message>, text: String) {
    push(
        messages,
        Message {
            mine: true,
            text,
            delivery: Delivery::Sending,
        },
    );
}

pub fn received(messages: &mut Vec<Message>, text: String) {
    push(
        messages,
        Message {
            mine: false,
            text,
            delivery: Delivery::Sent,
        },
    );
}

/// 后台确认已交给通道：只更新对应的发送中消息。
pub fn queued(messages: &mut Vec<Message>, text: &str) {
    match messages
        .iter_mut()
        .rev()
        .find(|m| m.mine && m.delivery == Delivery::Sending && m.text == text)
    {
        Some(message) => message.delivery = Delivery::Sent,
        None => push(
            messages,
            Message {
                mine: true,
                text: text.into(),
                delivery: Delivery::Sent,
            },
        ),
    }
}

/// 通道报错：仍处于发送中的消息标为失败，绝不显示为已送出。
pub fn failed(messages: &mut [Message]) {
    for message in messages
        .iter_mut()
        .filter(|m| m.mine && m.delivery == Delivery::Sending)
    {
        message.delivery = Delivery::Failed;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_line_is_honest_for_each_state() {
        let mut s = IdentitySummary::default();
        assert!(s.line().contains("未配置"));
        s.configured = true;
        assert_eq!(s.line(), "企业身份：未登录");
        s.loading = true;
        assert!(s.line().contains("正在"));
        s.loading = false;
        s.signed_in = true;
        assert!(s.line().contains("尚未进入工作区"));
        s.workspace = Some("研发部".into());
        assert_eq!(s.line(), "企业身份：已登录 · 工作区 研发部");
    }

    #[test]
    fn conversation_placeholder_never_fakes_contacts() {
        let mut s = IdentitySummary::default();
        assert!(conversation_placeholder(&s, 0).unwrap().contains("未配置"));
        s.configured = true;
        assert!(
            conversation_placeholder(&s, 0)
                .unwrap()
                .contains("请先登录")
        );
        s.loading = true;
        assert!(
            conversation_placeholder(&s, 0)
                .unwrap()
                .contains("正在加载")
        );
        s.loading = false;
        s.signed_in = true;
        assert!(
            conversation_placeholder(&s, 0)
                .unwrap()
                .contains("进入一个工作区")
        );
        s.workspace = Some("w".into());
        assert!(
            conversation_placeholder(&s, 0)
                .unwrap()
                .contains("不会生成示例联系人")
        );
        assert_eq!(conversation_placeholder(&s, 1), None);
    }

    #[test]
    fn session_lines_distinguish_offline_loading_and_failure() {
        assert!(Session::Offline.line().starts_with("离线"));
        assert_eq!(Session::Connecting.line(), "正在连接…");
        assert_eq!(Session::Failed("ice".into()).line(), "连接失败：ice");
        assert_eq!(Session::Connected.line(), "已连接");
    }

    #[test]
    fn message_delivery_never_claims_receipt() {
        let mut m = Vec::new();
        pending(&mut m, "你好".into());
        assert_eq!(m[0].label(), "我（发送中…）：你好");
        queued(&mut m, "你好");
        assert_eq!(m[0].label(), "我（已送出 · 无送达回执）：你好");
        assert!(!m[0].label().contains("已读"));
        assert!(!m[0].label().contains("已送达"));
        pending(&mut m, "第二条".into());
        failed(&mut m);
        assert_eq!(m[1].delivery, Delivery::Failed);
        assert_eq!(
            m[0].delivery,
            Delivery::Sent,
            "已送出的消息不受后续错误影响"
        );
        received(&mut m, "收到".into());
        assert_eq!(m[2].label(), "对方：收到");
    }

    #[test]
    fn message_history_is_bounded() {
        let mut m = Vec::new();
        for i in 0..(MESSAGE_LIMIT + 5) {
            received(&mut m, i.to_string());
        }
        assert_eq!(m.len(), MESSAGE_LIMIT);
        assert_eq!(m[0].text, "5");
    }

    #[test]
    fn preview_flag_follows_manual_update_channel() {
        assert_eq!(is_preview(), cfg!(feature = "github-manual-updates"));
    }
}
