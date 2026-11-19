use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

#[path = "chat_api_tests.rs"]
pub(crate) mod api;

async fn query(socket: &mut DatabaseSocket, sql: &str, vars: Value) -> Value {
    rpc(socket, 100, "query", json!([sql, vars])).await.unwrap()
}

fn rows(result: &Value) -> &[Value] {
    assert_eq!(result[0]["status"], "OK", "{result}");
    result[0]["result"].as_array().expect("query rows")
}

fn denied_or_empty(result: &Value) {
    assert!(
        result[0]["status"] == "ERR" || rows(result).is_empty(),
        "unauthorized operation returned data: {result}"
    );
}

async fn fixture() -> ForkFixture {
    let binary = std::env::var("SURREAL_TEST_BINARY").expect("verified fork binary required");
    let mut fixture = ForkFixture::start(&binary).await;
    rpc(&mut fixture.root, 90, "use", json!(["local", "ws_signal"]))
        .await
        .unwrap();
    let result = query(
        &mut fixture.root,
        include_str!("../../shared/sql/workspace-template/064-native-chat.surql"),
        json!({}),
    )
    .await;
    for statement in result.as_array().unwrap() {
        assert_eq!(statement["status"], "OK", "chat schema: {statement}");
    }
    let named=query(&mut fixture.root, "DEFINE FIELD OVERWRITE display_name ON user TYPE option<string>; UPDATE user SET display_name=email;", json!({})).await;
    for statement in named.as_array().unwrap() {
        assert_eq!(statement["status"], "OK", "{statement}");
    }
    fixture
}

async fn direct(socket: &mut DatabaseSocket, peer: &str) -> String {
    let result = query(
        socket,
        "RETURN fn::chat_direct(type::record('user',$peer));",
        json!({"peer": peer}),
    )
    .await;
    assert_eq!(result[0]["status"], "OK", "{result}");
    result[0]["result"].as_str().unwrap().to_owned()
}

async fn group(socket: &mut DatabaseSocket) -> String {
    let result = query(
        socket,
        "CREATE chat_conversation CONTENT {kind:'group',title:'Local team'};",
        json!({}),
    )
    .await;
    rows(&result)[0]["id"].as_str().unwrap().to_owned()
}

async fn add(socket: &mut DatabaseSocket, room: &str, user: &str) -> Value {
    query(socket, "CREATE chat_member CONTENT {conversation:type::record($room),user:type::record('user',$user),role:'member'};", json!({"room": room, "user": user})).await
}

async fn send(socket: &mut DatabaseSocket, room: &str, client: &str) -> Value {
    query(socket, "CREATE chat_message CONTENT {conversation:type::record($room),body:'hello',client_id:$client};", json!({"room": room, "client": client})).await
}

#[tokio::test]
#[ignore = "requires SURREAL_TEST_BINARY pointing to the verified local fork; no production connections"]
async fn real_fork_chat_permissions_and_idempotency() {
    let mut fixture = fixture().await;
    let mut alice = fixture.connection("a", "ws_signal").await.socket;
    let mut bob = fixture.connection("b", "ws_signal").await.socket;
    let mut outsider = fixture.connection("c", "ws_signal").await.socket;

    let room = direct(&mut alice, "b").await;
    assert_eq!(room, direct(&mut alice, "b").await);
    assert_eq!(room, direct(&mut bob, "a").await);
    assert_eq!(
        rows(
            &query(
                &mut alice,
                "SELECT * FROM chat_conversation WHERE kind='direct';",
                json!({})
            )
            .await
        )
        .len(),
        1
    );
    assert_eq!(
        rows(
            &query(
                &mut alice,
                "SELECT * FROM chat_member WHERE conversation=type::record($room);",
                json!({"room":room})
            )
            .await
        )
        .len(),
        2
    );
    denied_or_empty(&add(&mut alice, &room, "c").await);
    denied_or_empty(
        &query(
            &mut alice,
            "DELETE chat_member WHERE conversation=type::record($room) AND user=user:b;",
            json!({"room":room}),
        )
        .await,
    );
    denied_or_empty(
        &query(
            &mut alice,
            "CREATE chat_conversation CONTENT {kind:'direct',direct_users:[user:a,user:b]};",
            json!({}),
        )
        .await,
    );

    let team = group(&mut alice).await;
    assert_eq!(rows(&add(&mut alice, &team, "b").await).len(), 1);
    assert_eq!(rows(&send(&mut alice, &team, "a1").await).len(), 1);
    assert_eq!(rows(&send(&mut bob, &team, "b1").await).len(), 1);
    let received = query(
        &mut bob,
        "SELECT * FROM chat_message WHERE conversation=type::record($room);",
        json!({"room":team}),
    )
    .await;
    assert_eq!(rows(&received).len(), 2);
    let message = rows(&received)[0]["id"].as_str().unwrap().to_owned();
    assert!(rows(&received)
        .iter()
        .all(|row| row["created_at"].is_string()));

    let duplicate = send(&mut alice, &team, "a1").await;
    assert_eq!(duplicate[0]["status"], "ERR", "{duplicate}");
    assert_eq!(
        rows(
            &query(
                &mut alice,
                "SELECT * FROM chat_message WHERE sender=user:a AND client_id='a1';",
                json!({})
            )
            .await
        )
        .len(),
        1
    );
    for table in ["chat_conversation", "chat_member", "chat_message"] {
        denied_or_empty(&query(&mut outsider, &format!("SELECT * FROM {table};"), json!({})).await);
    }
    denied_or_empty(&send(&mut outsider, &team, "c1").await);
    denied_or_empty(&add(&mut bob, &team, "c").await);
    denied_or_empty(
        &query(
            &mut bob,
            "DELETE chat_member WHERE conversation=type::record($room) AND user=user:a;",
            json!({"room":team}),
        )
        .await,
    );
    denied_or_empty(&query(&mut bob, "CREATE chat_message CONTENT {conversation:type::record($room),sender:user:a,body:'forged',client_id:'forged'};", json!({"room":team})).await);
    denied_or_empty(
        &query(
            &mut bob,
            "UPDATE type::record($id) SET body='changed';",
            json!({"id":message}),
        )
        .await,
    );
    denied_or_empty(&query(&mut bob, "DELETE type::record($id);", json!({"id":message})).await);
    assert_eq!(
        rows(
            &query(
                &mut bob,
                "SELECT * FROM type::record($id);",
                json!({"id":message})
            )
            .await
        )[0]["body"],
        "hello"
    );

    denied_or_empty(&query(&mut bob, "UPDATE chat_member SET last_read_at=time::now() WHERE conversation=type::record($room) AND user=user:a;", json!({"room":team})).await);
    assert_eq!(rows(&query(&mut bob, "UPDATE chat_member SET last_read_at=time::now() WHERE conversation=type::record($room) AND user=user:b;", json!({"room":team})).await).len(), 1);
    let own = query(
        &mut bob,
        "SELECT * FROM chat_member WHERE conversation=type::record($room) AND user=user:b;",
        json!({"room":team}),
    )
    .await;
    assert!(rows(&own)[0]["last_read_at"].is_string());

    for body in ["", "   ", &"x".repeat(4001)] {
        let result = query(&mut alice, "CREATE chat_message CONTENT {conversation:type::record($room),body:$body,client_id:'invalid'};", json!({"room":team,"body":body})).await;
        assert_eq!(result[0]["status"], "ERR", "{result}");
    }
    assert_eq!(rows(&query(&mut alice, "DELETE chat_member WHERE conversation=type::record($room) AND user=user:b RETURN BEFORE;", json!({"room":team})).await).len(), 1);
    assert_eq!(
        rows(&send(&mut alice, &team, "after-remove").await).len(),
        1
    );
    denied_or_empty(
        &query(
            &mut bob,
            "SELECT * FROM chat_message WHERE conversation=type::record($room);",
            json!({"room":team}),
        )
        .await,
    );
    denied_or_empty(&send(&mut bob, &team, "removed").await);
    assert_eq!(rows(&add(&mut alice, &team, "b").await).len(), 1);
    fixture.revoke("b").await;
    denied_or_empty(&send(&mut bob, &team, "disabled").await);
}

#[tokio::test]
#[ignore = "requires SURREAL_TEST_BINARY pointing to the verified local fork; no production connections"]
async fn real_fork_chat_atomic_creation_and_membership_guards() {
    let mut fixture = fixture().await;
    let mut alice = fixture.connection("a", "ws_signal").await.socket;
    for content in [
        "{kind:'direct',direct_users:[user:a]}",
        "{kind:'direct',direct_users:[user:a,user:a]}",
        "{kind:'direct',direct_users:[user:b,user:c]}",
        "{kind:'direct',direct_users:[user:a,user:missing]}",
        "{kind:'group',title:'   '}",
        "{kind:'group',title:'forged',created_by:user:b}",
    ] {
        denied_or_empty(
            &query(
                &mut alice,
                &format!("CREATE chat_conversation CONTENT {content};"),
                json!({}),
            )
            .await,
        );
    }
    assert!(
        rows(&query(&mut alice, "SELECT * FROM chat_conversation;", json!({})).await).is_empty()
    );
    for table in ["chat_conversation", "chat_member"] {
        assert!(
            rows(
                &query(
                    &mut fixture.root,
                    &format!("SELECT * FROM {table};"),
                    json!({})
                )
                .await
            )
            .is_empty(),
            "failed creation left orphan {table}"
        );
    }
    let mut bob = fixture.connection("b", "ws_signal").await.socket;
    let mut carol = fixture.connection("c", "ws_signal").await.socket;
    let sql = "RETURN fn::chat_direct(type::record('user',$peer));";
    let (first, second) = tokio::join!(
        query(&mut bob, sql, json!({"peer":"c"})),
        query(&mut carol, sql, json!({"peer":"b"})),
    );
    for result in [&first, &second] {
        if result[0]["status"] == "ERR" {
            assert_eq!(result[0]["details"]["code"], "quota_conflict", "{result}");
            assert_eq!(result[0]["details"]["retryable"], true, "{result}");
        } else {
            assert_eq!(result[0]["status"], "OK", "{result}");
        }
    }
    assert_eq!(direct(&mut bob, "c").await, direct(&mut carol, "b").await);
    assert_eq!(
        rows(
            &query(
                &mut fixture.root,
                "SELECT * FROM chat_conversation WHERE kind='direct';",
                json!({})
            )
            .await
        )
        .len(),
        1
    );
    let team = group(&mut alice).await;
    denied_or_empty(&add(&mut bob, &team, "b").await);
    denied_or_empty(&query(&mut alice, "CREATE chat_member CONTENT {conversation:type::record($room),user:user:b,role:'owner'};", json!({"room":team})).await);
    assert_eq!(rows(&add(&mut alice, &team, "b").await).len(), 1);
    assert_eq!(add(&mut alice, &team, "b").await[0]["status"], "ERR");
    let _ = query(&mut bob, "UPDATE chat_member SET role='owner',user=user:c WHERE conversation=type::record($room) AND user=user:b;", json!({"room":team})).await;
    let member = query(
        &mut bob,
        "SELECT * FROM chat_member WHERE conversation=type::record($room) AND user=user:b;",
        json!({"room":team}),
    )
    .await;
    assert_eq!(rows(&member)[0]["role"], "member");
    assert_eq!(rows(&member)[0]["user"], "user:b");
}

async fn live(socket: &mut DatabaseSocket) -> Value {
    let response = query(socket, "LIVE SELECT * FROM chat_message;", json!({})).await;
    assert_eq!(response[0]["status"], "OK", "{response}");
    let id = response[0]["result"].clone();
    assert!(id.is_string(), "{response}");
    id
}

async fn notification(socket: &mut DatabaseSocket, limit: Duration) -> Option<Value> {
    timeout(limit, async {
        loop {
            match socket.next().await.expect("live socket closed").unwrap() {
                Message::Text(text) => {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if value.get("id").is_none_or(Value::is_null)
                        && value["result"]["action"].is_string()
                    {
                        return value["result"].clone();
                    }
                    panic!("unexpected LIVE frame: {value}");
                }
                Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await.unwrap(),
                Message::Pong(_) => {}
                other => panic!("unexpected LIVE frame: {other:?}"),
            }
        }
    })
    .await
    .ok()
}

#[tokio::test]
#[ignore = "requires SURREAL_TEST_BINARY pointing to the verified local fork; no production connections"]
async fn real_fork_chat_live_filters_members_and_removed_users() {
    let fixture = fixture().await;
    let mut writer = fixture.connection("a", "ws_signal").await.socket;
    let team = group(&mut writer).await;
    assert_eq!(rows(&add(&mut writer, &team, "b").await).len(), 1);
    let mut alice = fixture.connection("a", "ws_signal").await.socket;
    let mut bob = fixture.connection("b", "ws_signal").await.socket;
    let mut outsider = fixture.connection("c", "ws_signal").await.socket;
    let alice_id = live(&mut alice).await;
    let bob_id = live(&mut bob).await;
    let outsider_id = live(&mut outsider).await;
    assert_eq!(
        rows(&send(&mut writer, &team, "live-before").await).len(),
        1
    );
    for (socket, id) in [(&mut alice, &alice_id), (&mut bob, &bob_id)] {
        let notice = notification(socket, Duration::from_secs(5))
            .await
            .expect("member did not receive LIVE");
        assert_eq!(&notice["id"], id);
        assert_eq!(notice["action"], "CREATE");
        assert_eq!(notice["result"]["client_id"], "live-before");
    }
    assert!(notification(&mut outsider, Duration::from_millis(500))
        .await
        .is_none());
    let mut peer_writer = fixture.connection("c", "ws_signal").await.socket;
    let peer_room = direct(&mut peer_writer, "a").await;
    assert_eq!(
        rows(&send(&mut peer_writer, &peer_room, "parallel-direct").await).len(),
        1
    );
    for socket in [&mut alice, &mut outsider] {
        let notice = notification(socket, Duration::from_secs(5))
            .await
            .expect("direct member did not receive LIVE");
        assert_eq!(notice["result"]["client_id"], "parallel-direct");
        assert_eq!(notice["result"]["conversation"], peer_room);
    }
    assert!(notification(&mut bob, Duration::from_millis(500))
        .await
        .is_none());
    assert_eq!(rows(&query(&mut writer, "DELETE chat_member WHERE conversation=type::record($room) AND user=user:b RETURN BEFORE;", json!({"room":team})).await).len(), 1);
    assert_eq!(rows(&send(&mut writer, &team, "live-after").await).len(), 1);
    let notice = notification(&mut alice, Duration::from_secs(5))
        .await
        .expect("remaining member did not receive LIVE");
    assert_eq!(notice["result"]["client_id"], "live-after");
    assert!(
        notification(&mut bob, Duration::from_secs(1))
            .await
            .is_none(),
        "removed member received a new message"
    );
    assert!(notification(&mut outsider, Duration::from_millis(500))
        .await
        .is_none());
    for (socket, id) in [
        (&mut alice, alice_id),
        (&mut bob, bob_id),
        (&mut outsider, outsider_id),
    ] {
        rpc(socket, 101, "kill", json!([id])).await.unwrap();
    }
}
