//! 产品壳层：消息、会议、成员与设置的信息架构与诚实空状态。
//! 只放可单测的纯状态与文案，不产生假联系人、假会话、假在线人数或假会议。

/// 窗口标题与产品壳层名称；Linux 使用系统窗口装饰，不绘制伪造的交通灯。
pub const APP_TITLE: &str = "吉吉 · 团队协同";
/// 产品用途说明，不作为首屏主标题。
pub const PURPOSE: &str = "吉吉协同：团队消息、会议和屏幕共享";
/// 预览构建的紧凑徽标，避免大块横幅占满首屏。
pub const PREVIEW_BADGE: &str = "实验预览版";
/// 预览构建的完整说明，放在设置页。
pub const PREVIEW_LABEL: &str = "实验预览版 · 非正式发布，功能仍在验证，请勿用于正式工作";
/// 会议舞台空状态：尚未接入，不假装正在开会。
pub const MEETING_EMPTY_STAGE: &str = "尚未接入企业会话，无法开始真实会议";
/// 会议坞控件禁用原因（麦克风、摄像头、离开等）。
pub const MEETING_CONTROLS_DISABLED: &str = "尚未加入会议，麦克风、摄像头和离开不可用。";
/// 未加入会议时「离开会议」不可用，用此控件回到消息页，避免困在会议舞台。
pub const MEETING_BACK: &str = "返回消息";
/// 共享选择器在没有真实捕获源时的空状态。
pub const SHARE_EMPTY: &str = "尚未接入捕获";
/// 开始共享在没有真实源或没有进行中的会议时的原因。
pub const SHARE_START_DISABLED: &str = "尚未接入企业会话，无法开始共享";
/// 共享整个屏幕的风险提示。
pub const SHARE_SCREEN_WARNING: &str = "共享整个屏幕时，通知和其他窗口可能被看到。";
/// 打开共享选择器的补充说明：只预览界面，不会开始共享。
pub const SHARE_PICKER_REVIEW: &str = "仅供查看共享选择界面，不会开始共享。";
pub const EMPTY_MESSAGES: &str = "暂无消息。消息只保存在本次会话内存中。";
pub const NO_CONVERSATION: &str = "尚未选择会话。";
pub const COMPOSER_PLACEHOLDER: &str = "输入消息，Enter 发送";
pub const SEND_LABEL: &str = "发送消息";
pub const SEARCH_PLACEHOLDER: &str = "搜索成员或消息";
pub const DIAGNOSTICS_TITLE: &str = "开发者诊断";
pub const DIAGNOSTICS_NOTICE: &str = "仅供开发与排障：手动 P2P 连接码、STUN/TURN、连接指纹、媒体与文件调试。这不是默认产品路径；连接码含网络地址，仅交给可信对方。";
pub const LOGIN_HONEST: &str = "此构建未接入企业登录，不会模拟登录";

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

    pub fn uses_content_scroll(self) -> bool {
        matches!(self, Page::Members | Page::Settings | Page::Diagnostics)
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

/// 共享选择器的目标类型；默认只选窗口。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum ShareKind {
    #[default]
    Window,
    Display,
}

impl ShareKind {
    pub fn label(self) -> &'static str {
        match self {
            ShareKind::Window => "窗口",
            ShareKind::Display => "整个屏幕",
        }
    }
}

/// 共享选择器的纯状态：没有真实源时不能开始共享。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct SharePicker {
    pub open: bool,
    pub kind: ShareKind,
}

impl SharePicker {
    pub fn open_for_review() -> Self {
        Self {
            open: true,
            kind: ShareKind::Window,
        }
    }

    pub fn close(self) -> Self {
        Self {
            open: false,
            kind: self.kind,
        }
    }

    /// 必须同时有进行中的会议和已选择的真实源，才能开始共享。
    pub fn can_start(self, live_meeting: bool, has_real_source: bool) -> bool {
        self.open && live_meeting && has_real_source
    }

    pub fn start_reason(self, live_meeting: bool, has_real_source: bool) -> Option<&'static str> {
        if self.can_start(live_meeting, has_real_source) {
            None
        } else {
            Some(SHARE_START_DISABLED)
        }
    }

    pub fn empty_copy(self) -> &'static str {
        SHARE_EMPTY
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
    pub fn line(&self) -> String {
        if !self.configured {
            return format!("企业身份：未配置（{LOGIN_HONEST}）");
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
            Session::Offline => "离线：当前没有已连接的会话".into(),
            Session::Connecting => "正在连接…".into(),
            Session::Connected => "已连接".into(),
            Session::Failed(reason) => format!("连接失败：{reason}"),
        }
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

/// 会话列表为空时的说明；有真实可见会话时返回 None。
pub fn conversation_placeholder(
    identity: &IdentitySummary,
    conversations: usize,
) -> Option<String> {
    if conversations > 0 {
        return None;
    }
    Some(if !identity.configured {
        format!("暂无团队会话：企业登录未配置。{LOGIN_HONEST}。")
    } else if identity.loading {
        "正在加载会话…".into()
    } else if !identity.signed_in {
        "暂无团队会话：请先登录企业账号。".into()
    } else if identity.workspace.is_none() {
        "暂无团队会话：请先进入一个工作区。".into()
    } else {
        "暂无会话。不会生成示例联系人或聊天记录。".into()
    })
}

/// 成员页空状态；不生成示例联系人。
pub fn members_placeholder(identity: &IdentitySummary) -> String {
    if !identity.configured {
        format!("暂无成员：企业登录未配置。{LOGIN_HONEST}。")
    } else if identity.loading {
        "正在加载成员…".into()
    } else if !identity.signed_in {
        "暂无成员：请先登录企业账号。".into()
    } else if identity.workspace.is_none() {
        "暂无成员：请先进入一个工作区。".into()
    } else if identity.members > 0 {
        format!(
            "已加载 {} 名工作区成员（只读）。不显示在线状态；聊天、会议与共享需要企业会话。",
            identity.members
        )
    } else {
        "暂无成员。不会生成示例联系人或在线状态。".into()
    }
}

/// 筛选后没有可见会话，但并非完全没有会话来源时的说明。
pub fn filter_empty_placeholder(filter: ConversationFilter, query: &str) -> String {
    if !query.trim().is_empty() {
        "没有符合搜索的会话。".into()
    } else {
        match filter {
            ConversationFilter::All => "暂无会话。不会生成示例联系人或聊天记录。".into(),
            ConversationFilter::Unread => "没有未读会话。".into(),
            ConversationFilter::Group => "没有群聊会话。".into(),
        }
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
}

pub const MESSAGE_LIMIT: usize = 1000;

impl Message {
    pub fn status(&self) -> Option<&'static str> {
        if !self.mine {
            return None;
        }
        Some(match self.delivery {
            Delivery::Sending => "发送中…",
            Delivery::Sent => "已送出 · 无送达回执",
            Delivery::Failed => "发送失败，可重试",
        })
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
        assert!(s.line().contains(LOGIN_HONEST));
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
    fn members_placeholder_matches_loaded_directory() {
        let mut s = IdentitySummary {
            configured: true,
            signed_in: true,
            workspace: Some("研发部".into()),
            ..IdentitySummary::default()
        };
        assert!(members_placeholder(&s).starts_with("暂无成员。"));
        s.members = 1;
        let loaded = members_placeholder(&s);
        assert!(!loaded.contains("暂无成员"), "{loaded}");
        assert!(loaded.contains("1 名工作区成员"));
        assert!(loaded.contains("不显示在线状态"));
        s.workspace = None;
        assert!(members_placeholder(&s).contains("请先进入一个工作区"));
    }

    #[test]
    fn conversation_placeholder_never_fakes_contacts() {
        let mut s = IdentitySummary::default();
        let empty = conversation_placeholder(&s, 0).unwrap();
        assert!(empty.contains("未配置"));
        assert!(empty.contains(LOGIN_HONEST));
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
    fn share_picker_defaults_to_window_and_cannot_start_without_a_live_source() {
        let picker = SharePicker::open_for_review();
        assert!(picker.open);
        assert_eq!(picker.kind, ShareKind::Window);
        assert!(!picker.can_start(false, false));
        assert!(!picker.can_start(true, false));
        assert!(!picker.can_start(false, true));
        assert_eq!(
            picker.start_reason(false, false),
            Some(SHARE_START_DISABLED)
        );
        assert_eq!(picker.empty_copy(), SHARE_EMPTY);
        assert!(picker.can_start(true, true));
        assert!(!picker.close().open);
        assert_eq!(picker.close().kind, ShareKind::Window);
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

    #[test]
    fn settings_and_meeting_pages_do_not_reuse_the_conversation_column() {
        assert!(Page::Messages.shows_conversation_column());
        assert!(!Page::Settings.shows_conversation_column());
        assert!(!Page::Meeting.shows_conversation_column());
        assert!(!Page::Members.shows_conversation_column());
        assert!(!Page::Diagnostics.shows_conversation_column());
    }
}
