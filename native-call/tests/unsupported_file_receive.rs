#![cfg(any(target_os = "macos", target_os = "windows"))]
//! 未适配平台的明确拒绝边界，不计作文件收发或媒体验收。
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use surreal_ck_peer_transport::{
    chat::Chat,
    transfer::{self, Event, Transfer},
    Route,
};

#[tokio::test]
async fn unsupported_platform_rejects_receive_before_creating_or_accepting_file() {
    assert!(!transfer::receive_supported());
    let (chat, _chat_events) = Chat::new(false, Route::Direct, vec![]).await.unwrap();
    let chat = Arc::new(chat);
    let (events, mut received) = tokio::sync::mpsc::channel(4);
    let files = Transfer::new(chat.clone(), events);
    let name = b"fixture.txt";
    let mut packet = b"CKF1".to_vec();
    packet.push(1); // OFFER；只测试协议入口，不建立网络或生成真实文件。
    packet.extend_from_slice(&[0x11; 16]);
    packet.extend_from_slice(&0_u64.to_be_bytes());
    packet.extend_from_slice(&[0_u8; 32]);
    packet.extend_from_slice(&(name.len() as u16).to_be_bytes());
    packet.extend_from_slice(name);
    files.handle_binary(&packet).await.unwrap();
    let id = match received.recv().await.unwrap() {
        Event::Offer { id, .. } => id,
        other => panic!("unexpected offer result: {other:?}"),
    };
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "surreal-unsupported-receive-{}-{nonce}",
        std::process::id()
    ));
    std::fs::create_dir(&directory).unwrap();
    let destination = directory.join("fixture.txt");
    let error = files.accept(&id, destination.clone()).await.unwrap_err();
    assert!(
        error.contains("not supported"),
        "must fail before channel send: {error}"
    );
    assert!(!destination.exists());
    assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
    let _ = files.close().await;
    chat.close().await.unwrap();
    std::fs::remove_dir(directory).unwrap();
}
