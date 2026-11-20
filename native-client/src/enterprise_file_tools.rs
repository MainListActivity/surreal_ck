//! 企业文件UI：每次绑定使用独立NSH子owner；私有关闭回执由常驻owner结算。
//! 不把进度队列或入队结果当完成，不将旧身份路径自动展示给下一身份。
use crate::{
    bridge::Command,
    enterprise_files::{FileClosure, FileHandle, FileNotice, FileSession},
    file_ui::{FileScope, Files},
};
use nsh_core::prelude::*;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use surreal_ck_peer_transport::transfer::{CancelOutcome, Event};
use tokio::sync::{Semaphore, mpsc::Receiver};

const MAX_PRIVATE_RECEIPTS: usize = 16;
#[derive(Clone, Copy, PartialEq, Eq)]
struct Key {
    epoch: u64,
    generation: u64,
}
struct ReceiptSlot {
    key: Key,
    session: FileSession,
    result: Option<FileClosure>,
}
#[derive(Default)]
struct Receipts(Vec<ReceiptSlot>);
impl Receipts {
    fn reserve(&mut self, key: Key, session: FileSession) -> Result<(), String> {
        if self.0.len() >= MAX_PRIVATE_RECEIPTS {
            return Err("已保留16条原会话私有回执，暂不能建立新的文件界面。只能在原身份仍有效时确认清除；不会跨账号显示，也不会自动丢弃旧记录。退出应用会丢失这些仅内存保存的回执。".into());
        }
        if self.0.iter().any(|slot| slot.key == key) {
            return Err("文件界面代次重复，请先结束原会话".into());
        }
        self.0.push(ReceiptSlot {
            key,
            session,
            result: None,
        });
        Ok(())
    }
    fn record(&mut self, key: Key, result: FileClosure) {
        if let Some(slot) = self
            .0
            .iter_mut()
            .find(|slot| slot.key == key && slot.session == result.context.session)
        {
            slot.result = Some(result);
        }
    }
    fn take(&mut self, key: Key) -> Option<FileClosure> {
        let index = self
            .0
            .iter()
            .position(|slot| slot.key == key && slot.result.is_some())?;
        self.0.remove(index).result
    }
}
#[derive(Clone)]
struct Binding {
    key: Key,
    handle: FileHandle,
    scope: FileScope,
    notices: Arc<Mutex<Option<Receiver<FileNotice>>>>,
}
#[derive(Clone, Copy)]
pub(crate) struct FileTools {
    binding: Signal<Option<Binding>>,
    connected: Signal<bool>,
    status: Signal<String>,
    receipts: Stored<Arc<Mutex<Receipts>>>,
    closed: Stored<async_channel::Sender<(Key, FileSession)>>,
    dialog_owner: Owner,
    identity: Signal<Option<u64>>,
    receipt_revision: Signal<u64>,
}
impl FileTools {
    /// 必须在常驻NSH组件owner里创建，不能在Tokio线程创建信号。
    pub(crate) fn new() -> Self {
        let binding: Signal<Option<Binding>> = signal_with(None, SignalEquals::Never);
        let connected = signal(false);
        let status = signal(String::new());
        let identity = signal(None::<u64>);
        let receipt_revision = signal(0_u64);
        let receipts = Arc::new(Mutex::new(Receipts::default()));
        let (closed, input) = async_channel::bounded(MAX_PRIVATE_RECEIPTS);
        let history = receipts.clone();
        spawn(async move {
            while let Ok((key, session)) = input.recv().await {
                receipt_revision.set(receipt_revision.get_untracked().wrapping_add(1));
                let Some(current) = binding.get_untracked() else {
                    continue;
                };
                if current.key != key || current.handle.session() != session {
                    continue;
                }
                connected.set(false);
                let history = history.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(closed) = history
                    .0
                    .iter()
                    .find(|slot| slot.key == key)
                    .and_then(|slot| slot.result.as_ref())
                {
                    status.set(if closed.confirmed() {
                        format!(
                            "文件通道已关闭。原会话确认保存 {} 个文件；已保存文件不会撤回。",
                            closed.committed().len()
                        )
                    } else {
                        "文件关闭尚未确认，原会话源副本与私有回执已保留；不能声称传输已安全停止。"
                            .into()
                    });
                }
            }
        });
        Self {
            binding,
            connected,
            status,
            receipts: stored(receipts),
            closed: stored(closed),
            dialog_owner: Owner::current(),
            identity,
            receipt_revision,
        }
    }
    pub(crate) fn invalidate(self) {
        self.identity.set(None);
        self.connected.set(false);
        if let Some(binding) = self.binding.get_untracked() {
            binding.scope.invalidate();
            binding.handle.request_stop();
        }
        // 移除旧UI，不把旧路径留在下一账号面板；私有回执槽仍独立保留。
        self.binding.set(None);
        self.status.set(String::new());
    }
    pub(crate) fn bind(
        self,
        epoch: u64,
        generation: u64,
        handle: FileHandle,
        notices: Receiver<FileNotice>,
    ) -> Result<(), String> {
        self.invalidate();
        let key = Key { epoch, generation };
        let session = handle.session();
        let receipts = self.receipts.get();
        if let Err(error) = receipts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reserve(key, session)
        {
            handle.request_stop();
            return Err(error);
        }
        let check = handle.clone();
        let stop = handle.clone();
        let scope = FileScope::new(move || check.is_active(), move || stop.request_stop());
        let saved_scope = scope.clone();
        let saved_receipts = receipts.clone();
        let closed = self.closed.get();
        // 这个结算任务由FileHandle的Tokio owner启动，不随NSH子owner销毁而取消。
        handle.observe_closed(move |result| {
            saved_scope.settle(result.confirmed());
            saved_receipts
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .record(key, result);
            // 入显示队列不是交付；原回执已先保存在有界私有槽，发送失败也不丢事实。
            let _ = closed.try_send((key, session));
        });
        self.identity.set(Some(epoch));
        self.binding.set(Some(Binding {
            key,
            handle,
            scope,
            notices: Arc::new(Mutex::new(Some(notices))),
        }));
        self.status
            .set("企业文件 · 实验功能；文件发送和接收都需要明确确认。".into());
        Ok(())
    }
    /// 仅由主身份owner确认仍是原账号/工作区后调用；logout/login/switch不得保留此门。
    pub(crate) fn retain_identity(self, epoch: u64) {
        self.identity.set(Some(epoch));
    }
    pub(crate) fn opened(self, epoch: u64, generation: u64) {
        self.connected
            .set(self.binding.get_untracked().is_some_and(|binding| {
                binding.key == Key { epoch, generation } && binding.scope.is_current()
            }));
    }
    /// 原身份主owner必须结算；取走后由调用者负责保留，不能向下一身份自动展示。
    pub(crate) fn take_closure(self, epoch: u64, generation: u64) -> Option<FileClosure> {
        let result = self
            .receipts
            .get()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take(Key { epoch, generation });
        if result.is_some() {
            self.receipt_revision
                .set(self.receipt_revision.get_untracked().wrapping_add(1));
        }
        result
    }
    fn receipts_view(self) -> impl IntoElement {
        dynamic(move || {
            let Some(epoch) = self.identity.get() else {
                return view().into_element();
            };
            let _ = self.receipt_revision.get();
            let receipts = self.receipts.get();
            let rows: Vec<_> = receipts
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .0
                .iter()
                .filter(|slot| slot.key.epoch == epoch)
                .filter_map(|slot| slot.result.clone().map(|result| (slot.key, result)))
                .collect();
            let mut output = view().gap_2();
            for (key, closure) in rows {
                let label = if closure.confirmed() {
                    "文件关闭已确认"
                } else {
                    "文件关闭未确认；可能已有文件保存，不能据此判定没有保存"
                };
                let mut card = view()
                    .gap_2()
                    .child(text(format!("原会话 {}：{label}", key.generation)));
                for saved in closure.committed() {
                    let label = match &saved.destination {
                        Some(path) => format!("已校验并保存：{}", path.display()),
                        None => format!("对方已确认保存文件（传输 {}）", saved.id),
                    };
                    card = card.child(text(label));
                }
                if let Some(reason) = &closure.stop_reason {
                    card = card.child(text(reason.clone()));
                }
                if let Some(error) = &closure.cleanup_error {
                    card = card.child(text(error.clone()));
                }
                if let Err(error) = &closure.result {
                    card = card.child(text(error.clone())).child(text(
                        "以上仅为已确认的保存结果，清单可能不完整，也可能另有文件已经保存。",
                    ));
                }
                card = card.child(text("确认只清除这条内存回执，不会删除已保存文件。"));
                card = card.child(crate::ui::action(
                    "已查看，清除该回执",
                    move || self.identity.get() != Some(key.epoch),
                    move || {
                        if self.identity.get_untracked() == Some(key.epoch) {
                            let _ = self.take_closure(key.epoch, key.generation);
                        }
                    },
                ));
                output = output.child(card);
            }
            output.into_element()
        })
    }
    pub(crate) fn view(self) -> impl IntoElement {
        view()
            .child(text(move || self.status.get()))
            .child(self.receipts_view())
            .child(dynamic(move || {
                let Some(binding) = self.binding.get() else { return view().into_element(); };
                let files = Files::new_scoped(binding.scope.clone(), self.dialog_owner);
                let (commands, input) = async_channel::bounded(16);
                let cleanup_scope = binding.scope.clone();
                let cleanup_handle = binding.handle.clone();
                let cleanup_commands = commands.clone();
                cleanup(move || {
                    cleanup_scope.invalidate();
                    cleanup_handle.request_stop();
                    cleanup_commands.close();
                });
                let terminal = Arc::new(Mutex::new(HashMap::<String, Event>::new()));
                let notices = binding.notices.lock().unwrap_or_else(|e| e.into_inner()).take();
                if let Some(mut notices) = notices {
                    let event_binding = binding.clone();
                    let event_terminal = terminal.clone();
                    spawn(async move {
                        while let Some(notice) = notices.recv().await {
                            if !notice.context.is_current(event_binding.handle.session()) || !event_binding.scope.is_current() {continue;}
                            match &notice.event {
                                Event::Completed {id,..} | Event::Cancelled {id} => {
                                    // core每会话最多256个ID；只用于防止offered回复晚于真实终态。
                                    event_terminal.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), notice.event.clone());
                                }
                                _ => {},
                            }
                            event_binding.scope.apply_if_current(|| files.event(notice.event));
                        }
                    });
                }
                let ordinary = Arc::new(Semaphore::new(4));
                let cancellations = Arc::new(Semaphore::new(1));
                spawn(async move {
                    while let Ok(command) = input.recv().await {
                        if !binding.scope.is_current() {continue;}
                        let cancelling = matches!(command, Command::CancelFile(_));
                        let permit = if cancelling {cancellations.clone()} else {ordinary.clone()}.try_acquire_owned();
                        let Ok(permit) = permit else {
                            if cancelling {binding.scope.invalidate();}
                            files.failed();
                            files.info(if cancelling {"取消操作繁忙，文件会话已请求停止；等待关闭回执。"} else {"文件操作繁忙，尚未启动新操作。"}.into());
                            continue;
                        };
                        let operation_binding = binding.clone();
                        let operation_terminal = terminal.clone();
                        spawn(async move {
                            let _permit = permit;
                            let result = match command {
                                Command::OfferFile(path) => {
                                    let reply = operation_binding.handle.offer_confirmed(path).await;
                                    if !reply.context.is_current(operation_binding.handle.session()) || !operation_binding.scope.is_current() {return;}
                                    match reply.result {
                                        Ok(id) => {
                                            files.offered(id.clone());
                                            if let Some(event) = operation_terminal.lock().unwrap_or_else(|e| e.into_inner()).get(&id).cloned() {files.event(event);}
                                            Ok(())
                                        },
                                        Err(error) => Err(error),
                                    }
                                },
                                Command::AcceptFile(id, path) => operation_binding.handle.accept_confirmed(id, path).await.result,
                                Command::RejectFile(id) => operation_binding.handle.reject(id).await.result,
                                Command::CancelFile(id) => match operation_binding.handle.cancel(id).await.result {
                                    Ok(CancelOutcome::CommitInProgress) => {if operation_binding.scope.is_current() {files.info("保存发布已先行开始，不能承诺撤回；等待真实保存回执。".into());} Ok(())},
                                    Ok(CancelOutcome::PublicationUncertain {message}) => Err(message),
                                    Ok(CancelOutcome::NotActive) => Err("没有对应的活动文件传输".into()),
                                    Ok(_) => Ok(()), // 真实终态事件/关闭账本负责更新，不伪造完成。
                                    Err(error) => Err(error),
                                },
                                _ => Err("企业文件界面拒绝非文件命令".into()),
                            };
                            if operation_binding.scope.is_current() && let Err(error) = result {
                                files.failed();
                                files.info(format!("文件操作未完成：{error}"));
                            }
                        });
                    }
                });
                view().child(files.panel(commands, self.connected)).into_element()
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_generation_is_required_for_private_receipt_lookup() {
        assert!(
            Key {
                epoch: 7,
                generation: 1
            } != Key {
                epoch: 8,
                generation: 1
            }
        );
        assert!(
            Key {
                epoch: 7,
                generation: 1
            } != Key {
                epoch: 7,
                generation: 2
            }
        );
    }
}
