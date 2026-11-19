use super::*;
use crate::{
    meeting::{
        fresh_key, MediaState, MeetingClient, MeetingError, MeetingEvent, MeetingState,
        MeetingStatus, SignalKind,
    },
    signaling::tests::chat::api::Proxy,
};
use tokio::sync::broadcast;

async fn client(fixture: &ForkFixture, name: &str, config: &SurrealConfig) -> MeetingClient {
    MeetingClient::connect(
        &fixture.client,
        fixture.session(name, "ws_signal").await,
        config,
        "ws_signal",
    )
    .await
    .unwrap()
}
async fn event(
    events: &mut broadcast::Receiver<MeetingEvent>,
    predicate: impl Fn(&MeetingEvent) -> bool,
) -> MeetingEvent {
    timeout(Duration::from_secs(15), async {
        loop {
            let event = events.recv().await.unwrap();
            if predicate(&event) {
                return event;
            }
            if let MeetingEvent::Ended(error) = event {
                panic!("meeting ended before expected event: {error}");
            }
        }
    })
    .await
    .expect("expected meeting event")
}
async fn status(client: &MeetingClient, wanted: MeetingStatus) {
    let mut status = client.status();
    timeout(Duration::from_secs(15), async {
        loop {
            if *status.borrow_and_update() == wanted {
                return;
            }
            status.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires SURREAL_TEST_BINARY verified fork; local-only meeting API"]
async fn real_fork_meeting_client_mesh_lifecycle_and_recovery() {
    let mut fixture = fixture().await;
    let proxy = Proxy::start(&fixture.config).await;
    let alice = client(&fixture, "a", &proxy.config).await;
    let bob = client(&fixture, "b", &fixture.config).await;
    let carol = client(&fixture, "c", &fixture.config).await;
    let mut a = alice.subscribe();
    let mut b = bob.subscribe();
    let mut c = carol.subscribe();
    assert!(alice.meetings().await.unwrap().meetings.is_empty());
    assert_eq!(
        alice.create("", None).await.unwrap_err(),
        MeetingError::Input
    );
    assert_eq!(bob.join("bad").await.unwrap_err(), MeetingError::Input);
    let mut socket = fixture.connection("a", "ws_signal").await.socket;
    let direct = query(&mut socket, "RETURN fn::chat_direct(user:b);", json!({})).await;
    let conversation = direct[0]["result"].as_str().unwrap();
    assert_eq!(
        alice
            .create("missing", Some("chat_conversation:missing"))
            .await
            .unwrap_err(),
        MeetingError::Database
    );
    let room = alice
        .create("user:meeting", Some(conversation))
        .await
        .unwrap();
    assert_eq!(room.conversation.as_deref(), Some(conversation));
    assert_eq!(room.title, "user:meeting");
    bob.join(&room.code).await.unwrap();
    carol.join(&room.code).await.unwrap();
    for events in [&mut a, &mut b] {
        event(
            events,
            |e| matches!(e,MeetingEvent::Participant(p) if p.user=="user:c"&&p.left_at.is_none()),
        )
        .await;
    }
    assert_eq!(
        alice
            .meetings()
            .await
            .unwrap()
            .participants
            .iter()
            .filter(|p| p.meeting == room.id && p.left_at.is_none())
            .count(),
        3
    );
    let media = bob
        .update_media(
            &room.id,
            MediaState {
                mic: true,
                cam: true,
                screen: false,
            },
        )
        .await
        .unwrap();
    assert!(media.mic && media.cam && !media.screen);
    let repeated = bob.join(&room.code).await.unwrap();
    assert_eq!(repeated.id, media.id);
    assert_eq!(repeated.joined_at, media.joined_at);
    assert!(repeated.mic && repeated.cam && !repeated.screen);
    assert!(bob.heartbeat(&room.id).await.unwrap().last_seen >= media.last_seen);
    for pair in 0..3 {
        let (sender, receiver, events, to, from) = match pair {
            0 => (&alice, &bob, &mut b, "user:b", "user:a"),
            1 => (&alice, &carol, &mut c, "user:c", "user:a"),
            _ => (&bob, &carol, &mut c, "user:c", "user:b"),
        };
        let mut responses = sender.subscribe();
        let session = fresh_key().unwrap();
        let sent = sender
            .send_signal(
                &room.id,
                to,
                SignalKind::Offer,
                "fixture offer",
                &session,
                &fresh_key().unwrap(),
            )
            .await
            .unwrap();
        event(
            events,
            |e| matches!(e,MeetingEvent::Signal(s) if s.id==sent.id),
        )
        .await;
        let answer = receiver
            .send_signal(
                &room.id,
                from,
                SignalKind::Answer,
                "fixture answer",
                &session,
                &fresh_key().unwrap(),
            )
            .await
            .unwrap();
        event(
            &mut responses,
            |e| matches!(e,MeetingEvent::Signal(s) if s.id==answer.id),
        )
        .await;
        assert_eq!(answer.to, from);
        assert!(answer.expires_ns > answer.created_ns);
    }
    let inbox = bob.meetings().await.unwrap();
    assert!(inbox.signals.iter().all(|s| s.to == "user:b"));
    let ice = alice
        .send_signal(
            &room.id,
            "user:b",
            SignalKind::Ice,
            "fixture ice",
            &fresh_key().unwrap(),
            &fresh_key().unwrap(),
        )
        .await
        .unwrap();
    event(
        &mut b,
        |e| matches!(e,MeetingEvent::Signal(s) if s.id==ice.id),
    )
    .await;

    proxy.paused.send_replace(true);
    event(&mut a, |e| matches!(e, MeetingEvent::Reconnecting { .. })).await;
    let missed = bob
        .send_signal(
            &room.id,
            "user:a",
            SignalKind::Offer,
            "while disconnected",
            &fresh_key().unwrap(),
            &fresh_key().unwrap(),
        )
        .await
        .unwrap();
    carol.leave(&room.id).await.unwrap();
    event(
        &mut b,
        |e| matches!(e,MeetingEvent::Participant(p) if p.user=="user:c"&&p.left_at.is_some()),
    )
    .await;
    proxy.paused.send_replace(false);
    event(
        &mut a,
        |e| matches!(e,MeetingEvent::Signal(s) if s.id==missed.id),
    )
    .await;
    status(&alice, MeetingStatus::Connected).await;
    assert!(alice
        .snapshot()
        .participants
        .iter()
        .any(|p| p.user == "user:c" && p.left_at.is_some()));
    carol.join(&room.code).await.unwrap();
    alice.remove_participant(&room.id, "user:c").await.unwrap();
    event(
        &mut c,
        |e| matches!(e,MeetingEvent::Participant(p) if p.user=="user:c"&&p.left_at.is_some()),
    )
    .await;
    carol.join(&room.code).await.unwrap();
    assert_eq!(
        alice.end(&room.id).await.unwrap().status,
        MeetingState::Ended
    );
    for events in [&mut a, &mut b, &mut c] {
        event(
            events,
            |e| matches!(e,MeetingEvent::MeetingEnded(id) if id==&room.id),
        )
        .await;
    }
    assert!(bob.join(&room.code).await.is_err());
    alice.stop().await.unwrap();
    bob.stop().await.unwrap();
    carol.stop().await.unwrap();
    for table in ["meeting", "meeting_participant", "meeting_signal"] {
        let result = query(
            &mut fixture.root,
            &format!("INFO FOR TABLE {table};"),
            json!({}),
        )
        .await;
        assert!(result[0]["result"]["lives"].as_object().unwrap().is_empty());
    }
}

#[tokio::test]
#[ignore = "requires SURREAL_TEST_BINARY verified fork; meeting identity lifetime"]
async fn real_fork_meeting_client_expiry_and_rejection() {
    let fixture = fixture().await;
    let mut session = fixture.session("a", "ws_signal").await;
    Arc::get_mut(&mut session).unwrap().expires_at = crate::auth::unix_now().unwrap() + 2;
    let alice = MeetingClient::connect(&fixture.client, session, &fixture.config, "ws_signal")
        .await
        .unwrap();
    let mut events = alice.subscribe();
    event(&mut events, |e| {
        matches!(e, MeetingEvent::Ended(MeetingError::Expired))
    })
    .await;
    assert_eq!(alice.meetings().await.unwrap_err(), MeetingError::Expired);
    alice.stop().await.unwrap();
}
