use super::*;
use crate::chat::{ChatClient, ChatError, ChatEvent, ChatStatus, MessageCursor};
use tokio::sync::{broadcast, watch};

async fn client(fixture: &ForkFixture, name: &str, config: &SurrealConfig) -> ChatClient {
    ChatClient::connect(
        &fixture.client,
        fixture.session(name, "ws_signal").await,
        config,
        "ws_signal",
    )
    .await
    .unwrap()
}

async fn event(
    events: &mut broadcast::Receiver<ChatEvent>,
    predicate: impl Fn(&ChatEvent) -> bool,
) -> ChatEvent {
    timeout(Duration::from_secs(10), async {
        loop {
            let event = events.recv().await.unwrap();
            if predicate(&event) {
                return event;
            }
            if let ChatEvent::Ended(error) = event {
                panic!("chat ended before expected event: {error}");
            }
        }
    })
    .await
    .expect("expected chat event")
}

pub(crate) struct Proxy {
    pub(crate) config: SurrealConfig,
    pub(crate) paused: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}
impl Proxy {
    pub(crate) async fn start(backend: &SurrealConfig) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint =
            url::Url::parse(&format!("ws://{}/rpc", listener.local_addr().unwrap())).unwrap();
        let backend = format!(
            "{}:{}",
            backend.endpoint.host_str().unwrap(),
            backend.endpoint.port().unwrap()
        );
        let (paused, mut state) = watch::channel(false);
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept()=>{
                        let (mut incoming,_)=accepted.unwrap();
                        if *state.borrow() {continue;}
                        let mut state=state.clone();
                        let backend=backend.clone();
                        connections.spawn(async move {
                            let mut outgoing=tokio::net::TcpStream::connect(backend).await.unwrap();
                            tokio::select! { _=tokio::io::copy_bidirectional(&mut incoming,&mut outgoing)=>{}, _=state.changed()=>{} }
                        });
                    }
                    _=state.changed()=>{},
                    Some(_)=connections.join_next()=>{},
                }
            }
        });
        Self {
            config: SurrealConfig {
                endpoint,
                namespace: "local".into(),
            },
            paused,
            task,
        }
    }
}
impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test]
#[ignore = "requires SURREAL_TEST_BINARY verified fork; local-only API integration"]
async fn real_fork_chat_client_api_and_reconnect() {
    let mut fixture = fixture().await;
    let proxy = Proxy::start(&fixture.config).await;
    let alice = client(&fixture, "a", &proxy.config).await;
    let bob = client(&fixture, "b", &fixture.config).await;
    let carol = client(&fixture, "c", &fixture.config).await;
    assert!(alice.conversations().await.unwrap().is_empty());
    assert_eq!(
        alice.open_direct("invalid").await.unwrap_err(),
        ChatError::Input
    );
    let mut events = alice.subscribe();
    let direct = bob.open_direct("user:a").await.unwrap();
    assert_eq!(direct, alice.open_direct("user:b").await.unwrap());
    let group = carol
        .create_group("Team", &["user:a".into()])
        .await
        .unwrap();
    event(
        &mut events,
        |v| matches!(v,ChatEvent::Membership{conversation,joined:true} if conversation==&group),
    )
    .await;
    let first = bob.send(&direct, "private", "bob-1").await.unwrap();
    let other = carol.send(&group, "group", "carol-1").await.unwrap();
    let mut ids = std::collections::HashSet::new();
    while ids.len() < 2 {
        if let ChatEvent::Message(message) =
            event(&mut events, |v| matches!(v, ChatEvent::Message(_))).await
        {
            ids.insert(message.id);
        }
    }
    assert!(ids.contains(&first.id) && ids.contains(&other.id));
    let rooms = alice.conversations().await.unwrap();
    let private = rooms.iter().find(|v| v.id == direct).unwrap();
    assert_eq!(private.member_count, 2);
    assert_eq!(alice.snapshot().member_id, "user:a");
    assert_eq!(private.peer.as_ref().unwrap().id, "user:b");
    assert_eq!(
        private.peer.as_ref().unwrap().display_name,
        "b@invalid.local"
    );
    assert_eq!(private.unread_count, 1);
    assert_eq!(
        rooms.iter().find(|v| v.id == group).unwrap().unread_count,
        1
    );
    alice.mark_read(&direct).await.unwrap();
    assert_eq!(
        bob.send(&direct, "private", "bob-1").await.unwrap().id,
        first.id
    );
    assert_eq!(
        alice
            .conversations()
            .await
            .unwrap()
            .iter()
            .find(|v| v.id == direct)
            .unwrap()
            .unread_count,
        0
    );
    assert_eq!(alice.messages(&direct, None, 20).await.unwrap().len(), 1);
    assert!(bob.messages(&group, None, 20).await.unwrap().is_empty());
    assert_eq!(
        bob.send(&direct, "different body", "bob-1")
            .await
            .unwrap_err(),
        ChatError::Input
    );
    assert_eq!(
        bob.send(&direct, " ", "bad").await.unwrap_err(),
        ChatError::Input
    );
    let second = bob.send(&direct, "second", "bob-2").await.unwrap();
    let page = alice.messages(&direct, None, 1).await.unwrap();
    assert_eq!(page[0].id, second.id);
    let previous = alice
        .messages(
            &direct,
            Some(MessageCursor {
                created_at: page[0].created_at.clone(),
                id: page[0].id.clone(),
            }),
            1,
        )
        .await
        .unwrap();
    assert_eq!(previous[0].id, first.id);

    let title = "user:payload";
    let own = bob.create_group(title, &[]).await.unwrap();
    assert_eq!(
        bob.conversations()
            .await
            .unwrap()
            .iter()
            .find(|v| v.id == own)
            .unwrap()
            .title
            .as_deref(),
        Some(title)
    );
    for (body, client_id) in [
        ("user:payload", "550e8400-e29b-41d4-a716-446655440000"),
        ("2026-01-01T00:00:00Z", "user:payload"),
        ("550e8400-e29b-41d4-a716-446655440000", "日期-客户端"),
    ] {
        let receipt = bob.send(&own, body, client_id).await.unwrap();
        assert_eq!(receipt.body, body);
        assert_eq!(receipt.client_id, client_id);
        assert_eq!(
            bob.send(&own, body, client_id).await.unwrap().id,
            receipt.id
        );
    }

    let mut owner = fixture.connection("c", "ws_signal").await.socket;
    assert_eq!(rows(&query(&mut owner,"DELETE chat_member WHERE conversation=type::record($room) AND user=user:a RETURN BEFORE;",json!({"room":group})).await).len(),1);
    event(
        &mut events,
        |v| matches!(v,ChatEvent::Membership{conversation,joined:false} if conversation==&group),
    )
    .await;
    assert!(alice.messages(&group, None, 20).await.unwrap().is_empty());

    proxy.paused.send_replace(true);
    event(&mut events, |v| matches!(v, ChatEvent::Reconnecting { .. })).await;
    let missed1 = bob
        .send(&direct, "offline one", "bob-offline-1")
        .await
        .unwrap();
    let missed2 = bob
        .send(&direct, "offline two", "bob-offline-2")
        .await
        .unwrap();
    proxy.paused.send_replace(false);
    let mut recovered = std::collections::HashSet::new();
    while recovered.len() < 2 {
        if let ChatEvent::Message(message)=event(&mut events,|v|matches!(v,ChatEvent::Message(message) if message.id==missed1.id || message.id==missed2.id)).await {
            assert!(recovered.insert(message.id),"duplicate recovery event");
        }
    }
    assert_eq!(alice.messages(&direct, None, 20).await.unwrap().len(), 4);
    assert_eq!(*alice.status().borrow(), ChatStatus::Connected);
    fixture.revoke("a").await;
    event(&mut events, |v| {
        matches!(v, ChatEvent::Ended(ChatError::Identity))
    })
    .await;
    assert_eq!(
        alice.conversations().await.unwrap_err(),
        ChatError::Identity
    );
    alice.stop().await.unwrap();
    bob.stop().await.unwrap();
    carol.stop().await.unwrap();
}

#[tokio::test]
#[ignore = "requires SURREAL_TEST_BINARY verified fork; local-only expiry test"]
async fn real_fork_chat_client_expiry_and_drop() {
    let fixture = fixture().await;
    let mut session = fixture.session("a", "ws_signal").await;
    Arc::get_mut(&mut session).unwrap().expires_at = crate::auth::unix_now().unwrap() + 2;
    let alice = ChatClient::connect(&fixture.client, session, &fixture.config, "ws_signal")
        .await
        .unwrap();
    let mut events = alice.subscribe();
    event(&mut events, |v| {
        matches!(v, ChatEvent::Ended(ChatError::Expired))
    })
    .await;
    assert_eq!(alice.conversations().await.unwrap_err(), ChatError::Expired);
    drop(alice);
}

#[tokio::test]
#[ignore = "requires SURREAL_TEST_BINARY verified fork; consecutive reconnect regression"]
async fn real_fork_chat_client_reconnect_budget_resets_after_each_recovery() {
    let fixture = fixture().await;
    let proxy = Proxy::start(&fixture.config).await;
    let alice = client(&fixture, "a", &proxy.config).await;
    let bob = client(&fixture, "b", &fixture.config).await;
    let room = bob.open_direct("user:a").await.unwrap();
    let mut events = alice.subscribe();
    for round in 0..7 {
        proxy.paused.send_replace(true);
        if let ChatEvent::Reconnecting { attempt } =
            event(&mut events, |e| matches!(e, ChatEvent::Reconnecting { .. })).await
        {
            assert_eq!(attempt, 1, "reconnect round {round}");
        }
        let missed = bob
            .send(&room, "offline fixture", &format!("round-{round}"))
            .await
            .unwrap();
        proxy.paused.send_replace(false);
        event(
            &mut events,
            |e| matches!(e, ChatEvent::Message(m) if m.id==missed.id),
        )
        .await;
        let mut status = alice.status();
        timeout(Duration::from_secs(10), async {
            while *status.borrow_and_update() != ChatStatus::Connected {
                status.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        assert_eq!(alice.conversations().await.unwrap().len(), 1);
    }
    alice.stop().await.unwrap();
    bob.stop().await.unwrap();
}

#[tokio::test]
#[ignore = "requires SURREAL_TEST_BINARY verified fork; local-only lifecycle test"]
async fn real_fork_chat_client_stop_and_active_drop() {
    let mut fixture = fixture().await;
    let alice = client(&fixture, "a", &fixture.config).await;
    let active = query(&mut fixture.root, "INFO FOR TABLE chat_message;", json!({})).await;
    assert_eq!(active[0]["result"]["lives"].as_object().unwrap().len(), 1);
    alice.stop().await.unwrap();
    let stopped = query(&mut fixture.root, "INFO FOR TABLE chat_message;", json!({})).await;
    assert!(stopped[0]["result"]["lives"]
        .as_object()
        .unwrap()
        .is_empty());
    let bob = client(&fixture, "b", &fixture.config).await;
    let mut status = bob.status();
    drop(bob);
    timeout(Duration::from_secs(5), async {
        loop {
            if *status.borrow_and_update() == ChatStatus::Ended(ChatError::Stopped) {
                break;
            }
            status.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    for table in ["chat_message", "chat_member"] {
        let stopped = query(
            &mut fixture.root,
            &format!("INFO FOR TABLE {table};"),
            json!({}),
        )
        .await;
        assert!(stopped[0]["result"]["lives"]
            .as_object()
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
#[ignore = "requires SURREAL_TEST_BINARY verified fork; unmigrated workspace"]
async fn real_fork_chat_client_reports_chat_not_enabled() {
    let binary = std::env::var("SURREAL_TEST_BINARY").unwrap();
    let fixture = ForkFixture::start(&binary).await;
    let session = fixture.session("a", "ws_signal").await;
    let error = ChatClient::connect(&fixture.client, session, &fixture.config, "ws_signal")
        .await
        .unwrap_err();
    assert_eq!(error, ChatError::NotEnabled);
    assert_eq!(error.to_string(), "工作区尚未启用聊天");
}
