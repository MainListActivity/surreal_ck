//! 只使用构建时固定的企业端点。令牌留在后台内存，不交给 UI、不写日志或磁盘。
use crate::ui;
use nsh_core::prelude::*;
use std::sync::Arc;
use surreal_ck_native_identity::{
    IdentityClient, IdentityConfig, IdentityError, Member, Session, SurrealConfig, Workspace,
    WorkspaceRole, load_members,
};

#[cfg(not(all(target_os = "android", feature = "android-native-oauth")))]
use surreal_ck_native_identity::LoopbackReceiver;

enum Command {
    Login(u64),
    Switch(u64, String),
    Logout(u64, &'static str),
    #[cfg(feature = "experimental-enterprise-signaling")]
    Chat(u64, u64, enterprise_chat::Action),
}
enum Event {
    #[cfg(feature = "experimental-enterprise-files")]
    FileTools(
        u64,
        crate::enterprise_files::FileHandle,
        tokio::sync::mpsc::Receiver<crate::enterprise_files::FileNotice>,
    ),
    #[cfg(feature = "experimental-enterprise-media")]
    MediaTools(
        u64,
        crate::enterprise_peer::LeaseObserver,
        crate::call_bridge::EnterpriseMediaHandle,
        tokio::sync::watch::Receiver<crate::call_bridge::EnterpriseCaptureState>,
    ),
    #[cfg(feature = "experimental-enterprise-media")]
    Media(u64, crate::call_bridge::Notice),
    #[cfg(not(all(target_os = "android", feature = "android-native-oauth")))]
    OpenBrowser(String),
    #[cfg(all(target_os = "android", feature = "android-native-oauth"))]
    BrowserOpened,
    Ready(DirectoryView, String),
    Failed(String),
    Cleared(String),
    #[cfg(feature = "experimental-enterprise-signaling")]
    Chat(u64, enterprise_chat::Update),
}

fn configured() -> Result<(IdentityClient, SurrealConfig), String> {
    let required = |v: Option<&'static str>| {
        v.ok_or_else(|| "企业原生登录尚未配置：需要已注册回调和匹配的客户端。".to_owned())
    };
    let mut config = IdentityConfig::new(
        required(option_env!("SURREAL_CK_OIDC_ISSUER"))?,
        required(option_env!("SURREAL_CK_API_BASE_URL"))?,
        required(option_env!("SURREAL_CK_OIDC_CLIENT_ID"))?,
        required(option_env!("SURREAL_CK_OIDC_AUDIENCE"))?,
        required(option_env!("SURREAL_CK_NATIVE_REDIRECT_URI"))?,
    )
    .map_err(|e| e.to_string())?;
    match option_env!("SURREAL_CK_OIDC_TOKEN_MODE").unwrap_or("confidential-proxy") {
        "confidential-proxy" => {}
        "public-pkce-discovery" => {
            let hosts = required(option_env!("SURREAL_CK_OIDC_ALLOWED_HOSTS"))?;
            let hosts: Vec<&str> = hosts
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect();
            config = config
                .with_public_pkce_discovery(&hosts)
                .map_err(|e| e.to_string())?;
        }
        _ => return Err("企业登录模式配置无效，不会回退到其他登录通道。".into()),
    }
    let database = SurrealConfig::new(
        required(option_env!("SURREAL_CK_SURREAL_URL"))?,
        option_env!("SURREAL_CK_SURREAL_NS").unwrap_or("main"),
    )
    .map_err(|e| e.to_string())?;
    Ok((IdentityClient::new(config), database))
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct WorkspaceChoice {
    slug: String,
    name: String,
    role: &'static str,
}
/// UI 只持有权威 API 返回的展示数据，不持有 JWT、Session 或 callback。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct DirectoryView {
    workspaces: Vec<WorkspaceChoice>,
    selected_slug: Option<String>,
    current_title: String,
    members: Vec<String>,
    #[cfg(feature = "experimental-enterprise-signaling")]
    chat_members: Vec<enterprise_chat::MemberChoice>,
    #[cfg(feature = "experimental-enterprise-signaling")]
    can_chat: bool,
}
impl DirectoryView {
    fn from_workspaces(workspaces: &[Workspace]) -> Self {
        Self {
            workspaces: workspaces
                .iter()
                .map(|workspace| WorkspaceChoice {
                    slug: workspace.slug.clone(),
                    name: workspace.name.clone(),
                    role: if workspace.role == WorkspaceRole::Admin {
                        "管理员"
                    } else {
                        "成员"
                    },
                })
                .collect(),
            ..Self::default()
        }
    }
    fn select(&mut self, workspace: &Workspace, members: Vec<Member>) {
        self.selected_slug = Some(workspace.slug.clone());
        self.current_title = format!("当前工作区：{}", workspace.name);
        #[cfg(feature = "experimental-enterprise-signaling")]
        {
            self.can_chat = workspace.role == WorkspaceRole::Participant;
            self.chat_members = members
                .iter()
                .map(|member| enterprise_chat::MemberChoice {
                    id: member.id.clone(),
                    name: member
                        .display_name
                        .clone()
                        .unwrap_or_else(|| member.email.clone()),
                    pending: member.pending,
                })
                .collect();
        }
        self.members = members
            .into_iter()
            .map(|member| {
                format!(
                    "{}{}",
                    member.display_name.unwrap_or(member.email),
                    if member.pending {
                        "（待加入）"
                    } else {
                        ""
                    },
                )
            })
            .collect();
    }
}
struct Directory {
    session: Arc<Session>,
    view: DirectoryView,
    message: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Idle,
    Login,
    Switch,
    Ready,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct IdentityViewState {
    epoch: u64,
    phase: Phase,
    signed_in: bool,
    status: String,
    directory: DirectoryView,
    #[cfg(feature = "experimental-enterprise-signaling")]
    chat: enterprise_chat::ViewState,
}
impl IdentityViewState {
    fn new(available: bool) -> Self {
        Self {
            epoch: 0,
            phase: Phase::Idle,
            signed_in: false,
            status: if available {
                "尚未登录"
            } else {
                "企业原生登录尚未配置或平台回调未接入；不会模拟登录成功。"
            }
            .into(),
            directory: DirectoryView::default(),
            #[cfg(feature = "experimental-enterprise-signaling")]
            chat: enterprise_chat::ViewState::default(),
        }
    }
    fn busy(&self) -> bool {
        matches!(self.phase, Phase::Login | Phase::Switch)
    }
    fn next_epoch(&self) -> u64 {
        self.epoch.wrapping_add(1)
    }
    fn clear(&mut self, epoch: u64, message: String) {
        #[cfg(feature = "experimental-enterprise-signaling")]
        self.chat.invalidate();
        self.epoch = epoch;
        self.phase = Phase::Idle;
        self.signed_in = false;
        self.directory = DirectoryView::default();
        self.status = message;
    }
    fn begin_login(&mut self) -> u64 {
        let id = self.next_epoch();
        self.clear(id, "正在准备系统浏览器登录…".into());
        self.phase = Phase::Login;
        id
    }
    fn begin_switch(&mut self, slug: &str) -> Option<u64> {
        if self.phase != Phase::Ready || !self.signed_in {
            return None;
        }
        let target = self
            .directory
            .workspaces
            .iter()
            .find(|workspace| workspace.slug == slug)?;
        self.status = format!("正在切换至 {}；完成前保留当前会话和成员。", target.name);
        #[cfg(feature = "experimental-enterprise-signaling")]
        self.chat.invalidate();
        self.epoch = self.next_epoch();
        self.phase = Phase::Switch;
        Some(self.epoch)
    }
    /// 返回的 URL 只交给系统浏览器；其余事件不能触发任何外部动作。
    fn apply(&mut self, id: u64, event: Event) -> Option<String> {
        if id != self.epoch {
            return None;
        }
        match event {
            #[cfg(feature = "experimental-enterprise-signaling")]
            Event::Chat(generation, update) if self.phase == Phase::Ready && self.signed_in => {
                self.chat.apply(generation, update);
            }
            Event::Ready(view, message) if self.busy() => {
                self.directory = view;
                self.status = message;
                self.phase = Phase::Ready;
                self.signed_in = true;
            }
            Event::Failed(message) if self.busy() => {
                self.status = message;
                self.phase = if self.signed_in {
                    Phase::Ready
                } else {
                    Phase::Idle
                };
            }
            Event::Cleared(message) => self.clear(id, message),
            #[cfg(all(target_os = "android", feature = "android-native-oauth"))]
            Event::BrowserOpened if self.phase == Phase::Login => {
                self.status = "请在系统浏览器完成登录；等待本次回调。".into();
            }
            #[cfg(not(all(target_os = "android", feature = "android-native-oauth")))]
            Event::OpenBrowser(url) if self.phase == Phase::Login => {
                self.status = "请在系统浏览器完成登录；等待本次回调。".into();
                return Some(url);
            }
            _ => {}
        }
        None
    }
}
/// 过期也会关闭结果闸门，避免同一 epoch 已排队的迟到结果重新建立会话。
#[derive(Default)]
struct CompletionGate {
    epoch: u64,
    accepting: bool,
}
impl CompletionGate {
    fn start(&mut self, id: u64) {
        self.epoch = id;
        self.accepting = true;
    }
    fn invalidate(&mut self, id: u64) {
        self.epoch = id;
        self.accepting = false;
    }
    fn finish(&mut self, id: u64) -> bool {
        if self.epoch != id || !self.accepting {
            return false;
        }
        self.accepting = false;
        true
    }
}

async fn login_directory(
    id: u64,
    out: async_channel::Sender<(u64, Event)>,
) -> Result<Directory, String> {
    let (client, database) = configured()?;
    let attempt = client
        .begin_login_async()
        .await
        .map_err(|error| error.to_string())?;
    #[cfg(not(all(target_os = "android", feature = "android-native-oauth")))]
    let callback = {
        let receiver = LoopbackReceiver::bind(&attempt).map_err(|error| error.to_string())?;
        out.send((
            id,
            Event::OpenBrowser(attempt.authorization_url().to_owned()),
        ))
        .await
        .map_err(|_| "登录界面已关闭".to_owned())?;
        receiver
            .receive(&attempt)
            .await
            .map_err(|error| error.to_string())?
    };
    #[cfg(all(target_os = "android", feature = "android-native-oauth"))]
    let callback = {
        let receiver = crate::android_oauth::AndroidReceiver::bind(&attempt)?;
        receiver.open_browser(attempt.authorization_url())?;
        out.send((id, Event::BrowserOpened))
            .await
            .map_err(|_| "登录界面已关闭".to_owned())?;
        receiver.receive(&attempt).await?
    };
    let session = Arc::new(
        attempt
            .finish_async(callback)
            .await
            .map_err(|error| error.to_string())?,
    );
    let workspaces = client
        .list_workspaces_async(&session)
        .await
        .map_err(|error| error.to_string())?;
    let mut view = DirectoryView::from_workspaces(&workspaces.workspaces);
    let mut message = if view.workspaces.is_empty() {
        "身份已验证，尚无可访问工作区，请联系管理员。"
    } else {
        "身份已验证，请选择工作区以加载成员。"
    }
    .to_owned();
    // 只读取 token 已有的真实当前 scope，不取第一个 workspace、不调用 scope 切换。
    if let Some(current) = workspaces
        .workspaces
        .iter()
        .find(|workspace| Some(workspace.db_name.as_str()) == session.database())
    {
        match load_members(&client, &session, &database, &current.slug).await {
            Ok(members) => {
                view.select(current, members);
                message = format!("已验证登录 · {}", current.name);
            }
            Err(IdentityError::WorkspaceNotSelected) => {}
            Err(error) => {
                message = format!(
                    "身份已验证，当前工作区成员读取失败：{error}。可明确选择工作区后重试。"
                );
            }
        }
    }
    session
        .ensure_current()
        .map_err(|error| error.to_string())?;
    Ok(Directory {
        session,
        view,
        message,
    })
}
async fn switch_directory(previous: Arc<Session>, slug: String) -> Result<Directory, String> {
    let (client, database) = configured()?;
    let session = Arc::new(
        client
            .switch_workspace_async(previous, slug.clone())
            .await
            .map_err(|error| error.to_string())?,
    );
    let workspaces = client
        .list_workspaces_async(&session)
        .await
        .map_err(|error| error.to_string())?;
    let target = workspaces
        .workspaces
        .iter()
        .find(|workspace| workspace.slug == slug)
        .ok_or_else(|| "目标工作区不再出现在可访问列表中".to_owned())?;
    let members = load_members(&client, &session, &database, &slug)
        .await
        .map_err(|error| error.to_string())?;
    session
        .ensure_current()
        .map_err(|error| error.to_string())?;
    let mut view = DirectoryView::from_workspaces(&workspaces.workspaces);
    view.select(target, members);
    Ok(Directory {
        session,
        view,
        message: format!("已验证登录 · {}", target.name),
    })
}
fn abort(pending: &mut Option<tokio::task::JoinHandle<()>>) {
    if let Some(job) = pending.take() {
        job.abort();
    }
}
fn start() -> (
    async_channel::Sender<Command>,
    async_channel::Receiver<(u64, Event)>,
) {
    // 只有本地按钮能生产命令；不让退出操作因短暂满队列而失败。
    let (tx, rx) = async_channel::unbounded();
    let (out, events) = async_channel::bounded(16);
    std::thread::spawn(move || {
        let Ok(rt) = tokio::runtime::Runtime::new() else {
            let _ = out.send_blocking((0, Event::Cleared("无法启动企业登录后台，请重试。".into())));
            return;
        };
        rt.block_on(async move {
            let (done, results) = async_channel::bounded::<(u64, Result<Directory, String>)>(2);
            let mut pending: Option<tokio::task::JoinHandle<()>> = None;
            let mut directory: Option<Directory> = None;
            let mut gate = CompletionGate::default();
            #[cfg(feature = "experimental-enterprise-signaling")]
            let mut chat_worker = enterprise_chat::Slot::default();
            let mut expiry = tokio::time::interval(std::time::Duration::from_secs(1));
            loop {
                tokio::select! {
                    _ = expiry.tick() => {
                        if directory.as_ref().is_some_and(|entry| entry.session.ensure_current().is_err()) {
                            #[cfg(feature = "experimental-enterprise-signaling")]
                            {
                                gate.invalidate(gate.epoch);
                                let _ = out.send((gate.epoch, Event::Cleared("登录已过期，正在停止实验聊天…".into()))).await;
                            }
                            #[cfg(feature = "experimental-enterprise-signaling")]
                            let close = enterprise_chat::shutdown(&mut chat_worker).await;
                            directory.take();
                            abort(&mut pending);
                            gate.invalidate(gate.epoch);
                            let message = "登录已过期，请重新登录。".to_owned();
                            #[cfg(feature = "experimental-enterprise-signaling")]
                            let message = enterprise_chat::close_message(message, close);
                            let _ = out.send((gate.epoch, Event::Cleared(message))).await;
                        }
                    }
                    command = rx.recv() => {
                        let Ok(command) = command else { break; };
                        // 卸载关闭 Sender 后不再执行队列中尚未开始的邀请/发送操作。
                        if rx.is_closed() { break; }
                        #[cfg(feature = "experimental-enterprise-signaling")]
                        let command = match command {
                            Command::Chat(id, generation, action) => {
                                if id == gate.epoch && !gate.accepting {
                                    enterprise_chat::dispatch(id, generation, action, directory.as_ref(), &mut chat_worker, &out).await;
                                }
                                continue;
                            }
                            other => other,
                        };
                        abort(&mut pending);
                        #[cfg(feature = "experimental-enterprise-signaling")]
                        let close = enterprise_chat::shutdown(&mut chat_worker).await;
                        #[cfg(feature = "experimental-enterprise-signaling")]
                        let close_warning = close.as_ref().ok().cloned().flatten();
                        match command {
                            #[cfg(feature = "experimental-enterprise-signaling")]
                            Command::Chat(_, _, _) => unreachable!(),
                            Command::Logout(id, reason) => {
                                directory.take();
                                gate.invalidate(id);
                                let message = reason.to_owned();
                                #[cfg(feature = "experimental-enterprise-signaling")]
                                let message = enterprise_chat::close_message(message, close);
                                let _ = out.send((id, Event::Cleared(message))).await;
                            }
                            Command::Login(id) => {
                                directory.take();
                                #[cfg(feature = "experimental-enterprise-signaling")]
                                if let Err(error) = close {
                                    gate.invalidate(id);
                                    let _ = out.send((id, Event::Cleared(format!("聊天关闭未确认，未开始新登录：{error}。请退出应用确认断开。")))).await;
                                    continue;
                                }
                                gate.start(id);
                                let done = done.clone();
                                let out = out.clone();
                                pending = Some(tokio::spawn(async move {
                                    let result = login_directory(id, out).await;
                                    #[cfg(feature = "experimental-enterprise-signaling")]
                                    let result = enterprise_chat::add_close_warning(result, close_warning);
                                    let _ = done.send((id, result)).await;
                                }));
                            }
                            Command::Switch(id, slug) => {
                                #[cfg(feature = "experimental-enterprise-signaling")]
                                if let Err(error) = close {
                                    gate.invalidate(id);
                                    let _ = out.send((id, Event::Failed(format!("聊天关闭未确认，未切换工作区：{error}。请退出应用确认断开。")))).await;
                                    continue;
                                }
                                let previous = directory.as_ref().filter(|entry| entry.session.ensure_current().is_ok());
                                let Some(previous) = previous else {
                                    directory.take();
                                    gate.invalidate(id);
                                    let _ = out.send((id, Event::Cleared("登录已失效，请重新登录后选择工作区。".into()))).await;
                                    continue;
                                };
                                gate.start(id);
                                let previous = previous.session.clone();
                                let done = done.clone();
                                pending = Some(tokio::spawn(async move {
                                    let result = switch_directory(previous, slug).await;
                                    #[cfg(feature = "experimental-enterprise-signaling")]
                                    let result = enterprise_chat::add_close_warning(result, close_warning);
                                    let _ = done.send((id, result)).await;
                                }));
                            }
                        }
                    }
                    result = results.recv() => {
                        let Ok((id, result)) = result else { break; };
                        if !gate.finish(id) { continue; }
                        pending.take();
                        match result {
                            Ok(next) if next.session.ensure_current().is_ok() => {
                                let event = Event::Ready(next.view.clone(), next.message.clone());
                                directory = Some(next);
                                let _ = out.send((id, event)).await;
                            }
                            Ok(_) => {
                                directory.take();
                                let _ = out.send((id, Event::Cleared("登录已过期，请重新登录。".into()))).await;
                            }
                            Err(error) => {
                                if directory.as_ref().is_some_and(|entry| entry.session.ensure_current().is_err()) {
                                    directory.take();
                                    let _ = out.send((id, Event::Cleared("登录已过期，请重新登录。".into()))).await;
                                } else {
                                    let message = if directory.is_some() {
                                        format!("切换未完成：{error}。已保留原会话与成员；服务端最近选择可能已更新。")
                                    } else { format!("登录未完成：{error}") };
                                    let _ = out.send((id, Event::Failed(message))).await;
                                }
                            }
                        }
                    }
                }
            }
            abort(&mut pending);
            #[cfg(feature = "experimental-enterprise-signaling")]
            let _ = enterprise_chat::shutdown(&mut chat_worker).await;
            drop(directory);
        });
    });
    (tx, events)
}

/// 当前构建是否接入了企业原生登录（公开配置齐全且平台回调可用）。
pub fn identity_available() -> bool {
    configured().is_ok() && (!cfg!(target_os = "android") || cfg!(feature = "android-native-oauth"))
}

fn summary_of(state: &IdentityViewState, available: bool) -> crate::first_screen::IdentitySummary {
    let workspace = state.directory.selected_slug.as_deref().map(|slug| {
        state
            .directory
            .workspaces
            .iter()
            .find(|w| w.slug == slug)
            .map(|w| w.name.clone())
            .unwrap_or_else(|| slug.to_owned())
    });
    crate::first_screen::IdentitySummary {
        configured: available,
        signed_in: state.signed_in,
        loading: state.busy(),
        workspace: if state.signed_in { workspace } else { None },
    }
}

/// 企业身份与工作区面板。summary 向首屏公开真实身份摘要（无假登录）。
/// 面板常驻挂载：只折叠账号设置，不能将采集隐私与停止区一起隐藏。
pub fn enterprise_identity(
    summary: Signal<crate::first_screen::IdentitySummary>,
) -> impl IntoElement {
    let expanded = signal(false);
    let available = identity_available();
    let state = signal(IdentityViewState::new(available));
    effect(move || {
        let next = summary_of(&state.get(), available);
        if summary.get_untracked() != next {
            summary.set(next);
        }
    });
    #[cfg(feature = "experimental-enterprise-files")]
    let files = crate::enterprise_file_tools::FileTools::new();
    #[cfg(feature = "experimental-enterprise-files")]
    cleanup(move || files.invalidate());
    #[cfg(feature = "experimental-enterprise-media")]
    let media = crate::enterprise_tools::MediaTools::new();
    #[cfg(feature = "experimental-enterprise-media")]
    cleanup(move || media.invalidate());
    let (commands, events) = start();
    let cleanup_commands = commands.clone();
    cleanup(move || {
        cleanup_commands.close();
    });
    let browser_commands = commands.clone();
    spawn(async move {
        while let Ok((id, event)) = events.recv().await {
            #[cfg(feature = "experimental-enterprise-files")]
            let event = match event {
                Event::FileTools(generation, handle, notices) => {
                    let current = state.get_untracked();
                    if current.epoch == id
                        && current.chat.generation == generation
                        && handle.is_active()
                    {
                        if let Err(error) = files.bind(id, generation, handle, notices) {
                            state.update(|state| {
                                state.status = format!("企业文件界面未建立：{error}")
                            });
                        }
                    } else {
                        handle.request_stop();
                    }
                    continue;
                }
                event => {
                    match &event {
                        Event::Chat(generation, enterprise_chat::Update::Open(_))
                            if state.get_untracked().epoch == id
                                && state.get_untracked().chat.generation == *generation =>
                        {
                            files.opened(id, *generation)
                        }
                        Event::Cleared(_) if state.get_untracked().epoch == id => {
                            files.invalidate()
                        }
                        Event::Chat(generation, enterprise_chat::Update::Stopped(_, _))
                            if state.get_untracked().epoch == id
                                && state.get_untracked().chat.generation == *generation =>
                        {
                            files.invalidate();
                            let current = state.get_untracked();
                            if current.signed_in && current.phase == Phase::Ready {
                                files.retain_identity(id);
                            }
                        }
                        _ => {}
                    }
                    event
                }
            };
            #[cfg(feature = "experimental-enterprise-media")]
            let event = match event {
                Event::MediaTools(generation, lease, handle, states) => {
                    let current = state.get_untracked();
                    if current.epoch == id
                        && current.chat.generation == generation
                        && lease.is_active()
                    {
                        media.bind(id, generation, lease, handle, states);
                    } else {
                        handle.request_stop();
                    }
                    continue;
                }
                Event::Media(generation, notice) => {
                    let current = state.get_untracked();
                    if current.epoch == id && current.chat.generation == generation {
                        media.event(id, generation, notice);
                    }
                    continue;
                }
                event => {
                    match &event {
                        Event::Chat(generation, enterprise_chat::Update::Open(_))
                            if state.get_untracked().epoch == id
                                && state.get_untracked().chat.generation == *generation =>
                        {
                            media.opened(id, *generation)
                        }
                        Event::Cleared(_) if state.get_untracked().epoch == id => {
                            media.invalidate()
                        }
                        Event::Chat(generation, enterprise_chat::Update::Stopped(_, _))
                            if state.get_untracked().epoch == id
                                && state.get_untracked().chat.generation == *generation =>
                        {
                            media.invalidate()
                        }
                        _ => {}
                    }
                    event
                }
            };
            let mut next = state.get_untracked();
            let browser = next.apply(id, event);
            state.set(next);
            if let Some(url) = browser {
                let opened = open_url(url).await;
                let mut latest = state.get_untracked();
                if !opened && latest.epoch == id && latest.phase == Phase::Login {
                    let id = latest.next_epoch();
                    let reason = "无法打开系统浏览器，本次登录等待已取消。";
                    latest.clear(id, reason.into());
                    state.set(latest);
                    let _ = browser_commands.try_send(Command::Logout(id, reason));
                }
            }
        }
    });
    let login = commands.clone();
    let logout = commands.clone();
    let choose = commands.clone();
    #[cfg(feature = "experimental-enterprise-signaling")]
    let chat_panel = enterprise_chat::panel(state, commands, move || {
        #[cfg(feature = "experimental-enterprise-files")]
        files.invalidate();
        #[cfg(feature = "experimental-enterprise-media")]
        media.invalidate();
    });
    let panel = view()
        .style_when(move || !expanded.get(), |style| style.hidden())
        .gap_2()
        .p_3()
        .border_1()
        .border_color(move || nsh_base::theme().border)
        .child(text("企业账号与成员"))
        .child(text(move || state.get().status))
        .child(
            view()
                .flex_row()
                .gap_2()
                .child(ui::action(
                    "系统浏览器登录",
                    move || !available || state.get().busy(),
                    move || {
                        let mut next = state.get_untracked();
                        if !available || next.busy() {
                            return;
                        }
                        #[cfg(feature = "experimental-enterprise-files")]
                        files.invalidate();
                        #[cfg(feature = "experimental-enterprise-media")]
                        media.invalidate();
                        let id = next.begin_login();
                        if login.try_send(Command::Login(id)).is_err() {
                            next.clear(id, "登录后台已关闭，请重新打开企业账号面板。".into());
                        }
                        state.set(next);
                    },
                ))
                .child(ui::action(
                    "取消登录 / 退出",
                    || false,
                    move || {
                        let mut next = state.get_untracked();
                        let id = next.next_epoch();
                        #[cfg(feature = "experimental-enterprise-files")]
                        files.invalidate();
                        #[cfg(feature = "experimental-enterprise-media")]
                        media.invalidate();
                        let reason = "已退出本地会话；未调用远端退出或修改账号。";
                        next.clear(id, reason.into());
                        #[cfg(feature = "experimental-enterprise-signaling")]
                        {
                            next.status = "正在停止实验聊天并退出本地会话…".into();
                        }
                        let _ = logout.try_send(Command::Logout(id, reason));
                        state.set(next);
                    },
                )),
        )
        .child(when(
            move || state.get().signed_in,
            move || {
                let choose = choose.clone();
                view()
                    .gap_2()
                    .child(text("可访问工作区（来自企业服务）"))
                    .child(text(
                        "点击“进入此工作区”才会请求切换权限与读取成员，不会自动选择其他工作区。",
                    ))
                    .child(
                        virtual_list(
                            move || state.get().directory.workspaces.len(),
                            move |at| {
                                let choose = choose.clone();
                                view()
                                    .flex_row()
                                    .gap_2()
                                    .child(
                                        text(move || {
                                            let current = state.get();
                                            current
                                                .directory
                                                .workspaces
                                                .get(at.index())
                                                .map(|workspace| {
                                                    format!(
                                                        "{} · {}{}",
                                                        workspace.name,
                                                        workspace.role,
                                                        if current
                                                            .directory
                                                            .selected_slug
                                                            .as_deref()
                                                            == Some(workspace.slug.as_str())
                                                        {
                                                            " · 当前"
                                                        } else {
                                                            ""
                                                        },
                                                    )
                                                })
                                                .unwrap_or_default()
                                        })
                                        .flex_1(),
                                    )
                                    .child(ui::action(
                                        "进入此工作区",
                                        move || state.get().phase != Phase::Ready,
                                        move || {
                                            let mut next = state.get_untracked();
                                            let Some(target) =
                                                next.directory.workspaces.get(at.index()).cloned()
                                            else {
                                                return;
                                            };
                                            let Some(id) = next.begin_switch(&target.slug) else {
                                                return;
                                            };
                                            #[cfg(feature = "experimental-enterprise-files")]
                                            files.invalidate();
                                            #[cfg(feature = "experimental-enterprise-media")]
                                            media.invalidate();
                                            if choose
                                                .try_send(Command::Switch(id, target.slug))
                                                .is_err()
                                            {
                                                next.clear(
                                                    id,
                                                    "登录后台已关闭，请重新打开企业账号面板。"
                                                        .into(),
                                                );
                                            }
                                            state.set(next);
                                        },
                                    ))
                            },
                        )
                        .estimated_item_size(px(54.0))
                        .h(px(150.0)),
                    )
            },
        ))
        .child(when(
            move || state.get().directory.selected_slug.is_some(),
            move || {
                view()
                    .gap_2()
                    .child(text(move || state.get().directory.current_title))
                    .child(text("工作区成员（只读）"))
                    .child(when(
                        move || state.get().directory.members.is_empty(),
                        || text("暂无可见成员。"),
                    ))
                    .child(
                        virtual_list(
                            move || state.get().directory.members.len(),
                            move |at| {
                                text(move || {
                                    state
                                        .get()
                                        .directory
                                        .members
                                        .get(at.index())
                                        .cloned()
                                        .unwrap_or_default()
                                })
                            },
                        )
                        .estimated_item_size(px(28.0))
                        .h(px(140.0)),
                    )
            },
        ))
        .child(text(
            "会话仅保存在应用内存，退出或关闭应用会清除。成员目录未与手工 P2P 对端身份绑定。",
        ));
    #[cfg(feature = "experimental-enterprise-signaling")]
    let panel = panel.child(chat_panel);
    let root = view()
        .gap_2()
        .child(ui::action(
            "企业账号与成员",
            || false,
            move || expanded.set(!expanded.get_untracked()),
        ))
        .child(panel);
    #[cfg(feature = "experimental-enterprise-media")]
    let root = root.child(media.view());
    #[cfg(feature = "experimental-enterprise-files")]
    let root = root.child(files.view());
    root
}

#[cfg(test)]
mod tests {
    use super::*;
    fn verified_view(slug: &str) -> DirectoryView {
        DirectoryView {
            workspaces: vec![
                WorkspaceChoice {
                    slug: "old".into(),
                    name: "原工作区".into(),
                    role: "成员",
                },
                WorkspaceChoice {
                    slug: "new".into(),
                    name: "新工作区".into(),
                    role: "管理员",
                },
            ],
            selected_slug: Some(slug.into()),
            current_title: format!("当前工作区：{slug}"),
            members: vec![format!("{slug}-已验证成员")],
            #[cfg(feature = "experimental-enterprise-signaling")]
            chat_members: Vec::new(),
            #[cfg(feature = "experimental-enterprise-signaling")]
            can_chat: false,
        }
    }
    fn signed_in() -> IdentityViewState {
        let mut state = IdentityViewState::new(true);
        let id = state.begin_login();
        state.apply(id, Event::Ready(verified_view("old"), "已验证登录".into()));
        state
    }
    #[test]
    fn missing_configuration_has_no_fake_workspace_or_session() {
        let state = IdentityViewState::new(false);
        assert!(!state.signed_in);
        assert!(state.directory.workspaces.is_empty());
        assert!(state.directory.members.is_empty());
        assert!(state.status.contains("不会模拟登录成功"));
    }
    #[test]
    fn switch_requires_explicit_known_selection_and_blocks_repeated_clicks() {
        let mut state = signed_in();
        let before = state.clone();
        assert_eq!(state.begin_switch("not-listed"), None);
        assert_eq!(state, before);
        assert!(state.begin_switch("new").is_some());
        assert_eq!(state.directory, before.directory);
        assert_eq!(state.begin_switch("old"), None);
    }
    #[test]
    fn failed_switch_keeps_verified_members_and_selection() {
        let mut state = signed_in();
        let previous = state.directory.clone();
        let id = state.begin_switch("new").unwrap();
        state.apply(id, Event::Failed("切换失败".into()));
        assert_eq!(state.directory, previous);
        assert!(state.signed_in);
        assert_eq!(state.phase, Phase::Ready);
        assert_eq!(state.status, "切换失败");
    }
    #[test]
    fn successful_switch_replaces_members_only_when_complete() {
        let mut state = signed_in();
        let id = state.begin_switch("new").unwrap();
        assert_eq!(state.directory.selected_slug.as_deref(), Some("old"));
        state.apply(id, Event::Ready(verified_view("new"), "切换完成".into()));
        assert_eq!(state.directory.selected_slug.as_deref(), Some("new"));
        assert_eq!(state.directory.members, vec!["new-已验证成员"]);
    }
    #[test]
    fn logout_expiry_and_new_login_prevent_late_results_from_restoring_directory() {
        let mut state = signed_in();
        let old = state.begin_switch("new").unwrap();
        state.clear(state.next_epoch(), "已退出".into());
        state.apply(old, Event::Ready(verified_view("new"), "迟到".into()));
        assert!(!state.signed_in);
        assert!(state.directory.members.is_empty());
        let id = state.begin_login();
        state.apply(id, Event::Cleared("过期".into()));
        state.apply(id, Event::Ready(verified_view("new"), "同代迟到".into()));
        assert!(!state.signed_in);
        assert_eq!(state.status, "过期");
        let newer = state.begin_login();
        state.apply(id, Event::Failed("旧失败".into()));
        assert_eq!(state.epoch, newer);
        assert_eq!(state.phase, Phase::Login);
    }
    #[test]
    fn backend_gate_rejects_superseded_expired_and_duplicate_completions() {
        let mut gate = CompletionGate::default();
        gate.start(1);
        gate.start(2);
        assert!(!gate.finish(1));
        assert!(gate.finish(2));
        assert!(!gate.finish(2));
        gate.start(3);
        gate.invalidate(3);
        assert!(!gate.finish(3));
    }
    #[test]
    fn empty_real_workspace_list_does_not_invent_a_selection() {
        let mut state = IdentityViewState::new(true);
        let id = state.begin_login();
        state.apply(
            id,
            Event::Ready(DirectoryView::default(), "尚无工作区".into()),
        );
        assert!(state.signed_in);
        assert!(state.directory.selected_slug.is_none());
        assert!(state.directory.workspaces.is_empty());
        assert_eq!(state.begin_switch("default"), None);
    }
}

/// 实验功能全部在同一文件内隔离；默认构建不创建信令网络或聊天控件。
#[cfg(feature = "experimental-enterprise-signaling")]
mod enterprise_chat {
    use super::*;
    use crate::enterprise_peer::{EnterprisePeer, LeaseObserver};
    use surreal_ck_native_identity::SignalConnection;
    use surreal_ck_native_signaling::Signaling;
    use surreal_ck_peer_transport::chat::{Event as PeerEvent, MAX_TEXT_BYTES};
    use tokio::{sync::oneshot, task::JoinHandle, time::Duration};

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub(super) struct MemberChoice {
        pub id: String,
        pub name: String,
        pub pending: bool,
    }
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub(super) struct Invitation {
        id: String,
        sender: String,
        name: String,
    }
    pub(super) enum Action {
        Enable,
        Invite(String),
        Accept(String),
        Reject(String),
        Send(u64, String),
        Stop,
    }
    pub(super) enum Update {
        Listening(String),
        Inbox(Vec<Invitation>),
        Negotiating(String),
        Open(LeaseObserver),
        Text(String, LeaseObserver),
        Queued(u64, String, LeaseObserver),
        Rejected,
        Stopped(String, bool),
    }
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    enum ChatPhase {
        #[default]
        Off,
        Starting,
        Listening,
        Negotiating,
        Connected,
        Stopping,
        CloseFailed,
    }
    #[derive(Clone, Debug, Default, PartialEq, Eq)]
    pub(super) struct ViewState {
        pub(super) generation: u64,
        operation: u64,
        phase: ChatPhase,
        busy: bool,
        member_id: String,
        status: String,
        invitations: Vec<Invitation>,
        selected_invitation: Option<Invitation>,
        messages: Vec<String>,
        draft: String,
    }
    impl ViewState {
        pub(super) fn invalidate(&mut self) {
            let generation = self.generation.wrapping_add(1);
            *self = Self {
                generation,
                ..Self::default()
            };
        }
        fn enable(&mut self) -> Option<u64> {
            if self.phase != ChatPhase::Off {
                return None;
            }
            self.invalidate();
            self.phase = ChatPhase::Starting;
            self.status = "正在验证当前真人身份并连接信令…".into();
            Some(self.generation)
        }
        fn stop(&mut self) -> u64 {
            self.invalidate();
            self.phase = ChatPhase::Stopping;
            self.status = "正在关闭聊天并等待本地通道确认…".into();
            self.generation
        }
        fn can_choose(&self) -> bool {
            self.phase == ChatPhase::Listening && !self.busy
        }
        pub(super) fn apply(&mut self, generation: u64, update: Update) {
            if generation != self.generation {
                return;
            }
            match update {
                Update::Open(lease) | Update::Text(_, lease) | Update::Queued(_, _, lease)
                    if matches!(self.phase, ChatPhase::Negotiating | ChatPhase::Connected)
                        && !lease.is_active() =>
                {
                    self.phase = ChatPhase::Stopping;
                    self.busy = false;
                    self.messages.clear();
                    self.draft.clear();
                    self.status = "成员有效性已失效，正在等待聊天关闭确认…".into();
                }
                Update::Listening(id) if self.phase == ChatPhase::Starting => {
                    self.member_id = id;
                    self.phase = ChatPhase::Listening;
                    self.status = "身份已验证，正在等待邀请；尚未连接对端。".into();
                }
                Update::Inbox(invitations) if self.phase == ChatPhase::Listening => {
                    if self.selected_invitation.as_ref().is_some_and(|selected| {
                        !invitations
                            .iter()
                            .any(|item| item.id == selected.id && item.sender == selected.sender)
                    }) {
                        self.selected_invitation = None;
                    }
                    self.invitations = invitations
                }
                Update::Negotiating(message)
                    if matches!(self.phase, ChatPhase::Listening | ChatPhase::Negotiating) =>
                {
                    self.phase = ChatPhase::Negotiating;
                    self.busy = false;
                    self.invitations.clear();
                    self.selected_invitation = None;
                    self.status = message;
                }
                Update::Open(_) if self.phase == ChatPhase::Negotiating => {
                    self.phase = ChatPhase::Connected;
                    self.status = "企业聊天通道已连通 · 仅文字聊天".into();
                }
                Update::Text(message, _) if self.phase == ChatPhase::Connected => {
                    self.push(format!("对方：{message}"))
                }
                Update::Queued(operation, message, _)
                    if self.phase == ChatPhase::Connected && self.operation == operation =>
                {
                    self.busy = false;
                    if self.draft == message {
                        self.draft.clear();
                    }
                    self.push(format!("我（已交给通道）：{message}"));
                }
                Update::Rejected if self.phase == ChatPhase::Listening => {
                    self.busy = false;
                    self.invitations.clear();
                    self.selected_invitation = None;
                    self.status = "已拒绝该邀请，等待下一次真实列表更新。".into();
                }
                Update::Stopped(message, confirmed) => {
                    self.busy = false;
                    self.phase = if confirmed {
                        ChatPhase::Off
                    } else {
                        ChatPhase::CloseFailed
                    };
                    self.member_id.clear();
                    self.invitations.clear();
                    self.selected_invitation = None;
                    self.status = message;
                }
                _ => {}
            }
        }
        fn push(&mut self, message: String) {
            if self.messages.len() >= 200 {
                self.messages.remove(0);
            }
            self.messages.push(message);
        }
    }

    pub(super) struct Worker {
        generation: u64,
        commands: async_channel::Sender<Action>,
        stop: oneshot::Sender<()>,
        task: JoinHandle<Result<Option<String>, String>>,
    }
    #[derive(Default)]
    pub(super) struct Slot {
        worker: Option<Worker>,
        // 只有本地关闭未确认会锁住新连接；远端 end 失败只提示，不阻止切换。
        close_error: Option<String>,
    }
    pub(super) async fn shutdown(slot: &mut Slot) -> Result<Option<String>, String> {
        let mut remote_warning = None;
        if let Some(worker) = slot.worker.take() {
            let _ = worker.stop.send(());
            let result = worker
                .task
                .await
                .unwrap_or_else(|_| Err("聊天后台意外结束，关闭未确认".into()));
            match result {
                Err(error) => slot.close_error = Some(error),
                Ok(warning) => remote_warning = warning,
            }
        }
        slot.close_error.clone().map_or(Ok(remote_warning), Err)
    }
    pub(super) fn add_close_warning(
        result: Result<Directory, String>,
        warning: Option<String>,
    ) -> Result<Directory, String> {
        let Some(warning) = warning else {
            return result;
        };
        match result {
            Ok(mut directory) => {
                directory
                    .message
                    .push_str(&format!(" 本地旧聊天已关闭；远端结束状态未确认：{warning}"));
                Ok(directory)
            }
            Err(error) => Err(format!(
                "{error}。本地旧聊天已关闭；远端结束状态未确认：{warning}"
            )),
        }
    }
    pub(super) fn close_message(message: String, result: Result<Option<String>, String>) -> String {
        match result {
            Ok(None) => message,
            Ok(Some(warning)) => format!("{message} 本地通道已关闭；远端结束状态未确认：{warning}"),
            Err(error) => {
                format!("本地登录已清除，但聊天关闭未确认：{error}。请退出应用确认断开。")
            }
        }
    }
    pub(super) async fn dispatch(
        epoch: u64,
        generation: u64,
        action: Action,
        directory: Option<&Directory>,
        slot: &mut Slot,
        out: &async_channel::Sender<(u64, Event)>,
    ) {
        if matches!(action, Action::Stop) {
            let result = shutdown(slot).await;
            let confirmed = result.is_ok();
            let message = match result {
                Ok(None) => "实验聊天已停止。".into(),
                Ok(Some(warning)) => format!("本地聊天已停止；远端结束状态未确认：{warning}"),
                Err(error) => format!("聊天关闭未确认：{error}。请退出应用确认断开。"),
            };
            let _ = out
                .send((
                    epoch,
                    Event::Chat(generation, Update::Stopped(message, confirmed)),
                ))
                .await;
            return;
        }
        let Some(directory) =
            directory.filter(|d| d.session.ensure_current().is_ok() && d.view.can_chat)
        else {
            let _ = out
                .send((
                    epoch,
                    Event::Chat(
                        generation,
                        Update::Stopped(
                            "需要当前工作区的真人 participant 会话；管理员 system 身份不可代用。"
                                .into(),
                            true,
                        ),
                    ),
                ))
                .await;
            return;
        };
        if matches!(action, Action::Enable) {
            if let Err(error) = shutdown(slot).await {
                let _ = out
                    .send((
                        epoch,
                        Event::Chat(
                            generation,
                            Update::Stopped(
                                format!("关闭未确认：{error}。请退出应用确认断开。"),
                                false,
                            ),
                        ),
                    ))
                    .await;
                return;
            }
            let Some(slug) = directory.view.selected_slug.clone() else {
                return;
            };
            let session = directory.session.clone();
            let members = directory.view.chat_members.clone();
            let (commands, requests) = async_channel::bounded(8);
            let (stop, stopped) = oneshot::channel();
            let output = out.clone();
            let task = tokio::spawn(run(
                epoch, generation, session, slug, members, output, requests, stopped,
            ));
            slot.worker = Some(Worker {
                generation,
                commands,
                stop,
                task,
            });
        } else if let Some(worker) = slot.worker.as_ref().filter(|w| w.generation == generation)
            && worker.commands.try_send(action).is_err()
        {
            let result = shutdown(slot).await;
            let confirmed = result.is_ok();
            let message = match result {
                Ok(None) => "聊天后台不可用，已完成停止；可明确重新启用。".to_owned(),
                Ok(Some(warning)) => format!("本地聊天已停止；远端结束未确认：{warning}"),
                Err(_) => "聊天后台不可用且关闭未确认，请退出应用确认断开。".to_owned(),
            };
            let _ = out
                .send((
                    epoch,
                    Event::Chat(generation, Update::Stopped(message, confirmed)),
                ))
                .await;
        }
    }
    async fn connection(session: Arc<Session>, slug: &str) -> Result<SignalConnection, String> {
        let (client, database) = configured()?;
        SignalConnection::connect(&client, session, &database, slug)
            .await
            .map_err(|error| error.to_string())
    }
    fn emit(
        out: &async_channel::Sender<(u64, Event)>,
        epoch: u64,
        generation: u64,
        update: Update,
    ) -> bool {
        // UI 不消费/缓冲已满时 fail closed，不能让停机卡在一条显示消息上。
        out.try_send((epoch, Event::Chat(generation, update)))
            .is_ok()
    }
    #[allow(clippy::too_many_arguments)]
    async fn run(
        epoch: u64,
        generation: u64,
        session: Arc<Session>,
        slug: String,
        members: Vec<MemberChoice>,
        out: async_channel::Sender<(u64, Event)>,
        commands: async_channel::Receiver<Action>,
        mut stop: oneshot::Receiver<()>,
    ) -> Result<Option<String>, String> {
        let connected = tokio::select! {
            biased;
            _ = &mut stop => return Ok(None),
            result = connection(session.clone(), &slug) => result,
        };
        let db_connection = match connected {
            Ok(connection) => connection,
            Err(error) => {
                emit(
                    &out,
                    epoch,
                    generation,
                    Update::Stopped(format!("信令未启用：{error}"), true),
                );
                return Ok(None);
            }
        };
        let mut inbox = Signaling::new(db_connection);
        let member_id = inbox.member_id().to_owned();
        if !emit(
            &out,
            epoch,
            generation,
            Update::Listening(member_id.clone()),
        ) {
            return Ok(None);
        }
        let mut peer: Option<EnterprisePeer> = None;
        let mut events: Option<tokio::sync::mpsc::Receiver<PeerEvent>> = None;
        #[cfg(feature = "experimental-enterprise-media")]
        let mut media_events: Option<async_channel::Receiver<crate::call_bridge::Notice>> = None;
        #[cfg(feature = "experimental-enterprise-files")]
        let mut files_attached = false;
        let mut invitations = Vec::<Invitation>::new();
        let mut opened = false;
        let mut awaiting_answer = false;
        let mut ticker = tokio::time::interval(Duration::from_secs(4));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut expiry = tokio::time::interval(Duration::from_secs(1));
        let reason = loop {
            #[cfg(feature = "experimental-enterprise-files")]
            if !files_attached && let Some(peer) = peer.as_mut() {
                match peer.attach_files(generation).await {
                    Ok((handle, notices)) => {
                        if out
                            .try_send((epoch, Event::FileTools(generation, handle, notices)))
                            .is_err()
                        {
                            break "文件界面未接收会话，正在停止。".into();
                        }
                        files_attached = true;
                    }
                    Err(error) => break format!("文件通道未建立：{error}"),
                }
            }
            #[cfg(feature = "experimental-enterprise-media")]
            if media_events.is_none()
                && let Some(peer) = peer.as_mut()
                && let (Some(handle), Some(states)) =
                    (peer.media_handle(), peer.media_capture_state())
            {
                if out
                    .try_send((
                        epoch,
                        Event::MediaTools(generation, peer.lease_observer(), handle, states),
                    ))
                    .is_err()
                {
                    break "媒体界面未接收会话，已停止。".into();
                }
                media_events = peer.take_media_events();
            }
            tokio::select! {
                biased;
                _ = &mut stop => break "聊天停止请求已处理。".to_owned(),
                notice = async {
                    #[cfg(feature = "experimental-enterprise-media")]
                    if let Some(events) = media_events.as_ref() { return events.recv().await.ok(); }
                    std::future::pending::<Option<crate::call_bridge::Notice>>().await
                } => {
                    #[cfg(feature = "experimental-enterprise-media")]
                    if let Some(notice) = notice {
                        if out.try_send((epoch, Event::Media(generation, notice))).is_err() { break "媒体界面缓冲已满，已请求停止。".into(); }
                    } else { break "媒体状态通道已关闭，正在确认会话停止。".into(); }
                    #[cfg(not(feature = "experimental-enterprise-media"))]
                    let _ = notice;
                }
                _ = expiry.tick() => {
                    if session.ensure_current().is_err() { break "登录已过期，聊天已停止接收新操作。".into(); }
                    if peer.as_ref().is_some_and(|peer| !peer.lease_active()) { break "成员有效性检查已失效，聊天已停止接收新操作。".into(); }
                }
                event = async {
                    match events.as_mut() {
                        Some(events) => events.recv().await,
                        None => std::future::pending().await,
                    }
                } => {
                    match event {
                        Some(PeerEvent::Open) => {
                            let Some(peer) = peer.as_ref().filter(|p| p.lease_active()) else { break "成员会话已失效。".into(); };
                            opened = true;
                            if !emit(&out, epoch, generation, Update::Open(peer.lease_observer())) { break "聊天界面不再接收事件。".into(); }
                        }
                        Some(PeerEvent::Text(text)) if opened => {
                            let Some(peer) = peer.as_ref().filter(|p| p.lease_active()) else { break "成员会话已失效，旧消息已丢弃。".into(); };
                            if !emit(&out, epoch, generation, Update::Text(text, peer.lease_observer())) { break "聊天界面消息缓冲已满。".into(); }
                        }
                        #[cfg(feature = "experimental-enterprise-files")]
                        Some(PeerEvent::Binary(bytes)) => {
                            let Some(peer) = peer.as_ref() else { break "文件通道未建立。".into(); };
                            if let Err(error) = peer.file_binary(bytes) { peer.transport_closed(); break format!("文件数据未接收：{error}"); }
                        }
                        Some(PeerEvent::Closed) | None => { if let Some(peer) = peer.as_ref() { peer.transport_closed(); } break "对端或本地通道已关闭。".into(); },
                        Some(PeerEvent::State(state)) if matches!(state.as_str(), "failed" | "disconnected" | "closed") => { if let Some(peer) = peer.as_ref() { peer.transport_closed(); } break "聊天连接已中断。".into(); },
                        _ => {}
                    }
                }
                request = commands.recv() => {
                    let Ok(request) = request else { break "聊天面板已关闭。".into(); };
                    if session.ensure_current().is_err() { break "登录已过期。".into(); }
                    match request {
                        Action::Invite(recipient) if peer.is_none() => {
                            if recipient == member_id || !members.iter().any(|m| m.id == recipient && !m.pending) { break "接收者不在已验证的可用成员列表中。".into(); }
                            let result = async {
                                let connection = connection(session.clone(), &slug).await?;
                                EnterprisePeer::invite(connection, &recipient, vec![]).await
                            }.await;
                            match result {
                                Ok((next, next_events)) => { peer = Some(next); events = Some(next_events); awaiting_answer = true; invitations.clear(); if !emit(&out, epoch, generation, Update::Negotiating("邀请已提交，等待对方明确接受；尚未连通。".into())) { break "聊天界面已关闭。".into(); } }
                                Err(error) => break format!("邀请未完成：{error}。不会自动重复发送。"),
                            }
                        }
                        Action::Accept(id) if peer.is_none() => {
                            if !invitations.iter().any(|invitation| invitation.id == id) { break "该邀请不在最近真实列表中，请重新启用并检查。".into(); }
                            let result = async {
                                let connection = connection(session.clone(), &slug).await?;
                                EnterprisePeer::accept(connection, &id, vec![]).await
                            }.await;
                            match result {
                                Ok((next, next_events)) => { peer = Some(next); events = Some(next_events); invitations.clear(); if !emit(&out, epoch, generation, Update::Negotiating("已接受并提交应答，等待真实聊天通道连通。".into())) { break "聊天界面已关闭。".into(); } }
                                Err(error) => break format!("接受未完成：{error}。不会自动重复提交。"),
                            }
                        }
                        Action::Reject(id) if peer.is_none() => {
                            if !invitations.iter().any(|invitation| invitation.id == id) { break "该邀请不在最近真实列表中。".into(); }
                            match inbox.reject(&id).await {
                                Ok(()) => { invitations.retain(|i| i.id != id); if !emit(&out, epoch, generation, Update::Rejected) { break "聊天界面已关闭。".into(); } }
                                Err(error) => break format!("拒绝未确认：{error}。不会自动重复提交。"),
                            }
                        }
                        Action::Send(operation, text) if opened => {
                            if text.trim().is_empty() || text.len() > MAX_TEXT_BYTES { break "消息为空或超过 16 KiB，未发送。".into(); }
                            let Some(peer) = peer.as_ref() else { break "聊天通道不可用。".into(); };
                            match peer.send_text(&text).await {
                                Ok(()) => { if !emit(&out, epoch, generation, Update::Queued(operation, text, peer.lease_observer())) { break "聊天界面已关闭。".into(); } }
                                Err(error) => break format!("消息未确认交给通道：{error}"),
                            }
                        }
                        _ => break "聊天操作已过期或与当前状态不符。".into(),
                    }
                }
                _ = ticker.tick() => {
                    if let Some(peer) = peer.as_mut() {
                        if awaiting_answer {
                            match peer.poll_answer().await {
                                Ok(true) => { awaiting_answer = false; if !emit(&out, epoch, generation, Update::Negotiating("应答已验证，等待真实聊天通道连通。".into())) { break "聊天界面已关闭。".into(); } }
                                Ok(false) => {}
                                Err(error) => break format!("邀请协商已停止：{error}"),
                            }
                        }
                    } else {
                        match inbox.inbox().await {
                            Ok(rows) => {
                                invitations = rows.into_iter().map(|row| Invitation {
                                    name: members.iter().find(|m| m.id == row.sender).map(|m| m.name.clone()).unwrap_or_else(|| row.sender.clone()),
                                    id: row.id, sender: row.sender,
                                }).collect();
                                if !emit(&out, epoch, generation, Update::Inbox(invitations.clone())) { break "聊天界面已关闭。".into(); }
                            }
                            Err(error) => break format!("邀请列表不可用：{error}"),
                        }
                    }
                }
            }
        };
        // 先解除 on_close 的有界事件队列背压，再等待通道确认；不 abort 已创建的 Peer。
        drop(events.take());
        let closed = match peer.take() {
            Some(peer) => match peer.close().await {
                Ok(outcome) => {
                    let locally_closed = outcome.local_closed;
                    #[cfg(feature = "experimental-enterprise-files")]
                    let locally_closed = locally_closed
                        && outcome
                            .file_closure
                            .as_ref()
                            .is_none_or(crate::enterprise_files::FileClosure::confirmed);
                    // 文件回执由独立FileTools原身份archive保存；关闭失败不能被聊天成功掩盖。
                    if locally_closed {
                        Ok(outcome.remote_end_error)
                    } else {
                        Err(outcome
                            .local_close_error
                            .unwrap_or_else(|| "本地通道或文件清理未确认关闭".into()))
                    }
                }
                Err(error) => Err(error),
            },
            None => Ok(None),
        };
        let message = match &closed {
            Ok(None) => reason,
            Ok(Some(warning)) => format!("{reason} 本地通道已关闭；远端结束状态未确认：{warning}"),
            Err(error) => format!("{reason} 聊天关闭未确认：{error}。请退出应用确认断开。"),
        };
        emit(
            &out,
            epoch,
            generation,
            Update::Stopped(message, closed.is_ok()),
        );
        closed
    }

    fn send_action(
        state: Signal<IdentityViewState>,
        sender: &async_channel::Sender<Command>,
        action: Action,
    ) {
        let mut next = state.get_untracked();
        if next.phase != Phase::Ready || !next.signed_in || !next.directory.can_chat {
            return;
        }
        let generation = match &action {
            Action::Enable => match next.chat.enable() {
                Some(value) => value,
                None => return,
            },
            Action::Stop => next.chat.stop(),
            Action::Send(_, _) => {
                if next.chat.phase != ChatPhase::Connected || next.chat.busy {
                    return;
                }
                next.chat.busy = true;
                next.chat.generation
            }
            _ => {
                if !next.chat.can_choose() {
                    return;
                }
                next.chat.busy = true;
                next.chat.status = "正在处理这次明确选择，请等待；不会重复提交。".into();
                next.chat.generation
            }
        };
        if sender
            .try_send(Command::Chat(next.epoch, generation, action))
            .is_err()
        {
            next.chat.apply(
                generation,
                Update::Stopped("企业聊天后台不可用，关闭未确认。".into(), false),
            );
        }
        state.set(next);
    }
    pub(super) fn panel(
        state: Signal<IdentityViewState>,
        commands: async_channel::Sender<Command>,
        stop_tools: impl Fn() + Copy + 'static,
    ) -> impl IntoElement {
        let enable = commands.clone();
        let stop = commands.clone();
        let invite = commands.clone();
        let accept = commands.clone();
        let reject = commands.clone();
        view().gap_2().p_3().border_1().border_color(move || nsh_base::theme().border)
            .child(text("实验 · 企业成员文字聊天"))
            .child(text("默认关闭，需要已配置的原生登录和已部署的 061/062。仅直连本地候选，无内置 STUN/TURN；不包含音视频、文件或离线消息。"))
            .child(text("点击启用才连接信令。邀请会向所选成员分享本次网络候选；只有双方明确操作后协商。成员撤销按周期检查，非即时撤销。"))
            .child(text(move || if !state.get().directory.can_chat {
                "需要已验证的当前 participant 工作区；Owner/system 身份不能冒充成员。".to_owned()
            } else { state.get().chat.status }))
            .child(view().flex_row().gap_2()
                .child(ui::action("启用实验文字聊天", move || { let s=state.get(); s.phase != Phase::Ready || !s.directory.can_chat || s.chat.phase != ChatPhase::Off }, move || send_action(state, &enable, Action::Enable)))
                .child(ui::action("停止实验聊天", move || matches!(state.get().chat.phase, ChatPhase::Off | ChatPhase::Stopping | ChatPhase::CloseFailed), move || { stop_tools(); send_action(state, &stop, Action::Stop); })))
            .child(when(move || state.get().chat.phase == ChatPhase::Listening, move || {
                let invite = invite.clone(); let accept = accept.clone(); let reject = reject.clone();
                view().gap_2().child(text("选择真实成员发送邀请"))
                    .child(virtual_list(move || state.get().directory.chat_members.len(), move |at| {
                        let invite = invite.clone();
                        view().flex_row().gap_2()
                            .child(text(move || state.get().directory.chat_members.get(at.index()).map(|m| if m.pending {format!("{}（待加入）",m.name)} else {m.name.clone()}).unwrap_or_default()).flex_1())
                            .child(ui::action("邀请此成员", move || { let s=state.get(); !s.chat.can_choose() || s.directory.chat_members.get(at.index()).is_none_or(|m| m.pending || m.id==s.chat.member_id) }, move || {
                                let s=state.get_untracked(); if let Some(member)=s.directory.chat_members.get(at.index()).filter(|m| !m.pending && m.id!=s.chat.member_id) { send_action(state,&invite,Action::Invite(member.id.clone())); }
                            }))
                    }).estimated_item_size(px(54.0)).h(px(130.0)))
                    .child(text("收到的邀请（来自真实服务，未自动接受）"))
                    .child(when(move || state.get().chat.invitations.is_empty(), || text("当前没有可见邀请。")))
                    .child(virtual_list(move || state.get().chat.invitations.len(), move |at| {
                        view().gap_2().child(text(move || state.get().chat.invitations.get(at.index()).map(|i|format!("{} · {}",i.name,i.sender)).unwrap_or_default()))
                            .child(ui::action("查看邀请详情",move || !state.get().chat.can_choose(),move || {
                                state.update(|s| { if s.chat.can_choose() { s.chat.selected_invitation=s.chat.invitations.get(at.index()).cloned(); } });
                            }))
                    }).estimated_item_size(px(85.0)).h(px(180.0)))
                    .child(when(move || state.get().chat.selected_invitation.is_some(), move || {
                        let accept=accept.clone(); let reject=reject.clone();
                        view().gap_2().child(text(move || state.get().chat.selected_invitation.as_ref().map(|i|format!("确认这次邀请：{} · {} · {}",i.name,i.sender,i.id)).unwrap_or_default()))
                            .child(view().flex_row().gap_2()
                                .child(ui::action("接受已选邀请",move || !state.get().chat.can_choose(),move || { if let Some(i)=state.get_untracked().chat.selected_invitation {send_action(state,&accept,Action::Accept(i.id));} }))
                                .child(ui::action("拒绝已选邀请",move || !state.get().chat.can_choose(),move || { if let Some(i)=state.get_untracked().chat.selected_invitation {send_action(state,&reject,Action::Reject(i.id));} })))
                    }))
            }))
            .child(when(move || matches!(state.get().chat.phase, ChatPhase::Connected | ChatPhase::Negotiating), move || {
                let commands=commands.clone();
                view().gap_2()
                    .child(virtual_list(move || state.get().chat.messages.len(), move |at| text(move || state.get().chat.messages.get(at.index()).cloned().unwrap_or_default())).estimated_item_size(px(32.0)).h(px(160.0)))
                    .child(nsh_base::input().value(move || state.get().chat.draft).on_change(move |value:&str| state.update(|s|s.chat.draft=value.to_owned())).placeholder("文字消息，最多 16 KiB").px_3().py_3().border_1())
                    .child(ui::action("发送企业消息",move || {let s=state.get(); s.chat.phase!=ChatPhase::Connected || s.chat.busy || s.chat.draft.trim().is_empty() || s.chat.draft.len()>MAX_TEXT_BYTES},move || {
                        let mut s=state.get_untracked(); if s.chat.phase!=ChatPhase::Connected || s.chat.busy || s.chat.draft.trim().is_empty() || s.chat.draft.len()>MAX_TEXT_BYTES {return;}
                        s.chat.operation=s.chat.operation.wrapping_add(1); let operation=s.chat.operation; let text=s.chat.draft.clone();state.set(s);
                        send_action(state,&commands,Action::Send(operation,text));
                    }))
            }))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[component]
        fn StopToolsFixture() -> impl IntoElement {
            let mut fixture = IdentityViewState::new(true);
            fixture.phase = Phase::Ready;
            fixture.signed_in = true;
            fixture.directory.can_chat = true;
            fixture.chat.phase = ChatPhase::Connected;
            fixture.chat.generation = 7;
            let state = signal(fixture);
            let stopped_before_generation_change = signal(false);
            let (commands, receiver) = async_channel::unbounded();
            let _receiver = stored(receiver);
            view()
                .child(panel(state, commands, move || {
                    stopped_before_generation_change
                        .set(state.get_untracked().chat.generation == 7);
                }))
                .child(text(move || {
                    format!(
                        "local-stop-first:{} generation:{}",
                        stopped_before_generation_change.get(),
                        state.get().chat.generation
                    )
                }))
        }
        #[test]
        fn stop_button_invalidates_tools_before_advancing_generation() -> Result<(), String> {
            use nsh_engine::{EngineConfig, Root};
            let mut app =
                nsh_testing::Headless::start(EngineConfig::new(Root::of::<StopToolsFixture>()))
                    .unwrap();
            app.wait_for("停止实验聊天")?;
            app.press("停止实验聊天")?;
            app.wait_for("text:local-stop-first:true generation:8")?;
            Ok(())
        }

        fn listening() -> ViewState {
            let mut state = ViewState::default();
            let generation = state.enable().unwrap();
            state.apply(generation, Update::Listening("user:fixture".into()));
            state
        }
        #[test]
        fn enterprise_chat_never_calls_authentication_or_offer_connected() {
            let mut state = listening();
            assert_eq!(state.phase, ChatPhase::Listening);
            state.apply(
                state.generation,
                Update::Open(LeaseObserver::test_only(true)),
            );
            assert_eq!(state.phase, ChatPhase::Listening);
            state.apply(state.generation, Update::Negotiating("等待应答".into()));
            assert_eq!(state.phase, ChatPhase::Negotiating);
            state.apply(
                state.generation,
                Update::Open(LeaseObserver::test_only(true)),
            );
            assert_eq!(state.phase, ChatPhase::Connected);
        }
        #[test]
        fn enterprise_chat_stop_invalidates_old_generation_and_clears_private_text() {
            let mut state = listening();
            let old = state.generation;
            state.draft = "未发送".into();
            state.messages.push("旧会话".into());
            let next = state.stop();
            assert!(state.draft.is_empty());
            assert!(state.messages.is_empty());
            state.apply(old, Update::Open(LeaseObserver::test_only(true)));
            state.apply(
                old,
                Update::Inbox(vec![Invitation {
                    id: "old".into(),
                    sender: "user:a".into(),
                    name: "旧邀请".into(),
                }]),
            );
            assert_eq!(state.phase, ChatPhase::Stopping);
            assert!(state.invitations.is_empty());
            state.apply(next, Update::Stopped("未确认".into(), false));
            assert_eq!(state.phase, ChatPhase::CloseFailed);
            assert_eq!(state.enable(), None);
        }
        #[test]
        fn enterprise_chat_invitation_refresh_never_substitutes_confirmed_target() {
            let mut state = listening();
            let first = Invitation {
                id: "first".into(),
                sender: "user:a".into(),
                name: "A".into(),
            };
            let second = Invitation {
                id: "second".into(),
                sender: "user:b".into(),
                name: "B".into(),
            };
            state.selected_invitation = Some(first.clone());
            state.apply(
                state.generation,
                Update::Inbox(vec![second.clone(), first.clone()]),
            );
            assert_eq!(state.selected_invitation, Some(first));
            state.apply(state.generation, Update::Inbox(vec![second]));
            assert!(state.selected_invitation.is_none());
        }
        #[tokio::test]
        async fn enterprise_chat_drop_receiver_releases_close_callback_backpressure() {
            let (sender, receiver) = tokio::sync::mpsc::channel::<PeerEvent>(1);
            sender.send(PeerEvent::Open).await.unwrap();
            let callback = tokio::spawn(async move { sender.send(PeerEvent::Closed).await });
            tokio::task::yield_now().await;
            assert!(!callback.is_finished());
            drop(receiver);
            assert!(
                tokio::time::timeout(Duration::from_secs(1), callback)
                    .await
                    .unwrap()
                    .unwrap()
                    .is_err()
            );
        }
        #[test]
        fn enterprise_chat_send_ack_does_not_clear_newer_draft_or_operation() {
            let mut state = listening();
            state.apply(state.generation, Update::Negotiating("协商".into()));
            state.apply(
                state.generation,
                Update::Open(LeaseObserver::test_only(true)),
            );
            state.operation = 2;
            state.busy = true;
            state.draft = "新草稿".into();
            state.apply(
                state.generation,
                Update::Queued(1, "旧消息".into(), LeaseObserver::test_only(true)),
            );
            assert!(state.busy);
            assert!(state.messages.is_empty());
            state.apply(
                state.generation,
                Update::Queued(2, "已发送".into(), LeaseObserver::test_only(true)),
            );
            assert!(!state.busy);
            assert_eq!(state.draft, "新草稿");
            assert_eq!(state.messages, vec!["我（已交给通道）：已发送"]);
        }
        #[test]
        fn enterprise_chat_identity_epoch_and_expiry_reject_late_open() {
            let mut state = IdentityViewState::new(true);
            let id = state.begin_login();
            state.apply(id, Event::Ready(DirectoryView::default(), "已验证".into()));
            state.chat = listening();
            state
                .chat
                .apply(state.chat.generation, Update::Negotiating("协商".into()));
            let generation = state.chat.generation;
            state.clear(state.next_epoch(), "已退出".into());
            state.apply(
                id,
                Event::Chat(generation, Update::Open(LeaseObserver::test_only(true))),
            );
            assert!(!state.signed_in);
            assert_eq!(state.chat.phase, ChatPhase::Off);
            assert!(state.chat.member_id.is_empty());
        }
        #[test]
        fn enterprise_chat_revoked_observer_rejects_queued_open_text_and_send_ack() {
            for event in [
                Update::Open(LeaseObserver::test_only(false)),
                Update::Text("不应显示".into(), LeaseObserver::test_only(false)),
                Update::Queued(1, "不应显示".into(), LeaseObserver::test_only(false)),
            ] {
                let mut state = listening();
                state.apply(state.generation, Update::Negotiating("协商".into()));
                state.apply(
                    state.generation,
                    Update::Open(LeaseObserver::test_only(true)),
                );
                state.messages.push("旧消息".into());
                state.draft = "旧草稿".into();
                state.operation = 1;
                state.apply(state.generation, event);
                assert_eq!(state.phase, ChatPhase::Stopping);
                assert!(state.messages.is_empty());
                assert!(state.draft.is_empty());
            }
        }
        #[tokio::test]
        async fn enterprise_chat_remote_end_warning_does_not_lock_confirmed_local_close() {
            let (commands, _requests) = async_channel::bounded(1);
            let (stop, stopped) = oneshot::channel();
            let task = tokio::spawn(async move {
                let _ = stopped.await;
                Ok(Some("远端邀请已过期".into()))
            });
            let mut slot = Slot {
                worker: Some(Worker {
                    generation: 1,
                    commands,
                    stop,
                    task,
                }),
                close_error: None,
            };
            let result = shutdown(&mut slot).await;
            assert_eq!(result, Ok(Some("远端邀请已过期".into())));
            assert!(close_message("切换已完成".into(), result).contains("本地通道已关闭"));
            assert!(slot.close_error.is_none());
            assert_eq!(shutdown(&mut slot).await, Ok(None));
        }
        #[test]
        fn enterprise_chat_owner_directory_does_not_enable_record_identity() {
            let workspace = Workspace {
                slug: "fixture".into(),
                name: "夹具".into(),
                db_name: "ws_fixture".into(),
                role: WorkspaceRole::Admin,
                last_selected_at: None,
            };
            let mut view = DirectoryView::default();
            view.select(
                &workspace,
                vec![Member {
                    id: "user:fixture".into(),
                    display_name: None,
                    email: "fixture@invalid.local".into(),
                    is_admin: true,
                    pending: false,
                }],
            );
            assert!(!view.can_chat);
            assert_eq!(view.chat_members.len(), 1);
        }
        #[tokio::test]
        async fn enterprise_chat_shutdown_awaits_cleanup_and_latches_uncertain_close() {
            use std::sync::atomic::{AtomicBool, Ordering};
            let cleaned = Arc::new(AtomicBool::new(false));
            let observed = cleaned.clone();
            let (commands, _requests) = async_channel::bounded(1);
            let (stop, stopped) = oneshot::channel();
            let task = tokio::spawn(async move {
                let _ = stopped.await;
                tokio::task::yield_now().await;
                observed.store(true, Ordering::SeqCst);
                Err("仅测试的关闭未确认".into())
            });
            let mut slot = Slot {
                worker: Some(Worker {
                    generation: 1,
                    commands,
                    stop,
                    task,
                }),
                close_error: None,
            };
            assert!(shutdown(&mut slot).await.is_err());
            assert!(cleaned.load(Ordering::SeqCst));
            assert!(slot.worker.is_none());
            assert!(shutdown(&mut slot).await.is_err());
            assert!(
                close_message("已退出".into(), Err("关闭未确认".into()))
                    .contains("请退出应用确认断开")
            );
        }
    }
}
