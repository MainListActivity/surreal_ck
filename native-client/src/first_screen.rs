//! 产品壳层：消息、会议、通讯录与设置的信息架构与空状态文案。
//! 只放可单测的纯状态与文案，不产生假联系人、假会话、假在线人数或假会议。
//! 文案写给使用者看：说明现在能做什么、下一步去哪，不复述工程约束。

/// 产品用途说明，放在设置页的「关于」。
pub const PURPOSE: &str = "吉吉协同：团队消息、会议和屏幕共享";
/// 预览构建的完整说明，放在设置页。
pub const PREVIEW_LABEL: &str = "实验预览版 · 非正式发布，功能仍在验证，请勿用于正式工作";
pub const NO_CONVERSATION: &str = "选择一个会话开始聊天";
/// 消息只在内存中：用平实的话告诉使用者关闭应用后会清除。
pub const NO_CONVERSATION_HINT: &str = "聊天记录只保留到关闭应用为止。";
pub const EMPTY_MESSAGES: &str = "还没有消息，发一条打个招呼吧。";
pub const COMPOSER_PLACEHOLDER: &str = "输入消息，Enter 发送";
pub const SEND_LABEL: &str = "发送消息";
pub const SEARCH_PLACEHOLDER: &str = "搜索成员或消息";
pub const DIAGNOSTICS_TITLE: &str = "开发者诊断";
pub const DIAGNOSTICS_NOTICE: &str = "仅供开发与排障：手动 P2P 连接码、STUN/TURN、连接指纹、媒体与文件调试。这不是默认产品路径；连接码含网络地址，仅交给可信对方。";
pub const MEETING_START: &str = "立即开会";
pub const MEETING_JOIN: &str = "加入会议";
pub const NO_LIVE_MEETINGS: &str = "当前没有进行中的会议";
#[cfg(not(feature = "experimental-enterprise-meeting"))]
pub const NO_LIVE_MEETINGS_HINT: &str = "会话里有人发起会议时，会显示在这里。";

/// 当前构建是否为手动更新的实验预览（GitHub 预览渠道）。
pub const fn is_preview() -> bool {
    cfg!(feature = "github-manual-updates")
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Page {
    Messages,
    Meeting,
    Members,
    Settings,
    Diagnostics,
}

impl Page {
    pub fn shows_conversation_column(self) -> bool {
        self == Page::Messages
    }

    /// 除消息页外都是可滚动的内容页（会议首页、通讯录、设置、诊断）。
    pub fn uses_content_scroll(self) -> bool {
        self != Page::Messages
    }
}

/// 会话列表筛选：只过滤真实会话，不生成未读或群聊数据。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum ConversationFilter {
    #[default]
    All,
    Unread,
    Group,
}

impl ConversationFilter {
    pub fn label(self) -> &'static str {
        match self {
            ConversationFilter::All => "全部",
            ConversationFilter::Unread => "未读",
            ConversationFilter::Group => "群聊",
        }
    }
}

/// 企业身份面板对壳层公开的摘要；只来自真实身份状态机。
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct IdentitySummary {
    pub configured: bool,
    pub signed_in: bool,
    pub loading: bool,
    pub workspace: Option<String>,
    /// 当前工作区真实加载到的只读成员数；未进入工作区时为 0。
    pub members: usize,
}

impl IdentitySummary {
    /// 通讯录页标题下的一行：当前账号与工作区。
    pub fn workspace_line(&self) -> String {
        if !self.configured {
            return "企业登录暂不可用".into();
        }
        if self.loading {
            return "正在登录或切换工作区…".into();
        }
        match (self.signed_in, &self.workspace) {
            (false, _) => "未登录".into(),
            (true, None) => "已登录 · 尚未进入工作区".into(),
            (true, Some(name)) => format!("{name} · {} 位成员", self.members),
        }
    }

    /// 已配置但未登录、也不在加载中：可以引导去登录。
    pub fn can_sign_in(&self) -> bool {
        self.configured && !self.signed_in && !self.loading
    }
}

/// 会话通道的真实状态（来自传输事件，不推测网络质量）。
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
            Session::Offline => "未连接".into(),
            Session::Connecting => "正在连接…".into(),
            Session::Connected => "已连接".into(),
            Session::Failed(reason) => format!("连接失败：{reason}"),
        }
    }

    pub fn failed(&self) -> bool {
        matches!(self, Session::Failed(_))
    }
}

/// 真实直连会话在列表中的展示；没有未读计数，也不是群聊。
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Conversation {
    pub title: String,
    pub unread: bool,
    pub group: bool,
}

pub fn direct_conversation() -> Conversation {
    Conversation {
        title: "直连会话".into(),
        unread: false,
        group: false,
    }
}

/// 当前可见的真实会话；未连接时为空。筛选不会编造会话。
pub fn visible_conversations(
    connected: bool,
    query: &str,
    filter: ConversationFilter,
) -> Vec<Conversation> {
    if !connected {
        return Vec::new();
    }
    let conversation = direct_conversation();
    let query = query.trim();
    if !query.is_empty() && !conversation.title.contains(query) {
        return Vec::new();
    }
    match filter {
        ConversationFilter::All => vec![conversation],
        ConversationFilter::Unread if conversation.unread => vec![conversation],
        ConversationFilter::Group if conversation.group => vec![conversation],
        _ => Vec::new(),
    }
}

/// 会话列表为空时的标题与说明。已连接时按筛选说明，未连接时按身份状态说明下一步。
pub fn conversation_empty(
    identity: &IdentitySummary,
    connected: bool,
    filter: ConversationFilter,
    query: &str,
) -> (&'static str, &'static str) {
    if connected {
        if !query.trim().is_empty() {
            return ("没有匹配的会话", "换个关键词试试。");
        }
        return match filter {
            ConversationFilter::All => ("暂无会话", "新的会话会显示在这里。"),
            ConversationFilter::Unread => ("暂无未读消息", ""),
            ConversationFilter::Group => ("没有群聊", "加入的群聊会显示在这里。"),
        };
    }
    if !identity.configured {
        ("还没有团队会话", "企业登录暂不可用。")
    } else if identity.loading {
        ("正在加载会话…", "")
    } else if !identity.signed_in {
        ("还没有团队会话", "登录企业账号后，团队会话会显示在这里。")
    } else if identity.workspace.is_none() {
        ("还没有团队会话", "进入一个工作区后，团队会话会显示在这里。")
    } else {
        ("还没有团队会话", "有人给你发消息后，会话会显示在这里。")
    }
}

/// 通讯录页的标题与说明；不生成示例联系人或在线状态。
pub fn members_empty(identity: &IdentitySummary) -> (&'static str, String) {
    if !identity.configured {
        ("通讯录暂不可用", "此版本未接入企业登录。".into())
    } else if identity.loading {
        ("正在加载成员…", String::new())
    } else if !identity.signed_in {
        (
            "登录后查看通讯录",
            "登录企业账号后，可以看到工作区成员。".into(),
        )
    } else if identity.workspace.is_none() {
        ("选择一个工作区", "进入工作区后，可以看到它的成员。".into())
    } else if identity.members > 0 {
        ("工作区成员", format!("共 {} 位成员。", identity.members))
    } else {
        ("暂无成员", "这个工作区还没有可见成员。".into())
    }
}

/// 会议入口不可用的原因；会议能力接入前，入口保持禁用并说明下一步。
#[cfg(any(not(feature = "experimental-enterprise-meeting"), test))]
pub fn meeting_unavailable(identity: &IdentitySummary) -> &'static str {
    if !identity.configured {
        "企业会议暂不可用。"
    } else if !identity.signed_in {
        "登录企业账号后，可以从会话里发起会议。"
    } else if identity.workspace.is_none() {
        "进入一个工作区后，可以从会话里发起会议。"
    } else {
        "当前工作区暂无法发起会议。"
    }
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
    pub at: std::time::SystemTime,
}

pub const MESSAGE_LIMIT: usize = 1000;

impl Message {
    pub fn status(&self) -> Option<&'static str> {
        if !self.mine {
            return None;
        }
        Some(match self.delivery {
            Delivery::Sending => "发送中…",
            Delivery::Sent => "已送出",
            Delivery::Failed => "发送失败",
        })
    }

    pub fn continues(&self, previous: &Self) -> bool {
        self.mine == previous.mine
            && self
                .at
                .duration_since(previous.at)
                .is_ok_and(|elapsed| elapsed.as_secs() < 60)
    }

    pub fn time_label(&self) -> String {
        let minute = self
            .at
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            / 60;
        format!("{:02}:{:02} UTC", (minute / 60) % 24, minute % 60)
    }

    pub fn label(&self) -> String {
        if !self.mine {
            return format!("对方：{}", self.text);
        }
        format!("我（{}）：{}", self.status().unwrap_or(""), self.text)
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
            at: std::time::SystemTime::now(),
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
            at: std::time::SystemTime::now(),
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
                at: std::time::SystemTime::now(),
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

    fn signed_in(workspace: Option<&str>, members: usize) -> IdentitySummary {
        IdentitySummary {
            configured: true,
            signed_in: true,
            loading: false,
            workspace: workspace.map(str::to_owned),
            members,
        }
    }

    #[test]
    fn workspace_line_follows_each_identity_state() {
        let mut s = IdentitySummary::default();
        assert_eq!(s.workspace_line(), "企业登录暂不可用");
        assert!(!s.can_sign_in());
        s.configured = true;
        assert_eq!(s.workspace_line(), "未登录");
        assert!(s.can_sign_in());
        s.loading = true;
        assert!(s.workspace_line().contains("正在"));
        assert!(!s.can_sign_in());
        let s = signed_in(None, 0);
        assert_eq!(s.workspace_line(), "已登录 · 尚未进入工作区");
        let s = signed_in(Some("研发部"), 3);
        assert_eq!(s.workspace_line(), "研发部 · 3 位成员");
    }

    #[test]
    fn members_empty_matches_loaded_directory() {
        let (title, _) = members_empty(&IdentitySummary::default());
        assert_eq!(title, "通讯录暂不可用");
        let (title, body) = members_empty(&signed_in(Some("研发部"), 0));
        assert_eq!(title, "暂无成员");
        assert!(!body.is_empty());
        let (title, body) = members_empty(&signed_in(Some("研发部"), 2));
        assert_eq!(title, "工作区成员");
        assert!(body.contains("共 2 位成员"), "{body}");
        let (title, _) = members_empty(&signed_in(None, 0));
        assert_eq!(title, "选择一个工作区");
    }

    #[test]
    fn conversation_empty_guides_the_next_step_without_fake_contacts() {
        let all = ConversationFilter::All;
        let mut s = IdentitySummary::default();
        let (_, body) = conversation_empty(&s, false, all, "");
        assert!(body.contains("企业登录暂不可用"));
        s.configured = true;
        let (_, body) = conversation_empty(&s, false, all, "");
        assert!(body.contains("登录企业账号"));
        s.loading = true;
        assert_eq!(conversation_empty(&s, false, all, "").0, "正在加载会话…");
        let s = signed_in(None, 0);
        assert!(conversation_empty(&s, false, all, "").1.contains("工作区"));
        let s = signed_in(Some("w"), 0);
        let (title, _) = conversation_empty(&s, true, all, "找不到");
        assert_eq!(title, "没有匹配的会话");
        let unread = ConversationFilter::Unread;
        assert_eq!(conversation_empty(&s, true, unread, "").0, "暂无未读消息");
    }

    #[test]
    fn meeting_entry_explains_why_it_is_unavailable() {
        let mut s = IdentitySummary::default();
        assert!(meeting_unavailable(&s).contains("企业会议暂不可用"));
        s.configured = true;
        assert!(meeting_unavailable(&s).contains("登录企业账号"));
        assert!(meeting_unavailable(&signed_in(None, 0)).contains("工作区"));
        assert!(meeting_unavailable(&signed_in(Some("w"), 1)).contains("暂无法发起会议"));
    }

    #[test]
    fn messages_group_only_adjacent_same_sender_under_one_minute() {
        use std::time::{Duration, UNIX_EPOCH};
        let previous = Message {
            mine: true,
            text: "第一条".into(),
            delivery: Delivery::Sent,
            at: UNIX_EPOCH + Duration::from_secs(60),
        };
        let mut next = previous.clone();
        next.at += Duration::from_secs(59);
        assert!(next.continues(&previous));
        next.at += Duration::from_secs(1);
        assert!(!next.continues(&previous));
        next.at = previous.at;
        next.mine = false;
        assert!(!next.continues(&previous));
        assert!(!previous.continues(&Message {
            at: previous.at + Duration::from_secs(1),
            ..previous.clone()
        }));
    }

    #[test]
    fn visible_conversations_only_include_a_real_direct_session() {
        assert!(visible_conversations(false, "", ConversationFilter::All).is_empty());
        let all = visible_conversations(true, "", ConversationFilter::All);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].title, "直连会话");
        assert!(visible_conversations(true, "直连", ConversationFilter::All).len() == 1);
        assert!(visible_conversations(true, "没有这个", ConversationFilter::All).is_empty());
        assert!(visible_conversations(true, "", ConversationFilter::Unread).is_empty());
        assert!(visible_conversations(true, "", ConversationFilter::Group).is_empty());
    }

    #[test]
    fn session_lines_distinguish_offline_loading_and_failure() {
        assert_eq!(Session::Offline.line(), "未连接");
        assert_eq!(Session::Connecting.line(), "正在连接…");
        assert_eq!(Session::Failed("ice".into()).line(), "连接失败：ice");
        assert_eq!(Session::Connected.line(), "已连接");
        assert!(Session::Failed("ice".into()).failed());
        assert!(!Session::Offline.failed());
    }

    #[test]
    fn message_delivery_never_claims_receipt() {
        let mut m = Vec::new();
        pending(&mut m, "你好".into());
        assert_eq!(m[0].label(), "我（发送中…）：你好");
        queued(&mut m, "你好");
        assert_eq!(m[0].label(), "我（已送出）：你好");
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

    #[test]
    fn only_the_message_page_uses_the_conversation_column() {
        assert!(Page::Messages.shows_conversation_column());
        assert!(!Page::Messages.uses_content_scroll());
        for page in [
            Page::Meeting,
            Page::Members,
            Page::Settings,
            Page::Diagnostics,
        ] {
            assert!(!page.shows_conversation_column());
            assert!(page.uses_content_scroll());
        }
    }
}
