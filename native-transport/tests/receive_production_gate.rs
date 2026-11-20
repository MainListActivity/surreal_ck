//! 集成测试链接非cfg(test)的生产library，防止候选测试适配意外启用生产能力。
#[test]
fn production_receive_capability_stays_fail_closed_on_unvalidated_desktops() {
    assert_eq!(
        surreal_ck_peer_transport::transfer::receive_supported(),
        cfg!(any(target_os = "linux", target_os = "android"))
    );
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[tokio::test]
async fn production_accept_still_rejects_before_creating_any_file() {
    use sha2::{Digest, Sha256};
    use std::{sync::Arc, time::Duration};
    use surreal_ck_peer_transport::{
        chat::Chat,
        transfer::{Event, Transfer},
        Route,
    };
    use tokio::sync::mpsc;

    let (chat, chat_events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
    let chat = Arc::new(chat);
    let (events_tx, mut events) = mpsc::channel(8);
    let transfer = Transfer::new(chat.clone(), events_tx);
    // 真实协议OFFER，仅测试生产stub，不需要网络成功或调用私有测试后端。
    let id = [0x42; 16];
    let name = b"gate.bin";
    let mut offer = b"CKF1".to_vec();
    offer.push(1);
    offer.extend(id);
    offer.extend(0u64.to_be_bytes());
    offer.extend(Sha256::digest(b""));
    offer.extend((name.len() as u16).to_be_bytes());
    offer.extend(name);
    transfer.handle_binary(&offer).await.unwrap();
    let Event::Offer { id, .. } = tokio::time::timeout(Duration::from_secs(5), events.recv())
        .await
        .unwrap()
        .unwrap()
    else {
        panic!("expected a pending offer");
    };
    let target = std::env::temp_dir().join(format!(
        "surreal-production-disabled-{}-{}.bin",
        std::process::id(),
        id
    ));
    assert!(!target.exists());
    let error = transfer.accept(&id, target.clone()).await.unwrap_err();
    assert!(
        error.contains("secure file receiving is not supported"),
        "{error}"
    );
    assert!(!target.exists());
    transfer.shutdown().await.unwrap();
    drop(chat_events);
    chat.close().await.unwrap();
}
