//! Windows 原生组件的合并重绘通知：无像素队列，最多一个尚未消费的 wake。
use crate::{FrameReceiver, FrameUpdate};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

pub(crate) struct RedrawWatch {
    pending: Arc<AtomicBool>,
    stop: Arc<(Mutex<bool>, Condvar)>,
    worker: Option<JoinHandle<()>>,
}
impl RedrawWatch {
    /// wake 只能通知 UI，不能持有 COM/AppKit/GTK 对象、执行 I/O 或阻塞。
    pub(crate) fn new(
        mut receiver: FrameReceiver,
        wake: impl Fn() + Send + 'static,
    ) -> std::io::Result<Self> {
        let pending = Arc::new(AtomicBool::new(false));
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        let gate = pending.clone();
        let cancel = stop.clone();
        let worker = thread::Builder::new()
            .name("native-video-wake".into())
            .spawn(move || {
                loop {
                    if *cancel.0.lock().unwrap_or_else(|p| p.into_inner()) {
                        break;
                    }
                    let update = receiver.poll();
                    let closed = matches!(update, FrameUpdate::Closed);
                    if !matches!(update, FrameUpdate::Unchanged)
                        && !gate.swap(true, Ordering::AcqRel)
                    {
                        wake();
                    }
                    // 通知线程绝不保留像素；真实 UI 的接收端会读取最新快照。
                    drop(update);
                    if closed {
                        break;
                    }
                    let lock = cancel.0.lock().unwrap_or_else(|p| p.into_inner());
                    let _ = cancel
                        .1
                        .wait_timeout_while(lock, Duration::from_millis(16), |stopped| !*stopped)
                        .unwrap_or_else(|p| p.into_inner());
                }
            })?;
        Ok(Self {
            pending,
            stop,
            worker: Some(worker),
        })
    }

    /// 在 UI 读取邮箱之前调用；即使一次窗口绘制包含多次刷新也不会累积任务。
    pub(crate) fn acknowledge(&self) {
        self.pending.store(false, Ordering::Release);
    }
}
impl Drop for RedrawWatch {
    fn drop(&mut self) {
        *self.stop.0.lock().unwrap_or_else(|p| p.into_inner()) = true;
        self.stop.1.notify_all();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FrameHub, RgbaFrame};
    use bytes::Bytes;
    use std::sync::atomic::AtomicUsize;
    use std::time::Instant;

    fn wait_for(mut predicate: impl FnMut() -> bool) {
        let until = Instant::now() + Duration::from_secs(2);
        while !predicate() {
            assert!(Instant::now() < until, "notification deadline");
            thread::sleep(Duration::from_millis(1));
        }
    }
    fn frame() -> RgbaFrame {
        RgbaFrame::packed(1, 1, Bytes::from_static(&[0, 0, 0, 255])).unwrap()
    }

    #[test]
    fn slow_ui_has_only_one_outstanding_redraw() {
        let hub = FrameHub::default();
        let publisher = hub.open().unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let called = count.clone();
        let watcher = RedrawWatch::new(hub.subscribe(publisher.id()).unwrap(), move || {
            called.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        publisher.present(frame()).unwrap();
        wait_for(|| count.load(Ordering::SeqCst) == 1);
        for _ in 0..100 {
            publisher.present(frame()).unwrap();
        }
        thread::sleep(Duration::from_millis(60));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        watcher.acknowledge();
        publisher.present(frame()).unwrap();
        wait_for(|| count.load(Ordering::SeqCst) == 2);
    }
    #[test]
    fn dropping_component_stops_notifications_promptly() {
        let hub = FrameHub::default();
        let publisher = hub.open().unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let called = count.clone();
        let watcher = RedrawWatch::new(hub.subscribe(publisher.id()).unwrap(), move || {
            called.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        drop(watcher);
        publisher.present(frame()).unwrap();
        thread::sleep(Duration::from_millis(32));
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn closing_stream_notifies_even_without_any_video_frame() {
        let hub = FrameHub::default();
        let publisher = hub.open().unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let called = count.clone();
        let _watcher = RedrawWatch::new(hub.subscribe(publisher.id()).unwrap(), move || {
            called.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        publisher.close();
        wait_for(|| count.load(Ordering::SeqCst) == 1);
    }
}
