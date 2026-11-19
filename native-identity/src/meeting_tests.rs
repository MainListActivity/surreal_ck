use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

async fn query(socket: &mut DatabaseSocket, sql: &str, vars: Value) -> Value {
    rpc_outcome(socket, 100, "query", json!([sql, vars]))
        .await
        .unwrap()
        .unwrap_or_else(|error| panic!("query RPC error: {error}; SQL: {sql}"))
}

fn rows(result: &Value) -> &[Value] {
    assert_eq!(result[0]["status"], "OK", "{result}");
    result[0]["result"].as_array().expect("query rows")
}

fn denied(result: &Value) {
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
    for sql in [
        include_str!("../../shared/sql/workspace-template/064-native-chat.surql"),
        include_str!("../../shared/sql/workspace-template/065-native-meeting.surql"),
    ] {
        let result = query(&mut fixture.root, sql, json!({})).await;
        for statement in result.as_array().unwrap() {
            assert_eq!(statement["status"], "OK", "meeting schema: {statement}");
        }
    }
    for name in ["e", "f", "g"] {
        let result = query(
            &mut fixture.root,
            "CREATE type::record('user',$name) SET kind='human', email=string::concat($name,'@invalid.local'), subject=<string>$subject, is_admin=false;",
            json!({"name":name,"subject":fixture_subject(name)}),
        ).await;
        assert_eq!(rows(&result).len(), 1);
    }
    fixture
}

async fn create(socket: &mut DatabaseSocket) -> Value {
    let result = query(
        socket,
        "CREATE meeting CONTENT {title:'Local meeting',code:'client-code'};",
        json!({}),
    )
    .await;
    assert_eq!(rows(&result).len(), 1);
    rows(&result)[0].clone()
}

async fn join(socket: &mut DatabaseSocket, code: &Value) -> Value {
    query(
        socket,
        "RETURN fn::meeting_join($code);",
        json!({"code":code}),
    )
    .await
}

async fn participants(socket: &mut DatabaseSocket, room: &Value) -> Value {
    query(
        socket,
        "SELECT * FROM meeting_participant WHERE meeting=type::record($room) AND left_at=NONE;",
        json!({"room":room}),
    )
    .await
}

async fn leave(socket: &mut DatabaseSocket, room: &Value, who: &str) -> Value {
    query(socket, "UPDATE meeting_participant SET left_at=time::now() WHERE meeting=type::record($room) AND user=type::record('user',$who);", json!({"room":room,"who":who})).await
}

async fn signal(
    socket: &mut DatabaseSocket,
    room: &Value,
    to: &str,
    kind: &str,
    session: &str,
    nonce: &str,
) -> Value {
    query(socket, "CREATE meeting_signal CONTENT {meeting:type::record($room),to:type::record('user',$to),kind:$kind,payload:'local fixture',session:$session_key,nonce:$nonce};", json!({"room":room,"to":to,"kind":kind,"session_key":session,"nonce":nonce})).await
}

#[tokio::test]
#[ignore = "requires SURREAL_TEST_BINARY pointing to the verified local fork; no production connections"]
async fn real_fork_meeting_lifecycle_and_permissions() {
    let mut fixture = fixture().await;
    let mut alice = fixture.connection("a", "ws_signal").await.socket;
    let mut bob = fixture.connection("b", "ws_signal").await.socket;
    let mut outsider = fixture.connection("c", "ws_signal").await.socket;
    assert!(rows(&query(&mut alice, "SELECT * FROM meeting;", json!({})).await).is_empty());
    let meeting = create(&mut alice).await;
    let room = &meeting["id"];
    let code = meeting["code"].as_str().unwrap();
    assert_eq!(code.len(), 12);
    assert!(code.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(meeting["host"], "user:a");
    assert_eq!(meeting["status"], "active");
    assert!(meeting["created_at"].is_string());
    assert!(meeting["ended_at"].is_null());
    assert_eq!(rows(&participants(&mut alice, room).await).len(), 1);
    let found = query(
        &mut bob,
        "SELECT * FROM meeting WHERE code=$code;",
        json!({"code":code}),
    )
    .await;
    assert_eq!(rows(&found)[0]["id"], *room);
    denied(&join(&mut bob, &json!("not-a-code")).await);
    assert_eq!(rows(&join(&mut bob, &meeting["code"]).await).len(), 1);
    assert_eq!(rows(&join(&mut bob, &meeting["code"]).await).len(), 1);
    let members = participants(&mut bob, room).await;
    assert_eq!(rows(&members).len(), 2);
    assert_eq!(
        rows(&members)
            .iter()
            .find(|p| p["user"] == "user:a")
            .unwrap()["role"],
        "host"
    );
    assert!(rows(&participants(&mut outsider, room).await).is_empty());

    for sql in [
        "CREATE meeting CONTENT {title:'fake host',host:user:a};",
        "CREATE meeting CONTENT {title:'ended',status:'ended'};",
        "CREATE meeting CONTENT {title:''};",
        "CREATE meeting CONTENT {title:'bad conversation',conversation:chat_conversation:missing};",
        "CREATE meeting_participant CONTENT {meeting:type::record($room),user:user:c};",
        "UPDATE type::record($room) SET status='ended';",
        "UPDATE type::record($room) SET host=user:b;",
        "UPDATE meeting_participant SET cam=true WHERE meeting=type::record($room) AND user=user:a;",
        "UPDATE meeting_participant SET user=user:c WHERE meeting=type::record($room) AND user=user:b;",
        "DELETE meeting_participant WHERE meeting=type::record($room);",
        "DELETE type::record($room);",
    ] {
        denied(&query(&mut bob, sql, json!({"room":room})).await);
    }
    let update = query(&mut bob, "UPDATE meeting_participant SET mic=true,cam=true,screen=true,last_seen=<datetime>'2000-01-01T00:00:00Z' WHERE meeting=type::record($room) AND user=user:b;", json!({"room":room})).await;
    assert_eq!(rows(&update)[0]["mic"], true);
    assert_eq!(rows(&update)[0]["cam"], true);
    assert_eq!(rows(&update)[0]["screen"], true);
    assert_ne!(rows(&update)[0]["last_seen"], "2000-01-01T00:00:00Z");
    denied(&query(&mut alice, "UPDATE meeting_participant SET mic=false WHERE meeting=type::record($room) AND user=user:b;", json!({"room":room})).await);
    denied(&query(&mut bob, "UPDATE meeting_participant SET cam='yes' WHERE meeting=type::record($room) AND user=user:b;", json!({"room":room})).await);
    assert_eq!(rows(&leave(&mut alice, room, "b").await).len(), 1);
    assert_eq!(rows(&participants(&mut bob, room).await).len(), 0);
    assert_eq!(rows(&join(&mut bob, &meeting["code"]).await).len(), 1);
    assert_eq!(rows(&leave(&mut bob, room, "b").await).len(), 1);
    assert_eq!(rows(&join(&mut bob, &meeting["code"]).await).len(), 1);
    denied(
        &query(
            &mut alice,
            "UPDATE type::record($room) SET title='edited';",
            json!({"room":room}),
        )
        .await,
    );
    let ended = query(
        &mut alice,
        "UPDATE type::record($room) SET status='ended',ended_at=<datetime>'2000-01-01T00:00:00Z';",
        json!({"room":room}),
    )
    .await;
    assert_eq!(rows(&ended)[0]["status"], "ended");
    assert!(rows(&ended)[0]["ended_at"].is_string());
    assert_ne!(rows(&ended)[0]["ended_at"], "2000-01-01T00:00:00Z");
    let all = query(
        &mut fixture.root,
        "SELECT * FROM meeting_participant WHERE meeting=type::record($room);",
        json!({"room":room}),
    )
    .await;
    assert_eq!(rows(&all).len(), 2);
    assert!(
        rows(&all).iter().all(|p| p["left_at"].is_string()),
        "end EVENT did not remove every participant: {all}"
    );
    denied(&join(&mut bob, &meeting["code"]).await);
    denied(&join(&mut outsider, &meeting["code"]).await);
    denied(
        &query(
            &mut alice,
            "UPDATE type::record($room) SET status='active';",
            json!({"room":room}),
        )
        .await,
    );
    assert!(rows(&query(&mut bob, "SELECT * FROM meeting;", json!({})).await).is_empty());

    let second = create(&mut alice).await;
    assert_ne!(second["code"], meeting["code"]);
    let disabled = query(
        &mut fixture.root,
        "UPDATE user:c SET disabled_at=time::now();",
        json!({}),
    )
    .await;
    assert_eq!(rows(&disabled).len(), 1);
    denied(&join(&mut outsider, &second["code"]).await);
    denied(
        &query(
            &mut outsider,
            "CREATE meeting CONTENT {title:'disabled'};",
            json!({}),
        )
        .await,
    );
    assert!(rows(&query(&mut outsider, "SELECT * FROM meeting;", json!({})).await).is_empty());
    let mut other = fixture.connection("b", "ws_other").await.socket;
    denied(&query(&mut other, "SELECT * FROM meeting;", json!({})).await);
}

#[tokio::test]
#[ignore = "requires SURREAL_TEST_BINARY pointing to the verified local fork; no production connections"]
async fn real_fork_meeting_capacity_and_concurrent_join() {
    let mut fixture = fixture().await;
    let mut alice = fixture.connection("a", "ws_signal").await.socket;
    let meeting = create(&mut alice).await;
    for name in ["b", "c", "d", "e", "f"] {
        let mut member = fixture.connection(name, "ws_signal").await.socket;
        assert_eq!(rows(&join(&mut member, &meeting["code"]).await).len(), 1);
    }
    let mut seventh = fixture.connection("g", "ws_signal").await.socket;
    denied(&join(&mut seventh, &meeting["code"]).await);
    denied(
        &query(
            &mut seventh,
            "CREATE meeting_participant CONTENT {meeting:type::record($room)};",
            json!({"room":meeting["id"]}),
        )
        .await,
    );
    assert_eq!(
        rows(&participants(&mut fixture.root, &meeting["id"]).await).len(),
        6
    );
    assert_eq!(rows(&leave(&mut alice, &meeting["id"], "f").await).len(), 1);
    let mut returning = fixture.connection("f", "ws_signal").await.socket;
    let (first, second) = tokio::join!(
        join(&mut returning, &meeting["code"]),
        join(&mut seventh, &meeting["code"])
    );
    let successes = [&first, &second]
        .into_iter()
        .filter(|result| result[0]["status"] == "OK" && !rows(result).is_empty())
        .count();
    assert_eq!(successes, 1, "capacity race: {first} / {second}");
    assert_eq!(
        rows(&participants(&mut fixture.root, &meeting["id"]).await).len(),
        6
    );
    if first[0]["status"] == "ERR" {
        denied(&join(&mut returning, &meeting["code"]).await);
    }
    if second[0]["status"] == "ERR" {
        denied(&join(&mut seventh, &meeting["code"]).await);
    }
}

#[tokio::test]
#[ignore = "requires SURREAL_TEST_BINARY pointing to the verified local fork; no production connections"]
async fn real_fork_meeting_signals_replay_limits_and_departure() {
    let mut fixture = fixture().await;
    let mut alice = fixture.connection("a", "ws_signal").await.socket;
    let mut bob = fixture.connection("b", "ws_signal").await.socket;
    let mut outsider = fixture.connection("c", "ws_signal").await.socket;
    let meeting = create(&mut alice).await;
    let room = &meeting["id"];
    assert_eq!(rows(&join(&mut bob, &meeting["code"]).await).len(), 1);
    let session = id();
    let nonce = id();
    let sent = signal(&mut alice, room, "b", "offer", &session, &nonce).await;
    let record = rows(&sent)[0].clone();
    assert_eq!(record["from"], "user:a");
    assert_eq!(record["to"], "user:b");
    assert!(record["expires_at"].is_string());
    let ttl = query(
        &mut fixture.root,
        "RETURN (SELECT VALUE expires_at-created_at >= 120s AND expires_at-created_at < 121s FROM ONLY type::record($id));",
        json!({"id":record["id"]}),
    )
    .await;
    assert_eq!(ttl[0]["result"], true);
    assert_eq!(
        rows(&query(&mut bob, "SELECT * FROM meeting_signal;", json!({})).await).len(),
        1
    );
    assert!(
        rows(&query(&mut outsider, "SELECT * FROM meeting_signal;", json!({})).await).is_empty()
    );
    assert_eq!(rows(&join(&mut outsider, &meeting["code"]).await).len(), 1);
    assert!(
        rows(&query(&mut outsider, "SELECT * FROM meeting_signal;", json!({})).await).is_empty()
    );
    denied(&signal(&mut alice, room, "b", "ice", &id(), &nonce).await);
    denied(&signal(&mut alice, room, "b", "offer", &session, &id()).await);
    for kind in ["answer", "ice", "ice", "bye"] {
        assert_eq!(
            rows(&signal(&mut bob, room, "a", kind, &session, &id()).await).len(),
            1
        );
    }
    for sql in [
        "CREATE meeting_signal CONTENT {meeting:type::record($room),from:user:b,to:user:a,kind:'offer',payload:'x',session:$session_key,nonce:$nonce};",
        "CREATE meeting_signal CONTENT {meeting:type::record($room),to:user:b,kind:'unknown',payload:'x',session:$session_key,nonce:$nonce};",
        "CREATE meeting_signal CONTENT {meeting:type::record($room),to:user:b,kind:'ice',payload:'',session:$session_key,nonce:$nonce};",
        "CREATE meeting_signal CONTENT {meeting:type::record($room),to:user:b,kind:'ice',payload:string::repeat('x',49153),session:$session_key,nonce:$nonce};",
        "CREATE meeting_signal CONTENT {meeting:type::record($room),to:user:b,kind:'ice',payload:'x',session:'bad',nonce:$nonce};",
        "CREATE meeting_signal CONTENT {meeting:type::record($room),to:user:b,kind:'ice',payload:'x',session:$session_key,nonce:'bad'};",
        "CREATE meeting_signal CONTENT {meeting:type::record($room),to:user:a,kind:'ice',payload:'x',session:$session_key,nonce:$nonce};",
        "UPDATE type::record($id) SET payload='changed';",
        "DELETE type::record($id);",
        "DELETE meeting_signal_rate;",
    ] {
        denied(&query(&mut alice, sql, json!({"room":room,"session_key":id(),"nonce":id(),"id":record["id"]})).await);
    }
    let immutable = query(
        &mut bob,
        "SELECT * FROM ONLY type::record($id);",
        json!({"id":record["id"]}),
    )
    .await;
    assert_eq!(immutable[0]["result"]["payload"], "local fixture");
    assert_eq!(rows(&leave(&mut alice, room, "b").await).len(), 1);
    denied(&signal(&mut alice, room, "b", "ice", &session, &id()).await);
    denied(&signal(&mut bob, room, "a", "ice", &session, &id()).await);
    assert!(rows(&query(&mut bob, "SELECT * FROM meeting_signal;", json!({})).await).is_empty());
    assert_eq!(rows(&join(&mut bob, &meeting["code"]).await).len(), 1);
    let reset = query(&mut fixture.root, "DELETE meeting_signal_rate;", json!({})).await;
    assert_eq!(reset[0]["status"], "OK");
    for n in 0..120 {
        assert_eq!(
            rows(
                &signal(
                    &mut alice,
                    room,
                    "b",
                    "ice",
                    &session,
                    &format!("{n:062x}ab")
                )
                .await
            )
            .len(),
            1
        );
    }
    let limited = signal(&mut alice, room, "b", "ice", &session, &id()).await;
    assert_eq!(limited[0]["status"], "ERR", "{limited}");
    assert!(
        limited.to_string().contains("signal rate limit"),
        "{limited}"
    );
    let reset = query(
        &mut fixture.root,
        "UPDATE meeting_signal_rate SET window_start=time::now()-11s;",
        json!({}),
    )
    .await;
    assert_eq!(reset[0]["status"], "OK");
    assert_eq!(
        rows(&signal(&mut alice, room, "b", "ice", &session, &id()).await).len(),
        1
    );
}

async fn live(socket: &mut DatabaseSocket, sql: &str) -> Value {
    let response = query(socket, sql, json!({})).await;
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
async fn real_fork_meeting_live_recipient_and_presence_filters() {
    let mut fixture = fixture().await;
    let mut alice = fixture.connection("a", "ws_signal").await.socket;
    let mut bob = fixture.connection("b", "ws_signal").await.socket;
    let mut carol = fixture.connection("c", "ws_signal").await.socket;
    let mut outsider = fixture.connection("d", "ws_signal").await.socket;
    let meeting = create(&mut alice).await;
    assert_eq!(rows(&join(&mut bob, &meeting["code"]).await).len(), 1);
    let unrelated = create(&mut outsider).await;
    let mut a_live = fixture.connection("a", "ws_signal").await.socket;
    let mut b_live = fixture.connection("b", "ws_signal").await.socket;
    let mut c_live = fixture.connection("c", "ws_signal").await.socket;
    let mut d_live = fixture.connection("d", "ws_signal").await.socket;
    let a_id = live(
        &mut a_live,
        "LIVE SELECT * FROM meeting_signal WHERE to=$auth.id;",
    )
    .await;
    let b_id = live(
        &mut b_live,
        "LIVE SELECT * FROM meeting_signal WHERE to=$auth.id;",
    )
    .await;
    let c_id = live(&mut c_live, "LIVE SELECT * FROM meeting_signal;").await;
    let d_id = live(&mut d_live, "LIVE SELECT * FROM meeting_signal;").await;
    let session = id();
    let sent = signal(&mut alice, &meeting["id"], "b", "offer", &session, &id()).await;
    let record = rows(&sent)[0].clone();
    let event = notification(&mut b_live, Duration::from_secs(2))
        .await
        .unwrap();
    assert_eq!(event["id"], b_id);
    assert_eq!(event["result"]["id"], record["id"]);
    assert!(notification(&mut a_live, Duration::from_millis(150))
        .await
        .is_none());
    assert!(notification(&mut c_live, Duration::from_millis(150))
        .await
        .is_none());
    assert!(notification(&mut d_live, Duration::from_millis(150))
        .await
        .is_none());
    for (socket, id) in [
        (&mut a_live, a_id),
        (&mut b_live, b_id),
        (&mut c_live, c_id),
        (&mut d_live, d_id),
    ] {
        rpc(socket, 101, "kill", json!([id])).await.unwrap();
    }
    let a_id = live(&mut a_live, "LIVE SELECT * FROM meeting_participant;").await;
    let b_id = live(&mut b_live, "LIVE SELECT * FROM meeting_participant;").await;
    let c_id = live(&mut c_live, "LIVE SELECT * FROM meeting_participant;").await;
    let d_id = live(&mut d_live, "LIVE SELECT * FROM meeting_participant;").await;
    assert_eq!(rows(&join(&mut carol, &meeting["code"]).await).len(), 1);
    for (socket, id) in [
        (&mut a_live, &a_id),
        (&mut b_live, &b_id),
        (&mut c_live, &c_id),
    ] {
        let event = notification(socket, Duration::from_secs(2)).await.unwrap();
        assert_eq!(event["id"], *id);
        assert_eq!(event["result"]["user"], "user:c");
        assert_eq!(event["result"]["meeting"], meeting["id"]);
        assert_eq!(event["action"], "CREATE");
        while notification(socket, Duration::from_millis(100))
            .await
            .is_some()
        {}
    }
    assert!(notification(&mut d_live, Duration::from_millis(150))
        .await
        .is_none());
    assert_eq!(rows(&leave(&mut alice, &meeting["id"], "b").await).len(), 1);
    for socket in [&mut a_live, &mut b_live, &mut c_live] {
        let event = notification(socket, Duration::from_secs(2)).await.unwrap();
        assert_eq!(event["result"]["user"], "user:b");
        assert!(event["result"]["left_at"].is_string());
    }
    let changed = query(&mut carol, "UPDATE meeting_participant SET mic=true WHERE meeting=type::record($room) AND user=user:c;", json!({"room":meeting["id"]})).await;
    assert_eq!(rows(&changed).len(), 1);
    for socket in [&mut a_live, &mut c_live] {
        assert_eq!(
            notification(socket, Duration::from_secs(2)).await.unwrap()["result"]["mic"],
            true
        );
    }
    assert!(notification(&mut b_live, Duration::from_millis(150))
        .await
        .is_none());
    assert!(notification(&mut d_live, Duration::from_millis(150))
        .await
        .is_none());
    assert_eq!(
        rows(&participants(&mut outsider, &unrelated["id"]).await).len(),
        1
    );
    let ended = query(
        &mut alice,
        "UPDATE type::record($room) SET status='ended';",
        json!({"room":meeting["id"]}),
    )
    .await;
    assert_eq!(rows(&ended).len(), 1);
    let active = participants(&mut fixture.root, &meeting["id"]).await;
    assert!(rows(&active).is_empty());
    for socket in [&mut a_live, &mut b_live, &mut c_live, &mut d_live] {
        while notification(socket, Duration::from_millis(100))
            .await
            .is_some()
        {}
    }
    for (socket, id) in [
        (&mut a_live, a_id),
        (&mut b_live, b_id),
        (&mut c_live, c_id),
        (&mut d_live, d_id),
    ] {
        rpc(socket, 102, "kill", json!([id])).await.unwrap();
    }
}
