use super::*;

fn offer(kind: &str) -> String {
    json!({"type":kind,"sdp":"v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 00:11\r\na=ice-ufrag:fixture\r\na=ice-pwd:local-fixture-only\r\n"}).to_string()
}
fn id() -> String {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut bytes = [0; 32];
    SystemRandom::new().fill(&mut bytes).unwrap();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
#[test]
fn fixed_queries_bind_every_mutable_target_and_never_accept_sender_input() {
    assert!(INVITE.contains("sender = $auth.id"));
    assert!(REVALIDATE.contains("subject = $subject"));
    assert!(REVALIDATE.contains("id = $auth.id"));
    assert!(REVALIDATE.contains("disabled_at = NONE"));
    assert!(!REVALIDATE.contains("native_signal"));
    assert!(!INVITE.contains("$sender"));
    for sql in [ACCEPT, REJECT, ANSWER, END] {
        for key in [
            "$id",
            "$workspace",
            "$sender",
            "$recipient",
            "$nonce",
            "$generation",
            "$offer_hash",
            "$expires_at",
        ] {
            assert!(sql.contains(key));
        }
        assert!(sql.contains("expires_at > time::now()"));
    }
}
#[test]
fn inputs_and_remote_errors_are_fail_closed_and_redacted() {
    assert!(valid_hex(&id()));
    assert!(!valid_hex("x'; DELETE user;"));
    assert!(member_key("user:a; DELETE user").is_err());
    assert!(member_key("employee:a").is_err());
    assert!(sdp_hash(&offer("offer"), "offer").is_ok());
    assert!(sdp_hash(&offer("answer"), "offer").is_err());
    assert!(sdp_hash(&"a".repeat(49153), "offer").is_err());
    assert_eq!(
        statement_rows(json!([{"status":"ERR","result":"sensitive-token"}])),
        Err(IdentityError::SignalUnavailable)
    );
    assert!(!IdentityError::SignalUnavailable
        .to_string()
        .contains("sensitive-token"));
    assert!(live_times(100, 100).is_err());
    assert!(live_times(222, 100).is_err());
    assert!(live_times(221, 100).is_ok());
}

#[test]
fn peer_revalidation_requires_exactly_both_distinct_active_members() {
    assert!(validate_peer_rows(
        &[json!({"id":"user:a"}), json!({"id":"user:b"})],
        "user:a",
        "user:b"
    )
    .is_ok());
    for rows in [
        vec![],
        vec![json!({"id":"user:a"})],
        vec![json!({"id":"user:a"}), json!({"id":"user:a"})],
        vec![json!({"id":"user:a"}), json!({"id":"user:c"})],
        vec![
            json!({"id":"user:a","unexpected":true}),
            json!({"id":"user:b"}),
        ],
    ] {
        assert_eq!(
            validate_peer_rows(&rows, "user:a", "user:b"),
            Err(IdentityError::SignalUnavailable)
        );
    }
}

// 此夹具仅在 cfg(test) 编译，真实 RECORD SIGNIN 获得本地 token；不提供生产 mock/Session 构造器。
// 外层可把此模块包含进同一个验收 test crate；不可作为产品依赖的 feature 导出。
pub(crate) struct ForkFixture {
    child: std::process::Child,
    pub(crate) root: DatabaseSocket,
    root_id: u64,
    pub(crate) config: SurrealConfig,
    pub(crate) client: IdentityClient,
    members: Arc<std::sync::Mutex<std::collections::HashMap<String, String>>>,
    workspace_api: tokio::task::JoinHandle<()>,
}
impl ForkFixture {
    pub(crate) async fn start(binary: &str) -> Self {
        use std::process::{Command, Stdio};
        let version = Command::new(binary).arg("version").output().unwrap();
        assert!(
            String::from_utf8_lossy(&version.stdout)
                .contains("3.3.0-native-quota.1+sha.f30704bce914"),
            "fixture requires the verified fork build"
        );
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let address = format!("127.0.0.1:{port}");
        let child = Command::new(binary)
            .args([
                "start",
                "--bind",
                &address,
                "--user",
                "fixture",
                "--pass",
                "local-only",
                "memory",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let endpoint = format!("ws://{address}/rpc");
        let mut root = None;
        for _ in 0..50 {
            if let Ok((socket, _)) = tokio_tungstenite::connect_async(&endpoint).await {
                root = Some(socket);
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let mut root = root.expect("local fixture startup failed");
        rpc(
            &mut root,
            1,
            "signin",
            json!([{"user":"fixture","pass":"local-only"}]),
        )
        .await
        .expect("local fixture root signin");
        let result=rpc(&mut root,2,"query",json!(["DEFINE NAMESPACE local; USE NS local; DEFINE DATABASE ws_signal; DEFINE DATABASE ws_other;",{}])).await.unwrap();
        assert_ok_statements(&result);
        let mut root_id = 2;
        for database in ["ws_signal", "ws_other"] {
            root_id += 1;
            rpc(&mut root, root_id, "use", json!(["local", database]))
                .await
                .unwrap();
            let setup="DEFINE TABLE user SCHEMAFULL PERMISSIONS FOR select FULL; DEFINE FIELD kind ON user TYPE string; DEFINE FIELD email ON user TYPE string; DEFINE FIELD subject ON user TYPE option<string>; DEFINE FIELD is_admin ON user TYPE bool; DEFINE FIELD disabled_at ON user TYPE option<datetime>; CREATE user:a SET kind='human',email='a@invalid.local',subject='fixture-a',is_admin=false; CREATE user:b SET kind='human',email='b@invalid.local',subject='fixture-b',is_admin=false; CREATE user:c SET kind='human',email='c@invalid.local',subject='fixture-c',is_admin=false;";
            root_id += 1;
            let result = rpc(&mut root, root_id, "query", json!([setup, {}]))
                .await
                .unwrap();
            assert_ok_statements(&result);
            for sql in [include_str!("../../shared/sql/workspace-template/061-member-identity-guard.surql").replace("<__OIDC_JWKS_URL__>","http://127.0.0.1:18737/not-used-by-fixture"),include_str!("../../shared/sql/workspace-template/062-native-signaling.surql").to_owned(),"DEFINE ACCESS OVERWRITE participant ON DATABASE TYPE RECORD SIGNIN { RETURN type::record('user', $name); };".to_owned()] {
                root_id+=1;let result=rpc(&mut root,root_id,"query",json!([sql,{}])).await.unwrap();assert_ok_statements(&result);
            }
        }
        let members = Arc::new(std::sync::Mutex::new(std::collections::HashMap::<
            String,
            String,
        >::new()));
        let allowed = members.clone();
        let http = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_address = http.local_addr().unwrap();
        let workspace_api = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            loop {
                let Ok((mut stream, _)) = http.accept().await else {
                    break;
                };
                let mut bytes = vec![];
                let mut chunk = [0u8; 1024];
                while let Ok(count) = stream.read(&mut chunk).await {
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk[..count]);
                    if bytes.windows(4).any(|v| v == b"\r\n\r\n") || bytes.len() > 8192 {
                        break;
                    }
                }
                let request = String::from_utf8_lossy(&bytes);
                let bearer = request.lines().find_map(|line| {
                    line.split_once(':')
                        .filter(|(name, _)| name.eq_ignore_ascii_case("authorization"))
                        .and_then(|(_, value)| value.trim().strip_prefix("Bearer "))
                });
                let database = bearer.and_then(|token| allowed.lock().unwrap().get(token).cloned());
                let (status, body) = if let Some(database) = database {
                    ("200 OK",json!({"workspaces":[{"slug":database,"name":"本地夹具工作区","dbName":database,"role":"participant","lastSelectedAt":null}],"canCreate":false}).to_string())
                } else {
                    ("401 Unauthorized", "{}".into())
                };
                let response=format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",body.len());
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        let mut client = IdentityClient::new(
            crate::IdentityConfig::new(
                "https://id.example.test/t/ck",
                "https://app.example.test",
                "fixture-client",
                "https://auth.example.test",
                "http://127.0.0.1:43123/auth/callback",
            )
            .unwrap(),
        );
        client.transport = crate::HttpsTransport::local_fixture(
            url::Url::parse(&format!("http://{http_address}")).unwrap(),
        );
        // cfg(test) 内唯一明文 WS 覆盖；公开 SurrealConfig::new 始终拒绝非 WSS。
        let config = SurrealConfig {
            endpoint: url::Url::parse(&endpoint).unwrap(),
            namespace: "local".into(),
        };
        Self {
            child,
            root,
            root_id,
            config,
            client,
            members,
            workspace_api,
        }
    }
    pub(crate) async fn session(&self, name: &str, database: &str) -> Arc<Session> {
        let (mut socket, _) = tokio_tungstenite::connect_async(self.config.endpoint.as_str())
            .await
            .unwrap();
        let result = rpc(
            &mut socket,
            1,
            "signin",
            json!([{"ns":"local","db":database,"ac":"participant","name":name}]),
        )
        .await
        .expect("fixture member signin");
        let token = result
            .as_str()
            .or_else(|| result.get("token").and_then(Value::as_str))
            .expect("fixture token shape")
            .to_owned();
        self.members
            .lock()
            .unwrap()
            .insert(token.clone(), database.to_owned());
        let session = Session {
            origin: self.client.config.clone(),
            access_token: zeroize::Zeroizing::new(token),
            subject: format!("fixture-{name}"),
            expires_at: crate::auth::unix_now().unwrap() + 600,
            database: Some(database.into()),
            access: Some("participant".into()),
            roles: vec![],
            jwks_uri: url::Url::parse("https://id.example.test/t/ck/jwks.json").unwrap(),
        };
        Arc::new(session)
    }
    pub(crate) async fn connection(&self, name: &str, database: &str) -> SignalConnection {
        SignalConnection::connect(
            &self.client,
            self.session(name, database).await,
            &self.config,
            database,
        )
        .await
        .expect("real RECORD signal connect")
    }
    pub(crate) async fn revoke(&mut self, name: &str) {
        self.root_id += 1;
        rpc(
            &mut self.root,
            self.root_id,
            "use",
            json!(["local", "ws_signal"]),
        )
        .await
        .unwrap();
        self.root_id += 1;
        let result = rpc(
            &mut self.root,
            self.root_id,
            "query",
            json!(["UPDATE type::record('user',$name) SET disabled_at=time::now();",{"name":name}]),
        )
        .await
        .unwrap();
        assert_ok_statements(&result);
    }
}
fn assert_ok_statements(value: &Value) {
    for (index, statement) in value
        .as_array()
        .expect("fixture query results")
        .iter()
        .enumerate()
    {
        assert_eq!(
            statement.get("status").and_then(Value::as_str),
            Some("OK"),
            "fixture schema statement {index} failed"
        );
    }
}
impl Drop for ForkFixture {
    fn drop(&mut self) {
        self.workspace_api.abort();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires SURREAL_TEST_BINARY pointing to the verified local fork; no production connections"]
async fn real_fork_signal_connection_roundtrip_and_denials() {
    let binary = std::env::var("SURREAL_TEST_BINARY").expect("fixed fork binary required");
    let mut fixture = ForkFixture::start(&binary).await;
    let mut alice = fixture.connection("a", "ws_signal").await;
    let mut bob = fixture.connection("b", "ws_signal").await;
    let mut outsider = fixture.connection("c", "ws_signal").await;
    let mut other = fixture.connection("a", "ws_other").await;
    assert_eq!(alice.member_id(), "user:a");
    assert_eq!(bob.member_id(), "user:b");
    alice.ensure_current().unwrap();
    assert!(alice.session_expires_at() > crate::auth::unix_now().unwrap());
    alice.revalidate_peer("user:b").await.unwrap();
    bob.revalidate_peer("user:a").await.unwrap();
    assert_eq!(
        alice.revalidate_peer("user:a").await.unwrap_err(),
        IdentityError::SignalInput
    );
    assert_eq!(
        alice.revalidate_peer("user:missing").await.unwrap_err(),
        IdentityError::SignalUnavailable
    );
    let offer = offer("offer");
    let hash = sdp_hash(&offer, "offer").unwrap();
    let (identifier, nonce, generation) = ("1".repeat(64), id(), id());
    let created = alice
        .invite(&identifier, &nonce, &generation, "user:b", &offer, &hash)
        .await
        .expect("authenticated invite");
    assert_eq!(created.status, SignalStatus::Pending);
    assert_eq!(created.binding.sender, "user:a");
    assert_eq!(created.binding.id, identifier);
    assert!(created.expires_unix > created.server_unix);
    let summaries = bob.inbox().await.expect("authenticated inbox");
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].id, identifier);
    let read = bob
        .read(&identifier)
        .await
        .expect("recipient reads full binding");
    assert_eq!(read.binding, created.binding);
    assert_eq!(
        outsider.read(&identifier).await.unwrap_err(),
        IdentityError::SignalUnavailable
    );
    assert_eq!(
        other.read(&identifier).await.unwrap_err(),
        IdentityError::SignalUnavailable
    );
    assert_eq!(
        alice.decide(&created.binding, true).await.unwrap_err(),
        IdentityError::SignalBinding
    );
    let mut changed = created.binding.clone();
    changed.generation = id();
    assert_eq!(
        bob.decide(&changed, true).await.unwrap_err(),
        IdentityError::SignalUnavailable
    );
    let accepted = bob
        .decide(&created.binding, true)
        .await
        .expect("full binding accept");
    assert_eq!(accepted.status, SignalStatus::Accepted);
    let answer = super::tests::offer("answer");
    let answered = bob
        .answer(&accepted.binding, &answer)
        .await
        .expect("authenticated answer");
    assert_eq!(answered.status, SignalStatus::Answered);
    assert_eq!(answered.answer.as_deref(), Some(answer.as_str()));
    assert_eq!(
        bob.answer(&accepted.binding, &answer).await.unwrap_err(),
        IdentityError::SignalUnavailable
    );
    let ended = alice
        .end(&created.binding)
        .await
        .expect("authenticated end");
    assert_eq!(ended.status, SignalStatus::Ended);
    alice.revalidate_peer("user:b").await.unwrap();
    assert_eq!(
        bob.decide(&created.binding, true).await.unwrap_err(),
        IdentityError::SignalUnavailable
    );
    assert_eq!(
        alice
            .invite(&id(), &id(), &id(), "user:b", &offer, &hash)
            .await
            .unwrap_err(),
        IdentityError::SignalRateLimited
    );
    // 新的 live 邀请证明撤销确实阻止更新，不借助已 ended 的状态失败。
    let pending = outsider
        .invite(&id(), &id(), &id(), "user:b", &offer, &hash)
        .await
        .unwrap();
    fixture.revoke("b").await;
    assert_eq!(
        alice.revalidate_peer("user:b").await.unwrap_err(),
        IdentityError::SignalUnavailable
    );
    assert_eq!(
        bob.revalidate_peer("user:a").await.unwrap_err(),
        IdentityError::SignalUnavailable
    );
    assert_eq!(
        bob.decide(&pending.binding, true).await.unwrap_err(),
        IdentityError::SignalUnavailable
    );
    assert_eq!(
        outsider.read(&pending.binding.id).await.unwrap_err(),
        IdentityError::SignalUnavailable
    );
    // 本地 Session subject 混淆也不能把同一 record token 绑定成另一个账号。
    let mut confused = fixture.session("a", "ws_signal").await;
    Arc::get_mut(&mut confused).unwrap().subject = "fixture-c".into();
    assert!(matches!(
        SignalConnection::connect(&fixture.client, confused, &fixture.config, "ws_signal").await,
        Err(IdentityError::SignalRecordRequired)
    ));
    Arc::get_mut(&mut alice.session).unwrap().expires_at = 0;
    assert_eq!(alice.ensure_current(), Err(IdentityError::SessionExpired));
    assert_eq!(
        alice.revalidate_peer("user:c").await,
        Err(IdentityError::SessionExpired)
    );
    let mut expired = fixture.session("c", "ws_signal").await;
    Arc::get_mut(&mut expired).unwrap().expires_at = 0;
    assert!(matches!(
        SignalConnection::connect(&fixture.client, expired, &fixture.config, "ws_signal").await,
        Err(IdentityError::SessionExpired)
    ));
}
