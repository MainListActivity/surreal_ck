#[cfg(test)]
mod enterprise_file_e2e {
    use super::*;
    use crate::enterprise_files::{FileHandle, FileNotice};
    use crate::enterprise_peer::{CloseOutcome, EnterprisePeer};
    use sha2::{Digest, Sha256};
    use std::{
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };
    use surreal_ck_peer_transport::{chat::Event as ChatEvent, transfer::Event as FileEvent};
    use tokio::{
        sync::mpsc::Receiver,
        time::{Duration, Instant, timeout},
    };

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let serial = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "surreal-enterprise-file-e2e-{}-{serial}",
                std::process::id()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn file(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Hold {
        None,
        SavedAck,
        ChunkAck,
    }
    enum Notice {
        A(FileEvent),
        B(FileEvent),
        Pumped,
        Closed,
    }
    struct Pair {
        a: EnterprisePeer,
        b: EnterprisePeer,
        a_chat: Receiver<ChatEvent>,
        b_chat: Receiver<ChatEvent>,
        a_files: FileHandle,
        b_files: FileHandle,
        a_notices: Receiver<FileNotice>,
        b_notices: Receiver<FileNotice>,
        a_chat_done: bool,
        b_chat_done: bool,
        a_notices_done: bool,
        b_notices_done: bool,
        hold: Hold,
        held: Option<Vec<u8>>,
        chunks_to_b: usize,
    }
    async fn opened(events: &mut Receiver<ChatEvent>) {
        timeout(Duration::from_secs(20), async {
            loop {
                match events.recv().await.expect("Open前连接结束") {
                    ChatEvent::Open => break,
                    ChatEvent::Closed => panic!("Open前连接关闭"),
                    ChatEvent::Binary(_) => panic!("用户尚未确认发送，不应已有文件帧"),
                    _ => {}
                }
            }
        })
        .await
        .expect("真实OS UDP候选未建立；禁止VNet/假连接回退");
    }
    impl Pair {
        async fn start(fixture: &signaling::tests::ForkFixture) -> Self {
            let alice = fixture.connection("a", "ws_signal").await;
            let mut bob = fixture.connection("b", "ws_signal").await;
            let (mut a, mut a_chat) = EnterprisePeer::invite(alice, "user:b", vec![])
                .await
                .unwrap();
            let (a_files, a_notices) = a.attach_files(11).await.unwrap();
            let invitations = bob.inbox().await.unwrap();
            assert_eq!(invitations.len(), 1);
            assert_eq!(invitations[0].sender, "user:a");
            let (mut b, mut b_chat) = EnterprisePeer::accept(bob, &invitations[0].id, vec![])
                .await
                .unwrap();
            let (b_files, b_notices) = b.attach_files(22).await.unwrap();
            assert!(a.poll_answer().await.unwrap());
            tokio::join!(opened(&mut a_chat), opened(&mut b_chat));
            assert!(a_files.is_active() && b_files.is_active());
            Self {
                a,
                b,
                a_chat,
                b_chat,
                a_files,
                b_files,
                a_notices,
                b_notices,
                a_chat_done: false,
                b_chat_done: false,
                a_notices_done: false,
                b_notices_done: false,
                hold: Hold::None,
                held: None,
                chunks_to_b: 0,
            }
        }
        // 与宿主一样逐帧调用Peer.file_binary；不注入token、SQL或伪造完成事件。
        async fn step(&mut self) -> Notice {
            loop {
                tokio::select! {
                    event=self.a_chat.recv(), if !self.a_chat_done => match event {
                        Some(ChatEvent::Binary(bytes)) => {
                            let kind = bytes.get(4).copied();
                            let file = bytes.starts_with(b"CKF1");
                            let held = file && ((self.hold == Hold::SavedAck && kind == Some(7)) || (self.hold == Hold::ChunkAck && kind == Some(5)));
                            if held {
                                assert!(self.held.is_none(), "有序协议不应重复等待同一ACK");
                                self.held = Some(bytes);
                            } else if self.a_files.is_active() {
                                self.a.file_binary(bytes).expect("甲文件帧必须按序入队");
                            }
                            return Notice::Pumped;
                        },
                        Some(ChatEvent::Closed) | None => {self.a.transport_closed();self.a_chat_done=true;return Notice::Closed;},
                        _ => {},
                    },
                    event=self.b_chat.recv(), if !self.b_chat_done => match event {
                        Some(ChatEvent::Binary(bytes)) => {
                            if bytes.starts_with(b"CKF1") && bytes.get(4)==Some(&4) {self.chunks_to_b+=1;}
                            if self.b_files.is_active() {self.b.file_binary(bytes).expect("乙文件帧必须按序入队");}
                            return Notice::Pumped;
                        },
                        Some(ChatEvent::Closed) | None => {self.b.transport_closed();self.b_chat_done=true;return Notice::Closed;},
                        _ => {},
                    },
                    notice=self.a_notices.recv(), if !self.a_notices_done => match notice {
                        Some(notice) => {
                            assert_eq!(notice.context.session, self.a_files.session());
                            return Notice::A(notice.event);
                        },
                        None => {self.a_notices_done=true;return Notice::Closed;},
                    },
                    notice=self.b_notices.recv(), if !self.b_notices_done => match notice {
                        Some(notice) => {
                            assert_eq!(notice.context.session, self.b_files.session());
                            return Notice::B(notice.event);
                        },
                        None => {self.b_notices_done=true;return Notice::Closed;},
                    },
                    else => {tokio::task::yield_now().await;return Notice::Closed;},
                }
            }
        }
        async fn incoming_offer(&mut self, id: &str, bytes: u64) {
            timeout(Duration::from_secs(10), async {
                loop {
                    match self.step().await {
                        Notice::B(FileEvent::Offer {
                            id: offered, size, ..
                        }) => {
                            assert_eq!(offered, id);
                            assert_eq!(size, bytes);
                            break;
                        }
                        Notice::A(FileEvent::Error { message, .. })
                        | Notice::B(FileEvent::Error { message, .. }) => {
                            panic!("用户确认前协议失败：{message}")
                        }
                        Notice::Closed => panic!("用户确认前连接关闭"),
                        _ => {}
                    }
                }
            })
            .await
            .expect("未收到真实文件OFFER");
        }
        async fn completed_b(&mut self, id: &str, path: &Path) {
            timeout(Duration::from_secs(20), async {
                loop {
                    match self.step().await {
                        Notice::B(FileEvent::Completed {
                            id: completed,
                            destination,
                        }) => {
                            assert_eq!(completed, id);
                            assert_eq!(destination.as_deref(), Some(path));
                            break;
                        }
                        Notice::A(FileEvent::Completed { .. }) => {
                            panic!("扣留真实保存ACK时发送方不得报告完成")
                        }
                        Notice::A(FileEvent::Error { message, .. })
                        | Notice::B(FileEvent::Error { message, .. }) => {
                            panic!("文件传输失败：{message}")
                        }
                        Notice::Closed => panic!("保存前连接关闭"),
                        _ => {}
                    }
                }
            })
            .await
            .expect("接收方未完成真实保存");
        }
        async fn held_ack(&mut self) {
            timeout(Duration::from_secs(5), async {
                while self.held.is_none() {
                    match self.step().await {
                        Notice::A(FileEvent::Completed { .. }) => panic!("未交付ACK前不得报告完成"),
                        Notice::Closed => panic!("扣留ACK前连接关闭"),
                        _ => {}
                    }
                }
            })
            .await
            .expect("未收到待扣留的真实ACK帧");
        }
        async fn completed_a(&mut self, id: &str) {
            timeout(Duration::from_secs(10), async {
                loop {
                    match self.step().await {
                        Notice::A(FileEvent::Completed {
                            id: completed,
                            destination,
                        }) => {
                            assert_eq!(completed, id);
                            assert!(destination.is_none());
                            break;
                        }
                        Notice::A(FileEvent::Error { message, .. })
                        | Notice::B(FileEvent::Error { message, .. }) => {
                            panic!("最终ACK失败：{message}")
                        }
                        Notice::Closed => panic!("发送方确认前关闭"),
                        _ => {}
                    }
                }
            })
            .await
            .expect("发送方未收到真实保存确认");
        }
        async fn transfer(&mut self, source: PathBuf, destination: PathBuf, data: &[u8]) -> String {
            self.hold = Hold::SavedAck;
            self.held = None;
            let before = self.chunks_to_b;
            // 本地合成fixture显式调用确认API，代替测试中的用户动作；不是OS picker验收。
            let id = self.a_files.offer_confirmed(source).await.result.unwrap();
            self.incoming_offer(&id, data.len() as u64).await;
            assert_eq!(self.chunks_to_b, before);
            assert!(!destination.exists());
            assert!(
                timeout(Duration::from_millis(100), self.step())
                    .await
                    .is_err(),
                "未接受前不应发送内容或完成"
            );
            assert_eq!(self.chunks_to_b, before);
            self.b_files
                .accept_confirmed(id.clone(), destination.clone())
                .await
                .result
                .unwrap();
            self.completed_b(&id, &destination).await;
            let saved = std::fs::read(&destination).unwrap();
            assert_eq!(saved.len(), data.len());
            assert_eq!(Sha256::digest(&saved), Sha256::digest(data));
            assert!(self.chunks_to_b > before);
            self.held_ack().await;
            // 接收方已落盘仍不能把发送方排队当成送达。
            let until = Instant::now() + Duration::from_millis(100);
            while Instant::now() < until {
                if let Ok(notice) =
                    timeout(until.saturating_duration_since(Instant::now()), self.step()).await
                {
                    assert!(
                        !matches!(notice, Notice::A(FileEvent::Completed { .. })),
                        "ACK尚在测试门外"
                    );
                }
            }
            self.hold = Hold::None;
            self.a.file_binary(self.held.take().unwrap()).unwrap();
            self.completed_a(&id).await;
            id
        }
        async fn close(self) -> (CloseOutcome, CloseOutcome) {
            let Self {
                a,
                b,
                a_chat,
                b_chat,
                a_files,
                b_files,
                a_notices,
                b_notices,
                ..
            } = self;
            // 先释放显示接收端，不以队列送达代替真实关闭；防Chat on_close背压。
            drop(a_chat);
            drop(b_chat);
            drop(a_notices);
            drop(b_notices);
            let (a, b) = tokio::join!(a.close(), b.close());
            let a = a.unwrap();
            let b = b.unwrap();
            assert!(
                a.local_closed,
                "甲本地关闭未确认：{:?}",
                a.local_close_error
            );
            assert!(
                b.local_closed,
                "乙本地关闭未确认：{:?}",
                b.local_close_error
            );
            let ar = a.file_closure.as_ref().expect("甲关闭必须保留文件回执");
            let br = b.file_closure.as_ref().expect("乙关闭必须保留文件回执");
            assert!(ar.confirmed() && br.confirmed());
            assert_eq!(ar.result, a_files.closed_receipt().await.result);
            assert_eq!(br.result, b_files.closed_receipt().await.result);
            (a, b)
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "需已验证固定fork及真实OS UDP；不允许VNet或生产连接回退"]
    async fn authenticated_real_udp_file_confirm_hash_and_saved_ack() {
        timeout(Duration::from_secs(90),async {
            let binary=std::env::var("SURREAL_TEST_BINARY").expect("必须明确固定本地fork路径");
            let fixture=signaling::tests::ForkFixture::start(&binary).await;
            let mut pair=Pair::start(&fixture).await;
            let dir=TempDir::new();
            let source=dir.file("source.bin");let destination=dir.file("verified.bin");
            let data:Vec<u8>=(0..1024*1024+37).map(|i|(i%251)as u8).collect();
            std::fs::write(&source,&data).unwrap();
            let id=pair.transfer(source,destination.clone(),&data).await;
            let (a,b)=pair.close().await;
            assert!(a.file_closure.unwrap().committed().iter().any(|file|file.id==id&&file.destination.is_none()));
            assert!(b.file_closure.unwrap().committed().iter().any(|file|file.id==id&&file.destination.as_ref()==Some(&destination)));
            println!("PASS RECORD/company API fixture -> real OS UDP -> Peer.attach_files -> explicit confirmation API -> SHA256 saved file -> actual saved ACK -> confirmed close receipts");
        }).await.expect("真实企业文件回归超时");
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "需已验证固定fork及真实OS UDP；只允许本地fixture管理操作"]
    async fn authenticated_revocation_stops_file_and_retains_previously_saved_receipt() {
        timeout(Duration::from_secs(90),async {
            let binary=std::env::var("SURREAL_TEST_BINARY").expect("必须明确固定本地fork路径");
            let mut fixture=signaling::tests::ForkFixture::start(&binary).await;
            let mut pair=Pair::start(&fixture).await;
            let dir=TempDir::new();
            let source=dir.file("source.bin");let saved=dir.file("already-saved.bin");
            let data:Vec<u8>=(0..128*1024+17).map(|i|(i%239)as u8).collect();
            std::fs::write(&source,&data).unwrap();
            let completed=pair.transfer(source.clone(),saved.clone(),&data).await;
            pair.hold=Hold::ChunkAck;pair.held=None;
            let interrupted=dir.file("must-not-publish.bin");
            let id=pair.a_files.offer_confirmed(source.clone()).await.result.unwrap();
            pair.incoming_offer(&id,data.len() as u64).await;
            pair.b_files.accept_confirmed(id.clone(),interrupted.clone()).await.result.unwrap();
            pair.held_ack().await;
            assert!(!interrupted.exists());
            // root只执行已存在的本地fixture撤销方法；文件/信令业务一直使用真人RECORD身份。
            fixture.revoke("b").await;
            timeout(Duration::from_secs(25),async {
                while pair.a.lease_active() || pair.b.lease_active() {
                    let _=timeout(Duration::from_millis(200),pair.step()).await;
                }
            }).await.expect("成员撤销未在周期重验预算内停止两端");
            assert!(!pair.a_files.is_active()&&!pair.b_files.is_active());
            assert!(pair.a_files.offer_confirmed(source).await.result.is_err());
            assert!(pair.b_files.accept_confirmed(id.clone(),interrupted.clone()).await.result.is_err());
            assert!(!interrupted.exists());
            let (a,b)=pair.close().await;
            let ar=a.file_closure.unwrap();let br=b.file_closure.unwrap();
            assert!(ar.committed().iter().any(|file|file.id==completed));
            assert!(br.committed().iter().any(|file|file.id==completed&&file.destination.as_ref()==Some(&saved)));
            assert!(!ar.committed().iter().any(|file|file.id==id));
            assert!(!br.committed().iter().any(|file|file.id==id));
            assert_eq!(Sha256::digest(std::fs::read(&saved).unwrap()),Sha256::digest(&data));
            assert!(!interrupted.exists());
            println!("PASS local member revocation -> lease invalid -> new file operations refused -> interrupted file not published -> previous committed receipts retained after real close");
        }).await.expect("真实撤销文件回归超时");
    }
}
