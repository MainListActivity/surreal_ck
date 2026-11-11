//! 文件传输必须由用户选择源文件、确认发送，并由接收方选择新目标路径。
use crate::{bridge::Command, ui};
use nsh_base::theme;
use nsh_core::prelude::*;
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use surreal_ck_peer_transport::transfer::Event;
// 企业作用域独立于NSH信号，后台关闭回执可以安全结算源副本。
#[derive(Clone)]
pub(crate) struct FileScope(Arc<FileScopeInner>);
struct FileScopeInner {
    live: AtomicBool,
    check: Box<dyn Fn() -> bool + Send + Sync>,
    stop: Box<dyn Fn() + Send + Sync>,
    release: Box<dyn Fn(PathBuf) + Send + Sync>,
    sources: Mutex<Sources>,
}
#[derive(Default)]
struct Sources {
    selected: HashSet<PathBuf>,
    transport: HashSet<PathBuf>,
    settled: bool,
}
impl FileScope {
    #[cfg(feature = "experimental-enterprise-files")]
    pub(crate) fn new(
        check: impl Fn() -> bool + Send + Sync + 'static,
        stop: impl Fn() + Send + Sync + 'static,
    ) -> Self {
        Self::with_release(check, stop, crate::file_dialogs::release_source)
    }
    #[cfg(any(test, feature = "experimental-enterprise-files"))]
    fn with_release(
        check: impl Fn() -> bool + Send + Sync + 'static,
        stop: impl Fn() + Send + Sync + 'static,
        release: impl Fn(PathBuf) + Send + Sync + 'static,
    ) -> Self {
        Self(Arc::new(FileScopeInner {
            live: AtomicBool::new(true),
            check: Box::new(check),
            stop: Box::new(stop),
            release: Box::new(release),
            sources: Mutex::new(Sources::default()),
        }))
    }
    pub(crate) fn is_current(&self) -> bool {
        self.0.live.load(Ordering::SeqCst) && (self.0.check)()
    }
    #[cfg(any(test, feature = "experimental-enterprise-files"))]
    pub(crate) fn apply_if_current<R>(&self, action: impl FnOnce() -> R) -> Option<R> {
        self.is_current().then(action)
    }
    fn selected(&self, path: PathBuf) -> bool {
        let (retained, release) = {
            let mut state = self.0.sources.lock().unwrap_or_else(|e| e.into_inner());
            if self.is_current() && !state.settled {
                if !state.transport.contains(&path) {
                    state.selected.insert(path.clone());
                }
                (true, false)
            } else {
                state.selected.remove(&path);
                // 迟到picker可能返回同一路径；仍被transport持有时绝不能提前释放。
                (false, !state.transport.contains(&path))
            }
        };
        if release {
            (self.0.release)(path);
        }
        retained
    }
    fn release_selected(&self, path: PathBuf) {
        let release = {
            let mut state = self.0.sources.lock().unwrap_or_else(|e| e.into_inner());
            state.selected.remove(&path) && !state.transport.contains(&path)
        };
        if release {
            (self.0.release)(path);
        }
    }
    // 发送入队前保留源，后台可能立即开始读取；返回值用于入队失败的窄回滚。
    fn admit(&self, path: &PathBuf) -> Result<bool, ()> {
        let mut state = self.0.sources.lock().unwrap_or_else(|e| e.into_inner());
        if !self.is_current() || state.settled {
            return Err(());
        }
        if state.transport.contains(path) {
            return Ok(false);
        }
        if state.transport.len() >= 256 || !state.selected.remove(path) {
            return Err(());
        }
        state.transport.insert(path.clone());
        Ok(true)
    }
    fn not_submitted(&self, path: PathBuf, newly_pinned: bool) {
        if !newly_pinned {
            return;
        }
        let release = {
            let mut state = self.0.sources.lock().unwrap_or_else(|e| e.into_inner());
            state.transport.remove(&path);
            if self.is_current() && !state.settled {
                state.selected.insert(path.clone());
                false
            } else {
                true
            }
        };
        if release {
            (self.0.release)(path);
        }
    }
    pub(crate) fn invalidate(&self) {
        self.0.live.store(false, Ordering::SeqCst);
        (self.0.stop)();
        let selected = {
            let mut state = self.0.sources.lock().unwrap_or_else(|e| e.into_inner());
            state.selected.drain().collect::<Vec<_>>()
        };
        for path in selected {
            (self.0.release)(path);
        }
    }
    #[cfg(any(test, feature = "experimental-enterprise-files"))]
    pub(crate) fn settle(&self, confirmed: bool) {
        self.invalidate();
        if !confirmed {
            return;
        } // 不能用关闭请求或失败回执假设transport已读完。
        let paths = {
            let mut state = self.0.sources.lock().unwrap_or_else(|e| e.into_inner());
            state.settled = true;
            state.transport.drain().collect::<Vec<_>>()
        };
        for path in paths {
            (self.0.release)(path);
        }
    }
}
fn current(scope: &Option<FileScope>) -> bool {
    scope.as_ref().is_none_or(FileScope::is_current)
}

#[derive(Clone, PartialEq)]
struct Offer {
    id: String,
    name: String,
    size: u64,
}
#[derive(Clone, Copy)]
pub struct Files {
    selected: Signal<Option<PathBuf>>,
    pending: Signal<Option<Offer>>,
    active: Signal<Option<String>>,
    status: Signal<String>,
    choosing: Signal<bool>,
    requesting: Signal<bool>,
    last_received: Signal<Option<PathBuf>>,
    inflight_source: Signal<Option<PathBuf>>,
    has_completed: Signal<bool>,
    scope: Option<Stored<FileScope>>,
    dialog_owner: Option<Owner>,
}
impl Files {
    pub fn new() -> Self {
        Self {
            selected: signal(None),
            pending: signal(None),
            active: signal(None),
            status: signal("没有文件传输".into()),
            choosing: signal(false),
            requesting: signal(false),
            last_received: signal(None),
            inflight_source: signal(None),
            has_completed: signal(false),
            scope: None,
            dialog_owner: None,
        }
    }
    /// 必须在NSH组件owner中创建；picker等待归常驻父owner，面板拆卸不丢其结果。
    #[cfg(feature = "experimental-enterprise-files")]
    pub(crate) fn new_scoped(scope: FileScope, dialog_owner: Owner) -> Self {
        let mut files = Self::new();
        files.scope = Some(stored(scope));
        files.dialog_owner = Some(dialog_owner);
        files
    }
    fn scope(self) -> Option<FileScope> {
        self.scope.map(|scope| scope.get())
    }
    fn permitted(self) -> bool {
        current(&self.scope())
    }
    fn dialog(self, future: impl Future<Output = ()> + 'static) {
        if let Some(owner) = self.dialog_owner {
            owner.run(|| {
                spawn(future);
            });
        } else {
            spawn(future);
        }
    }
    #[cfg(feature = "experimental-enterprise-files")]
    pub(crate) fn info(self, message: String) {
        self.status.set(message);
    }
    fn release_inflight(self) {
        if let Some(path) = self.inflight_source.get_untracked() {
            self.inflight_source.set(None);
            if self.scope.is_none() {
                crate::file_dialogs::release_source(path);
            }
            // 企业源由原scope保留到FileClosure.confirmed，不能仅凭UI终态提前释放。
        }
    }
    pub fn cleanup(self) {
        if let Some(scope) = self.scope() {
            scope.invalidate();
            return;
        }
        self.release_inflight();
        if let Some(path) = self.selected.get_untracked() {
            self.selected.set(None);
            crate::file_dialogs::release_source(path);
        }
    }
    pub fn failed(self) {
        self.requesting.set(false);
    }
    pub fn offered(self, id: String) {
        self.requesting.set(false);
        self.active.set(Some(id));
        self.inflight_source.set(self.selected.get_untracked());
        self.selected.set(None);
        self.status
            .set("等待对方确认接收，尚未发送文件内容。".into());
    }
    pub fn disconnected(self) {
        self.release_inflight();
        self.requesting.set(false);
        self.pending.set(None);
        self.active.set(None);
        self.status
            .set(disconnected_status(self.has_completed.get_untracked()).into());
    }
    pub fn event(self, event: Event) {
        match event {
            Event::Offer { id, name, size } => {
                self.pending.set(Some(Offer { id, name, size }));
                self.status.set(
                    if !crate::file_dialogs::can_receive() {
                        crate::file_dialogs::receive_unavailable_reason()
                    } else if !crate::file_dialogs::receive_size_supported(size) {
                        crate::file_dialogs::RECEIVE_TOO_LARGE
                    } else if cfg!(target_os = "android") {
                        "对方请求发送文件。点击接收后才会保存到本应用私有文件区。"
                    } else {
                        "对方请求发送文件。确认保存位置后才会接收内容。"
                    }
                    .into(),
                );
            }
            Event::Progress { id, done, total } => {
                self.pending.set(None);
                self.active.set(Some(id));
                self.status.set(format!(
                    "已传输 {} / {} 字节，仍待完整校验确认",
                    done, total
                ));
            }
            Event::Completed { id, destination } => {
                self.has_completed.set(true);
                if let Some(path) = destination.as_ref() {
                    self.last_received.set(Some(path.clone()));
                }
                if self.active.get_untracked().as_deref() == Some(&id) {
                    self.release_inflight();
                    self.active.set(None)
                }
                self.pending.set(None);
                self.status.set(
                    if destination.is_some() {
                        if cfg!(target_os = "android") && self.scope.is_some() {
                            "已校验并保存到应用私有区；尚未导出。"
                        } else if cfg!(target_os = "android") {
                            "已校验并保存到应用文件区；可另行导出。"
                        } else {
                            "已校验并保存文件，不会自动打开。"
                        }
                    } else {
                        "对方已校验并保存文件。"
                    }
                    .into(),
                );
            }
            Event::Cancelled { id } => {
                if self.active.get_untracked().as_deref() == Some(&id) {
                    self.release_inflight();
                    self.active.set(None)
                }
                self.pending.set(None);
                self.status.set(
                    "本地文件传输已停止；已保存的文件不会撤回，对端最终结果以确认回执为准。".into(),
                );
            }
            Event::Error { id, message } => {
                if id.as_deref() == self.active.get_untracked().as_deref() && id.is_some() {
                    self.release_inflight();
                }
                self.requesting.set(false);
                self.active.set(None);
                self.status.set(format!("文件传输失败：{message}"));
            }
        }
    }
    pub fn panel(
        self,
        commands: async_channel::Sender<Command>,
        connected: Signal<bool>,
    ) -> impl IntoElement {
        let choose = self;
        let send = commands.clone();
        let accept = commands.clone();
        let reject = commands.clone();
        let cancel = commands;
        view()
            .gap_2()
            .p_3()
            .border_1()
            .border_color(move || theme().border)
            .rounded(move || theme().radius)
            .child(text("文件传输").text_size(px(16.0)))
            .child(when(
                || crate::file_dialogs::available() && !crate::file_dialogs::can_receive(),
                || text(crate::file_dialogs::RECEIVE_UNAVAILABLE),
            ))
            .child(text(move || self.status.get()).text_color(move || theme().muted_foreground))
            .child(when(
                || !crate::file_dialogs::available(),
                || {
                    text(if crate::file_dialogs::available() {
                        "Android接收会保存到应用私有文件区；导出是单独的用户操作。"
                    } else {
                        "Android系统文件宿主未启用，文件发送与接收暂不可用。"
                    })
                },
            ))
            .child(
                view()
                    .flex_row()
                    .gap_2()
                    .child(ui::action(
                        "选择文件",
                        move || {
                            !connected.get()
                                || self.choosing.get()
                                || self.requesting.get()
                                || self.active.get().is_some()
                                || !crate::file_dialogs::available()
                        },
                        move || {
                            let scope = choose.scope();
                            if !current(&scope) { return; }
                            choose.choosing.set(true);
                            choose.dialog(async move {
                                let picked = crate::file_dialogs::select_source().await;
                                if !current(&scope) {
                                    if let Ok(Some(path)) = picked {
                                        if let Some(scope) = &scope { scope.selected(path); }
                                        else { crate::file_dialogs::release_source(path); }
                                    }
                                    return;
                                }
                                match picked {
                                    Ok(Some(path)) => {
                                        if let Some(scope) = &scope && !scope.selected(path.clone()) { return; }
                                        if let Some(previous) = choose.selected.get_untracked() {
                                            if let Some(scope) = &scope { scope.release_selected(previous); }
                                            else { crate::file_dialogs::release_source(previous); }
                                        }
                                        choose.selected.set(Some(path));
                                        choose
                                            .status
                                            .set("尚未发送。请确认文件后点击发送文件。".into());
                                    }
                                    Ok(None) => {}
                                    Err(error) => {
                                        choose.status.set(format!("无法选择文件：{error}"))
                                    }
                                }
                                choose.choosing.set(false);
                            });
                        },
                    ))
                    .child(ui::action(
                        "发送文件",
                        move || {
                            !connected.get()
                                || self.selected.get().is_none()
                                || self.requesting.get()
                                || self.active.get().is_some()
                        },
                        move || {
                            if !self.permitted() { return; }
                            if let Some(path) = self.selected.get_untracked() {
                                let scope = self.scope();
                                let pinned = match scope.as_ref().map(|scope| scope.admit(&path)).transpose() {
                                    Ok(value) => value,
                                    Err(()) => { if self.permitted() { self.status.set("当前文件会话已停止或保留源文件达到上限，请结束会话后重试。".into()); } return; }
                                };
                                if send.try_send(Command::OfferFile(path.clone())).is_err() {
                                    if let (Some(scope), Some(pinned)) = (&scope, pinned) { scope.not_submitted(path, pinned); }
                                    self.status.set("操作队列已满，请重试。".into())
                                } else {
                                    self.requesting.set(true);
                                    self.status.set("正在计算校验值并请求对方确认…".into());
                                }
                            }
                        },
                    )),
            )
            .child(text(move || {
                self.selected
                    .get()
                    .and_then(|p| {
                        p.file_name()
                            .map(|s| format!("待发送：{}", s.to_string_lossy()))
                    })
                    .unwrap_or_default()
            }))
            .child(when(
                move || self.pending.get().is_some(),
                move || {
                    let accept = accept.clone();
                    let reject = reject.clone();
                    view()
                        .gap_2()
                        .child(text(move || {
                            self.pending
                                .get()
                                .map(|o| format!("接收请求：{} · {} 字节", o.name, o.size))
                                .unwrap_or_default()
                        }))
                        .child(
                            view()
                                .flex_row()
                                .gap_2()
                                .child(ui::action(
                                    if cfg!(target_os = "android") {
                                        "接收到应用文件区"
                                    } else {
                                        "选择位置并接收"
                                    },
                                    move || {
                                        self.choosing.get()
                                            || !connected.get()
                                            || !crate::file_dialogs::can_receive()
                                            || self.pending.get().is_some_and(|offer| {
                                                !crate::file_dialogs::receive_size_supported(
                                                    offer.size,
                                                )
                                            })
                                    },
                                    move || {
                                        if !self.permitted() { return; }
                                        if !crate::file_dialogs::can_receive() {
                                            self.status.set(
                                                crate::file_dialogs::RECEIVE_UNAVAILABLE.into(),
                                            );
                                            return;
                                        }
                                        if let Some(offer) = self.pending.get_untracked() {
                                            if !crate::file_dialogs::receive_size_supported(
                                                offer.size,
                                            ) {
                                                self.status.set(
                                                    crate::file_dialogs::RECEIVE_TOO_LARGE.into(),
                                                );
                                                return;
                                            }
                                            let accept = accept.clone();
                                            let scope = self.scope();
                                            self.choosing.set(true);
                                            self.dialog(async move {
                                                let destination = crate::file_dialogs::receive_destination(&offer.id, &offer.name).await;
                                                if !current(&scope) { return; }
                                                match destination {
                                                    Ok(Some(path)) => {
                                                        if accept
                                                            .try_send(Command::AcceptFile(
                                                                offer.id.clone(),
                                                                path,
                                                            ))
                                                            .is_ok()
                                                        {
                                                            self.active.set(Some(offer.id));
                                                        } else {
                                                            self.status.set(
                                                                "操作队列已满，请重试。".into(),
                                                            );
                                                        }
                                                    }
                                                    Ok(None) => {}
                                                    Err(error) => self
                                                        .status
                                                        .set(format!("无法选择保存位置：{error}")),
                                                }
                                                self.choosing.set(false);
                                            });
                                        }
                                    },
                                ))
                                .child(ui::action(
                                    "拒绝",
                                    move || self.pending.get().is_none(),
                                    move || {
                                        if self.permitted() && let Some(offer) = self.pending.get_untracked()
                                            && reject
                                                .try_send(Command::RejectFile(offer.id))
                                                .is_ok()
                                        {
                                            self.pending.set(None)
                                        }
                                    },
                                )),
                        )
                },
            ))
            .child(when(
                move || cfg!(target_os = "android") && self.scope.is_some() && self.last_received.get().is_some(),
                || text("企业文件已保存到应用私有区，尚未导出。原生导出流程还不能在账号切换后阻止迟到写入，本实验暂不开放导出。"),
            ))
            .child(when(
                move || cfg!(target_os = "android") && self.scope.is_none() && self.last_received.get().is_some(),
                move || {
                    ui::action(
                        "导出已接收文件",
                        move || self.choosing.get(),
                        move || {
                            if let Some(path) = self.last_received.get_untracked() {
                                self.choosing.set(true);
                                spawn(async move {
                                    match crate::file_dialogs::export(path).await {
                                        Ok(true) => self
                                            .status
                                            .set("已导出到你选择的位置，应用内副本仍保留。".into()),
                                        Ok(false) => self
                                            .status
                                            .set("导出已取消，已接收的应用内副本仍保留。".into()),
                                        Err(error) => self
                                            .status
                                            .set(format!("导出失败（应用内副本仍保留）：{error}")),
                                    }
                                    self.choosing.set(false);
                                });
                            }
                        },
                    )
                },
            ))
            .child(when(
                move || self.active.get().is_some(),
                move || {
                    let cancel = cancel.clone();
                    ui::action(
                        "取消传输",
                        move || self.active.get().is_none(),
                        move || {
                            if self.permitted() && let Some(id) = self.active.get_untracked()
                                && cancel.try_send(Command::CancelFile(id)).is_err()
                            {
                                if let Some(scope) = self.scope() { scope.invalidate(); self.status.set("取消队列已满，文件会话已请求停止；等待真实关闭回执。".into()); }
                                else { self.status.set("取消队列已满，请重试。".into()); }
                            }
                        },
                    )
                },
            ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nsh_engine::{EngineConfig, Root};
    use nsh_testing::Headless;
    fn source_scope() -> (FileScope, Arc<Mutex<Vec<PathBuf>>>) {
        let released = Arc::new(Mutex::new(Vec::new()));
        let output = released.clone();
        (
            FileScope::with_release(
                || true,
                || {},
                move |path| output.lock().unwrap().push(path),
            ),
            released,
        )
    }
    #[test]
    fn invalidated_picker_result_is_released_without_becoming_selected() {
        let (scope, released) = source_scope();
        scope.invalidate();
        assert!(!scope.selected(PathBuf::from("late-saf-source")));
        assert_eq!(
            *released.lock().unwrap(),
            vec![PathBuf::from("late-saf-source")]
        );
        assert!(scope.0.sources.lock().unwrap().selected.is_empty());
    }
    #[test]
    fn transport_sources_wait_for_confirmed_closure_and_are_released_once() {
        let (scope, released) = source_scope();
        let path = PathBuf::from("inflight-saf-source");
        assert!(scope.selected(path.clone()));
        assert_eq!(scope.admit(&path), Ok(true));
        scope.invalidate();
        scope.settle(false);
        assert!(released.lock().unwrap().is_empty());
        scope.settle(true);
        scope.settle(true);
        assert_eq!(*released.lock().unwrap(), vec![path]);
    }
    #[test]
    fn late_picker_alias_of_transport_source_waits_for_confirmed_shutdown() {
        let (scope, released) = source_scope();
        let path = PathBuf::from("same-inflight-saf-path");
        assert!(scope.selected(path.clone()));
        scope.admit(&path).unwrap();
        scope.invalidate();
        assert!(!scope.selected(path.clone()));
        assert!(released.lock().unwrap().is_empty());
        scope.settle(false);
        assert!(released.lock().unwrap().is_empty());
        scope.settle(true);
        assert_eq!(*released.lock().unwrap(), vec![path]);
    }
    #[test]
    fn rejected_queue_admission_can_release_unstarted_source() {
        let (scope, released) = source_scope();
        let path = PathBuf::from("not-started");
        assert!(scope.selected(path.clone()));
        let pinned = scope.admit(&path).unwrap();
        scope.invalidate();
        assert!(released.lock().unwrap().is_empty());
        scope.not_submitted(path.clone(), pinned);
        assert_eq!(*released.lock().unwrap(), vec![path]);
    }
    #[test]
    fn old_scope_notice_cannot_apply_to_new_files_state() {
        let (old, _) = source_scope();
        let (new, _) = source_scope();
        old.invalidate();
        let mut new_files_status = String::from("新会话没有文件传输");
        assert!(
            old.apply_if_current(|| new_files_status = "旧会话错误完成".into())
                .is_none()
        );
        assert_eq!(new_files_status, "新会话没有文件传输");
        assert!(
            new.apply_if_current(|| new_files_status = "当前会话待确认".into())
                .is_some()
        );
        assert_eq!(new_files_status, "当前会话待确认");
    }
    #[test]
    fn reselecting_a_pinned_path_does_not_release_it_during_invalidation() {
        let (scope, released) = source_scope();
        let path = PathBuf::from("same-source");
        assert!(scope.selected(path.clone()));
        scope.admit(&path).unwrap();
        assert!(scope.selected(path.clone()));
        scope.invalidate();
        assert!(released.lock().unwrap().is_empty());
        scope.settle(true);
        assert_eq!(*released.lock().unwrap(), vec![path]);
    }

    #[component]
    fn IncomingRequest() -> impl IntoElement {
        let files = Files::new();
        files.event(Event::Offer {
            id: "request-1".into(),
            name: "合同.pdf".into(),
            size: 4096,
        });
        let (tx, _rx) = async_channel::bounded(1);
        files.panel(tx, signal(true))
    }
    #[test]
    fn incoming_request_requires_explicit_destination_and_consent() -> Result<(), String> {
        let mut app = Headless::start(EngineConfig::new(Root::of::<IncomingRequest>())).unwrap();
        app.wait_for("接收请求：合同.pdf · 4096 字节")?;
        app.wait_for(if cfg!(target_os = "android") {
            "接收到应用文件区"
        } else {
            "选择位置并接收"
        })?;
        if !crate::file_dialogs::can_receive() {
            app.wait_for(crate::file_dialogs::receive_unavailable_reason())?;
        }
        app.wait_for("拒绝")?;
        assert!(!app.shows(if cfg!(target_os = "android") {
            "已校验并保存到应用文件区；可另行导出。"
        } else {
            "已校验并保存文件，不会自动打开。"
        }));
        Ok(())
    }
}

fn disconnected_status(has_completed: bool) -> &'static str {
    if has_completed {
        "连接已关闭；已确认完成的文件保留，停止不会撤回或删除它们。未完成文件不算成功。"
    } else {
        "连接已关闭，未完成文件不会标为成功。"
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::disconnected_status;
    #[test]
    fn disconnect_never_retracts_an_already_completed_file() {
        assert!(disconnected_status(true).contains("不会撤回或删除"));
        assert!(disconnected_status(false).contains("不会标为成功"));
    }
}
