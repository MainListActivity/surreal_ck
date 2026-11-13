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
    // subject 只能来自数据库已验签的 $token.sub：fork 的 JSON-RPC 会把 UUID 形状的字符串参数转成 uuid。
    assert!(REVALIDATE.contains("subject = $token.sub"));
    assert!(IDENTITY.contains("subject = $token.sub"));
    assert!(!REVALIDATE.contains("$subject"));
    assert!(!IDENTITY.contains("$subject"));
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
    assert_eq!(member_key("user:a").unwrap(), "a");
    assert_eq!(member_key("user:\u{27e8}a-b_c\u{27e9}").unwrap(), "a-b_c");
    // fork JSON-RPC 会把这些形状转成 uuid / datetime，必须拒绝。
    for coerced in [
        "user:\u{27e8}550e8400-e29b-41d4-a716-446655440000\u{27e9}",
        "user:550e8400-e29b-41d4-a716-446655440000",
        "user:2026-11-13",
        "user:`2026-11-13x`",
    ] {
        assert!(member_key(coerced).is_err(), "{coerced}");
    }
    assert!(member_key("user:af4fe8s2cv8pwuxgcida").is_ok());
    assert!(member_key("user:0u3tr8obsmst2jn7o0wv").is_ok());
    assert!(member_key("user:\u{27e8}bad;id\u{27e9}").is_err());
    assert_eq!(member_key("user:`12345`").unwrap(), "12345");
    assert!(member_key("user:`bad;id`").is_err());
    assert!(member_key("user:`a").is_err());
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
fn database_failures_are_classified_without_echoing_messages() {
    let missing = json!([{"status":"ERR","kind":"NotFound","details":{"kind":"Table","details":{"name":"native_signal"}},"result":"The table 'native_signal' does not exist"}]);
    assert_eq!(
        statement_rows(missing),
        Err(IdentityError::SignalSchemaMissing)
    );
    let other = json!([{"status":"ERR","kind":"NotFound","details":{"kind":"Table","details":{"name":"user"}},"result":"x"}]);
    assert_eq!(statement_rows(other), Err(IdentityError::SignalUnavailable));
    assert_eq!(
        rpc_failure(&json!({"code":-32002,"kind":"NotAllowed","message":"secret detail"})),
        IdentityError::SignalDenied
    );
    assert_eq!(
        rpc_failure(&json!({"code":-32000,"kind":"Internal"})),
        IdentityError::SignalUnavailable
    );
    assert!(!IdentityError::SignalDenied.to_string().contains("secret"));
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

// 此夹具仅在 cfg(test) 编译，本地 ES256 JWT 经生产 participant ACCESS 认证；不提供生产 mock/Session 构造器。
// 外层可把此模块包含进同一个验收 test crate；不可作为产品依赖的 feature 导出。
pub(crate) struct ForkFixture {
    child: std::process::Child,
    pub(crate) root: DatabaseSocket,
    root_id: u64,
    pub(crate) config: SurrealConfig,
    pub(crate) client: IdentityClient,
    /// token → (database, 权威列表中的工作区角色)；`d` 是 is_admin=true 的工作区管理员。
    members: Arc<std::sync::Mutex<std::collections::HashMap<String, (String, &'static str)>>>,
    workspace_api: tokio::task::JoinHandle<()>,
    /// 本地 ES256 夹具签名钥；公钥只经 loopback JWKS 提供给 fork 的 participant ACCESS。
    signer: ring::signature::EcdsaKeyPair,
}
/// 与生产 IdP（ma_hono `crypto.randomUUID()`）同形的 UUID subject。
/// fork 的 JSON-RPC 会把 UUID 形状的字符串参数解析成 uuid，夹具必须覆盖这一点。
pub(crate) fn fixture_subject(name: &str) -> String {
    let tag: String = name.bytes().map(|byte| format!("{byte:02x}")).collect();
    format!("00000000-0000-4000-8000-{tag:0>12}")
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
                "--allow-net",
                "127.0.0.1",
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
        let result=rpc(&mut root,2,"query",json!(["DEFINE NAMESPACE local; USE NS local; DEFINE DATABASE ws_signal; DEFINE DATABASE ws_other; DEFINE DATABASE ws_legacy;",{}])).await.unwrap();
        assert_ok_statements(&result);
        let mut root_id = 2;
        let http = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_address = http.local_addr().unwrap();
        let signer = {
            use ring::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
            let rng = ring::rand::SystemRandom::new();
            let pkcs8 =
                EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
            EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
                .unwrap()
        };
        let jwks = {
            use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
            use ring::signature::KeyPair;
            let point = signer.public_key().as_ref();
            assert_eq!(point.len(), 65);
            json!({"keys":[{"kty":"EC","crv":"P-256","alg":"ES256","use":"sig","kid":"fixture","x":URL_SAFE_NO_PAD.encode(&point[1..33]),"y":URL_SAFE_NO_PAD.encode(&point[33..])}]}).to_string()
        };
        let jwks_url = format!("http://{http_address}/jwks");
        // ws_legacy 只到 061：模拟迁移停在 062 之前的工作区。
        for database in ["ws_signal", "ws_other", "ws_legacy"] {
            root_id += 1;
            rpc(&mut root, root_id, "use", json!(["local", database]))
                .await
                .unwrap();
            let setup="DEFINE TABLE user SCHEMAFULL PERMISSIONS FOR select FULL; DEFINE FIELD kind ON user TYPE string; DEFINE FIELD email ON user TYPE string; DEFINE FIELD subject ON user TYPE option<string>; DEFINE FIELD is_admin ON user TYPE bool; DEFINE FIELD disabled_at ON user TYPE option<datetime>; ";
            root_id += 1;
            let result = rpc(&mut root, root_id, "query", json!([setup, {}]))
                .await
                .unwrap();
            assert_ok_statements(&result);
            // 生产 061 participant ACCESS 原样加载（TYPE RECORD WITH JWT URL + AUTHENTICATE），不再用 SIGNIN 夹具替身。
            for sql in [
                include_str!("../../shared/sql/workspace-template/061-member-identity-guard.surql")
                    .replace("<__OIDC_JWKS_URL__>", &jwks_url),
                include_str!("../../shared/sql/workspace-template/062-native-signaling.surql")
                    .to_owned(),
            ] {
                if database == "ws_legacy" && sql.contains("native_signal") {
                    continue;
                }
                root_id += 1;
                let result = rpc(&mut root, root_id, "query", json!([sql, {}]))
                    .await
                    .unwrap();
                assert_ok_statements(&result);
            }
            // subject 经 root 参数绑定（CBOR 之外的 JSON 会把 UUID 形状字符串转成 uuid，这里显式 <string> 落成字符串，与生产 user.subject 一致）。
            for (name, is_admin) in [("a", false), ("b", false), ("c", false), ("d", true)] {
                root_id += 1;
                let result = rpc(
                    &mut root,
                    root_id,
                    "query",
                    json!(["CREATE type::record('user', $name) SET kind='human', email=string::concat($name, '@invalid.local'), subject=<string> $subject, is_admin=$is_admin; SELECT VALUE type::is_string(subject) FROM ONLY type::record('user', $name);", {"name": name, "subject": fixture_subject(name), "is_admin": is_admin}]),
                )
                .await
                .unwrap();
                assert_ok_statements(&result);
                assert_eq!(
                    result[1]["result"],
                    json!(true),
                    "fixture subject must be stored as string"
                );
            }
        }
        let members = Arc::new(std::sync::Mutex::new(std::collections::HashMap::<
            String,
            (String, &'static str),
        >::new()));
        let allowed = members.clone();
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
                let entry = bearer.and_then(|token| allowed.lock().unwrap().get(token).cloned());
                let (status, body) = if request.starts_with("GET /jwks ") {
                    ("200 OK", jwks.clone())
                } else if let Some((database, role)) = entry {
                    ("200 OK",json!({"workspaces":[{"slug":database,"name":"本地夹具工作区","dbName":database,"role":role,"lastSelectedAt":null}],"canCreate":false}).to_string())
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
            signer,
        }
    }
    /// 按生产 IdP 降级票据形状签发 participant JWT（sub 为 UUID，ns/db/ac/RL/email 同 collaboration-scope）。
    fn participant_token(&self, name: &str, database: &str, exp: u64) -> String {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        let now = crate::auth::unix_now().unwrap();
        let header =
            URL_SAFE_NO_PAD.encode(json!({"alg":"ES256","typ":"JWT","kid":"fixture"}).to_string());
        let claims = URL_SAFE_NO_PAD.encode(
            json!({"iss":"https://id.example.test/t/ck","aud":"fixture-client","sub":fixture_subject(name),"ns":"local","db":database,"ac":"participant","RL":["Editor"],"email":format!("{name}@invalid.local"),"iat":now,"exp":exp})
                .to_string(),
        );
        let input = format!("{header}.{claims}");
        let signature = self
            .signer
            .sign(&ring::rand::SystemRandom::new(), input.as_bytes())
            .unwrap();
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()))
    }
    pub(crate) async fn session(&self, name: &str, database: &str) -> Arc<Session> {
        let expires = crate::auth::unix_now().unwrap() + 600;
        let token = self.participant_token(name, database, expires);
        self.members.lock().unwrap().insert(
            token.clone(),
            (
                database.to_owned(),
                if name == "d" { "admin" } else { "participant" },
            ),
        );
        let session = Session {
            origin: self.client.config.clone(),
            access_token: zeroize::Zeroizing::new(token),
            subject: fixture_subject(name),
            expires_at: expires,
            token_expires_at: expires,
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
    // 工作区管理员经 collaboration-scope 降级得到的同 subject participant RECORD 会话：
    // 权威列表角色仍是 admin，但 `$auth.id` 绑定到其本人 is_admin=true 的 user 行。
    // 回归根因：fork 的 JSON-RPC 把 UUID 形状的字符串参数解析成 uuid；生产 sub 正是 UUID。
    // 旧查询用 `subject = $subject` 因此恒为 0 行（SignalIdentityMissing），现只信 `$token.sub`。
    fixture.root_id += 1;
    let coerced = rpc(
        &mut fixture.root,
        fixture.root_id,
        "query",
        json!(["RETURN [type::is_string($s), type::is_uuid($s)];", {"s": fixture_subject("d")}]),
    )
    .await
    .unwrap();
    assert_eq!(coerced[0]["result"], json!([false, true]));
    let mut admin_member = fixture.connection("d", "ws_signal").await;
    assert_eq!(admin_member.member_id(), "user:d");
    admin_member.revalidate_peer("user:a").await.unwrap();
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
    Arc::get_mut(&mut confused).unwrap().subject = fixture_subject("c");
    assert!(matches!(
        SignalConnection::connect(&fixture.client, confused, &fixture.config, "ws_signal").await,
        Err(IdentityError::SignalIdentityMissing)
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires SURREAL_TEST_BINARY pointing to the verified local fork; no production connections"]
async fn real_fork_listening_cadence_and_unmigrated_workspace() {
    let binary = std::env::var("SURREAL_TEST_BINARY").expect("fixed fork binary required");
    let fixture = ForkFixture::start(&binary).await;
    // 062 未应用的工作区：连接即明确失败，不再进入监听后报「身份或工作区已变化」。
    let legacy = SignalConnection::connect(
        &fixture.client,
        fixture.session("d", "ws_legacy").await,
        &fixture.config,
        "ws_legacy",
    )
    .await;
    assert_eq!(legacy.err(), Some(IdentityError::SignalSchemaMissing));
    // 与 UI 相同的 4 秒收件箱节奏（跨越服务端 5 秒 ping），管理员降级会话持续可用。
    let mut admin = fixture.connection("d", "ws_signal").await;
    let mut member = fixture.connection("a", "ws_signal").await;
    let mut ticker = tokio::time::interval(Duration::from_secs(4));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    for round in 0..4 {
        ticker.tick().await;
        let rows = admin.inbox().await.expect("admin inbox stays available");
        assert_eq!(rows.len(), usize::from(round >= 2));
        if round == 1 {
            let offer = offer("offer");
            let hash = sdp_hash(&offer, "offer").unwrap();
            member
                .invite(&id(), &id(), &id(), "user:d", &offer, &hash)
                .await
                .unwrap();
        }
    }
}
