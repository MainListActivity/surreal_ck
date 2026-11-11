use super::*;
use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use serde_json::{json, Value};

fn config() -> IdentityConfig {
    IdentityConfig::new(
        "https://id.example.test/t/ck",
        "https://app.example.test",
        "fixture-client",
        "https://auth.example.test",
        "http://127.0.0.1:43123/auth/callback",
    )
    .unwrap()
}
fn signer() -> (EcdsaKeyPair, JwkSet) {
    let rng = SystemRandom::new();
    let doc = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
    let pair =
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, doc.as_ref(), &rng).unwrap();
    let public = pair.public_key().as_ref();
    let jwks = serde_json::from_value(json!({"keys":[{"kty":"EC","crv":"P-256","kid":"fixture-key","alg":"ES256","use":"sig","key_ops":["verify"],"x":URL_SAFE_NO_PAD.encode(&public[1..33]),"y":URL_SAFE_NO_PAD.encode(&public[33..])}]})).unwrap();
    (pair, jwks)
}
fn signed(pair: &EcdsaKeyPair, claims: Value) -> String {
    let head = URL_SAFE_NO_PAD.encode(br#"{"alg":"ES256","kid":"fixture-key"}"#);
    let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
    let input = format!("{head}.{body}");
    let signature = pair.sign(&SystemRandom::new(), input.as_bytes()).unwrap();
    format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()))
}
fn access_claims(now: u64) -> Value {
    json!({"iss":"https://id.example.test/t/ck","aud":"https://auth.example.test","sub":"person-1","iat":now-1,"exp":now+600,"db":"ws_fixture","ac":"participant","RL":["Owner"]})
}
fn id_claims(now: u64) -> Value {
    json!({"iss":"https://id.example.test/t/ck","aud":"fixture-client","sub":"person-1","iat":now-1,"exp":now+600,"nonce":"expected-nonce"})
}
fn workspace(role: WorkspaceRole) -> Workspace {
    Workspace {
        slug: "fixture".into(),
        name: "Fixture".into(),
        db_name: "ws_fixture".into(),
        role,
        last_selected_at: None,
    }
}
#[test]
fn rfc7636_vector_and_unpredictable_attempts() {
    assert_eq!(
        pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
    let client = IdentityClient::new(config());
    let first = client.begin_login().unwrap();
    let second = client.begin_login().unwrap();
    assert_ne!(*first.state, *second.state);
    assert_ne!(*first.nonce, *second.nonce);
    assert_ne!(*first.verifier, *second.verifier);
    assert_eq!(first.verifier.len(), 43);
    let url = Url::parse(first.authorization_url()).unwrap();
    let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(params["scope"], "openid");
    assert_eq!(params["code_challenge_method"], "S256");
    assert!(!params.contains_key("client_secret"));
    assert!(!first.authorization_url().contains(first.verifier.as_str()));
    assert!(!format!("{first:?}").contains(first.verifier.as_str()));
}
#[test]
fn callback_is_exact_state_bound_and_single_use_by_ownership() {
    let client = IdentityClient::new(config());
    let attempt = client.begin_login().unwrap();
    let callback = format!(
        "{}?state={}&code=test-code",
        attempt.redirect_uri(),
        attempt.state.as_str()
    );
    assert_eq!(
        attempt.callback_code(&callback).unwrap().as_str(),
        "test-code"
    );
    for invalid in [
        callback.replace("43123", "43124"),
        callback.replace("auth/callback", "auth/other"),
        format!("{callback}&code=duplicate"),
        format!("{callback}&state=duplicate"),
        format!("{callback}#token"),
        callback.replace(attempt.state.as_str(), "wrong"),
        format!("{callback}&iss=https://evil.example"),
    ] {
        assert_eq!(
            attempt.callback_code(&invalid),
            Err(IdentityError::Callback)
        );
    }
    let error = format!(
        "{}?state={}&error=access_denied&error_description=secret",
        attempt.redirect_uri(),
        attempt.state.as_str()
    );
    assert_eq!(
        attempt.callback_code(&error),
        Err(IdentityError::LoginRejected)
    );
}
#[test]
fn platform_callback_precheck_reuses_authoritative_validation_without_consuming() {
    let mut native = config();
    native.redirect_uri = Url::parse("top.maplayer.collaboration:/auth/callback").unwrap();
    let client = IdentityClient::new(native);
    let attempt = client.begin_login().unwrap();
    let callback = format!(
        "{}?state={}&code=platform-code&iss=https%3A%2F%2Fid.example.test%2Ft%2Fck",
        attempt.redirect_uri(),
        attempt.state.as_str()
    );
    let before = attempt.remaining().unwrap();
    assert!(before > Duration::ZERO && before <= Duration::from_secs(300));
    assert_eq!(attempt.validate_callback(&callback), Ok(()));
    // 预检不消费请求，也不延长期限；只允许 receiver/finish 决定单次消费。
    assert_eq!(attempt.validate_callback(&callback), Ok(()));
    assert!(attempt.remaining().unwrap() <= before);
    assert_eq!(
        attempt.callback_code(&callback).unwrap().as_str(),
        "platform-code"
    );

    for invalid in [
        callback.replace("top.maplayer.collaboration:", "top.maplayer.other:"),
        callback.replace("/auth/callback", "/auth/other"),
        callback.replace(
            "top.maplayer.collaboration:/",
            "top.maplayer.collaboration://evil/",
        ),
        callback.replace(attempt.state.as_str(), "old-state"),
        callback.replace("id.example.test", "evil.example.test"),
        format!("{callback}&state=duplicate"),
        format!("{callback}&code=duplicate"),
        format!("{callback}&iss=https%3A%2F%2Fid.example.test%2Ft%2Fck"),
        format!("{callback}#fragment"),
        format!("{callback}&oversized={}", "x".repeat(16 * 1024)),
    ] {
        assert_eq!(
            attempt.validate_callback(&invalid),
            Err(IdentityError::Callback)
        );
    }

    let denied = format!(
        "{}?state={}&error=access_denied",
        attempt.redirect_uri(),
        attempt.state.as_str()
    );
    assert_eq!(
        attempt.validate_callback(&denied),
        Err(IdentityError::LoginRejected)
    );
    assert_eq!(
        attempt.validate_callback(&format!("{denied}&error=duplicate")),
        Err(IdentityError::Callback)
    );
    assert_eq!(
        attempt.validate_callback(&denied.replace(attempt.state.as_str(), "wrong")),
        Err(IdentityError::Callback)
    );
}
#[test]
fn platform_callback_expiry_and_cancelled_attempt_never_transfer_to_new_login() {
    let client = IdentityClient::new(config());
    let mut pending = Some(client.begin_login().unwrap());
    let cancelled = pending.as_ref().unwrap();
    let cancelled_callback = format!(
        "{}?state={}&code=cancelled-code",
        cancelled.redirect_uri(),
        cancelled.state.as_str()
    );
    drop(pending.take());
    assert!(pending.is_none());
    let replacement = client.begin_login().unwrap();
    assert_eq!(
        replacement.validate_callback(&cancelled_callback),
        Err(IdentityError::Callback)
    );

    let mut expired = client.begin_login().unwrap();
    let callback = format!(
        "{}?state={}&code=expired-code",
        expired.redirect_uri(),
        expired.state.as_str()
    );
    assert_eq!(expired.validate_callback(&callback), Ok(()));
    expired.created = Instant::now() - Duration::from_secs(300);
    assert_eq!(expired.remaining(), Err(IdentityError::LoginExpired));
    assert_eq!(
        expired.validate_callback(&callback),
        Err(IdentityError::LoginExpired)
    );
    // 即使先前预检通过，finish 仍在换票前重新检查期限并消费 attempt。
    assert_eq!(
        expired.finish(&callback).unwrap_err(),
        IdentityError::LoginExpired
    );
}
#[test]
fn cancellation_timeout_and_configuration_fail_closed() {
    let client = IdentityClient::new(config());
    let mut attempt = client.begin_login().unwrap();
    attempt.created = Instant::now() - Duration::from_secs(301);
    assert_eq!(
        attempt.callback_code("http://127.0.0.1:43123/auth/callback?state=x&code=y"),
        Err(IdentityError::LoginExpired)
    );
    for uri in [
        "https://docs.maplayer.top/callback",
        "http://localhost:43123/callback",
        "http://0.0.0.0:43123/callback",
        "http://127.0.0.1/callback",
        "file:///callback",
        "http://127.0.0.1:43123/callback?x=1",
    ] {
        assert!(IdentityConfig::new(
            "https://id.example.test",
            "https://app.example.test",
            "client",
            "aud",
            uri
        )
        .is_err());
    }
    assert!(IdentityConfig::new(
        "https://id.example.test",
        "https://app.example.test",
        "client",
        "aud",
        "top.maplayer.collaboration:/auth/callback"
    )
    .is_ok());
}
#[test]
fn verifies_both_signatures_and_scope_without_promoting_participant() {
    let client = IdentityClient::new(config());
    let now = unix_now().unwrap();
    let (pair, jwks) = signer();
    let access = signed(&pair, access_claims(now));
    let session = client
        .establish(
            Zeroizing::new(access.clone()),
            &signed(&pair, id_claims(now)),
            Some(100),
            "expected-nonce",
            &jwks,
            now,
        )
        .unwrap();
    assert_eq!(session.subject(), "person-1");
    assert_eq!(session.expires_at(), now + 100);
    assert!(session
        .require_scope(&workspace(WorkspaceRole::Participant))
        .is_ok());
    assert_eq!(
        session.require_scope(&workspace(WorkspaceRole::Admin)),
        Err(IdentityError::WorkspaceNotSelected)
    );
    let mut other = workspace(WorkspaceRole::Participant);
    other.db_name = "ws_other".into();
    assert_eq!(
        session.require_scope(&other),
        Err(IdentityError::WorkspaceNotSelected)
    );
    assert!(!format!("{session:?}").contains(&access));
}
#[test]
fn rejects_issuer_audience_nonce_subject_expiry_and_modified_signatures() {
    let client = IdentityClient::new(config());
    let now = unix_now().unwrap();
    let (pair, jwks) = signer();
    let access = signed(&pair, access_claims(now));
    for (field, invalid) in [
        ("iss", json!("https://evil.test")),
        ("aud", json!("wrong")),
        ("nonce", json!("wrong")),
        ("sub", json!("other")),
        ("exp", json!(now)),
        ("iat", json!(now + 100)),
        ("azp", json!("wrong")),
        ("at_hash", json!("wrong")),
        ("aud", json!(["fixture-client", "other"])),
    ] {
        let mut claims = id_claims(now);
        claims[field] = invalid;
        let error = client
            .establish(
                Zeroizing::new(access.clone()),
                &signed(&pair, claims),
                None,
                "expected-nonce",
                &jwks,
                now,
            )
            .unwrap_err();
        assert_eq!(error, IdentityError::Token, "field {field}");
    }
    let mut access_bad = access.into_bytes();
    let last = access_bad.len() - 3;
    access_bad[last] = if access_bad[last] == b'A' { b'B' } else { b'A' };
    assert_eq!(
        client
            .establish(
                Zeroizing::new(String::from_utf8(access_bad).unwrap()),
                &signed(&pair, id_claims(now)),
                None,
                "expected-nonce",
                &jwks,
                now
            )
            .unwrap_err(),
        IdentityError::Token
    );
}
#[test]
fn validates_at_hash_and_key_policy() {
    let client = IdentityClient::new(config());
    let now = unix_now().unwrap();
    let (pair, jwks) = signer();
    let access = signed(&pair, access_claims(now));
    let mut claims = id_claims(now);
    claims["at_hash"] = json!(URL_SAFE_NO_PAD.encode(&Sha256::digest(access.as_bytes())[..16]));
    assert!(client
        .establish(
            Zeroizing::new(access.clone()),
            &signed(&pair, claims.clone()),
            None,
            "expected-nonce",
            &jwks,
            now
        )
        .is_ok());
    for change in [
        json!({"use":"enc"}),
        json!({"alg":"RS256"}),
        json!({"key_ops":["encrypt"]}),
    ] {
        let mut keys = serde_json::to_value(&jwks).unwrap();
        for (key, value) in change.as_object().unwrap() {
            keys["keys"][0][key] = value.clone();
        }
        let altered = serde_json::from_value(keys).unwrap();
        assert!(client
            .establish(
                Zeroizing::new(access.clone()),
                &signed(&pair, claims.clone()),
                None,
                "expected-nonce",
                &altered,
                now
            )
            .is_err());
    }
}
#[test]
fn current_web_contract_deserializes_and_sensitive_errors_are_static() {
    let list: WorkspaceList = serde_json::from_value(json!({"workspaces":[{"slug":"fixture","name":"团队","dbName":"ws_fixture","role":"participant","lastSelectedAt":null}],"canCreate":false})).unwrap();
    assert_eq!(list.workspaces[0].role, WorkspaceRole::Participant);
    assert!(!list.can_create);
    for error in [
        IdentityError::Network,
        IdentityError::Response,
        IdentityError::Token,
        IdentityError::Http(403),
    ] {
        assert!(!error.to_string().contains("Bearer"));
    }
}

#[test]
fn session_cannot_cross_client_origins_and_types_can_cross_actor_boundary() {
    fn is_send<T: Send>() {}
    is_send::<Session>();
    is_send::<LoginAttempt>();
    is_send::<IdentityClient>();
    let now = unix_now().unwrap();
    let (pair, jwks) = signer();
    let client = IdentityClient::new(config());
    let session = client
        .establish(
            Zeroizing::new(signed(&pair, access_claims(now))),
            &signed(&pair, id_claims(now)),
            None,
            "expected-nonce",
            &jwks,
            now,
        )
        .unwrap();
    let different = IdentityClient::new(
        IdentityConfig::new(
            "https://id.example.test/t/ck",
            "https://other.example.test",
            "fixture-client",
            "https://auth.example.test",
            "http://127.0.0.1:43123/auth/callback",
        )
        .unwrap(),
    );
    assert_eq!(
        different.require_session(&session),
        Err(IdentityError::Configuration)
    );
}

#[test]
fn full_login_and_workspace_contract_over_real_local_http() {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let mut configuration = config();
    // 测试夹具内部替换为 loopback HTTP；公开配置构造器仍强制 HTTPS。
    configuration.api_base = Url::parse(&format!("http://{address}")).unwrap();
    configuration.issuer = Url::parse(&format!("http://{address}/t/ck")).unwrap();
    let client = IdentityClient::new(configuration);
    let attempt = client.begin_login().unwrap();
    let verifier = attempt.verifier.to_string();
    let callback = format!(
        "{}?state={}&code=fixture-code",
        attempt.redirect_uri(),
        attempt.state.as_str()
    );
    let (pair, jwks) = signer();
    let now = unix_now().unwrap();
    let issuer = client.config.issuer.to_string();
    let mut access_claims = access_claims(now);
    access_claims["iss"] = json!(issuer);
    let mut identity_claims = id_claims(now);
    identity_claims["iss"] = json!(issuer);
    identity_claims["nonce"] = json!(attempt.nonce.as_str());
    let access = signed(&pair, access_claims);
    let identity = signed(&pair, identity_claims);
    let server = thread::spawn(move || {
        for route in [
            "/api/auth/token",
            "/t/ck/jwks.json",
            "/api/session/workspaces",
        ] {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut raw = vec![];
            let mut chunk = [0; 1024];
            let (headers_end, text) = loop {
                let count = stream.read(&mut chunk).unwrap();
                assert_ne!(count, 0);
                raw.extend_from_slice(&chunk[..count]);
                let text = String::from_utf8(raw.clone()).unwrap();
                if let Some(end) = text.find("\r\n\r\n") {
                    let length: usize = text[..end]
                        .lines()
                        .find_map(|s| {
                            s.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::to_owned)
                        })
                        .unwrap_or_else(|| "0".into())
                        .parse()
                        .unwrap();
                    if raw.len() == end + 4 + length {
                        break (end + 4, text);
                    }
                }
            };
            assert!(text.lines().next().unwrap().contains(route));
            let body = match route {
                "/api/auth/token" => {
                    let form: std::collections::HashMap<_, _> =
                        url::form_urlencoded::parse(&text.as_bytes()[headers_end..])
                            .into_owned()
                            .collect();
                    assert_eq!(form["code_verifier"], verifier);
                    assert_eq!(form["code"], "fixture-code");
                    assert_eq!(form["client_id"], "fixture-client");
                    assert_eq!(form["grant_type"], "authorization_code");
                    assert!(!form.contains_key("client_secret"));
                    json!({"access_token":access,"id_token":identity,"expires_in":120,"token_type":"Bearer"}).to_string()
                }
                "/t/ck/jwks.json" => serde_json::to_string(&jwks).unwrap(),
                _ => {
                    assert!(text.contains(&format!("Bearer {access}")));
                    json!({"workspaces":[{"slug":"fixture","name":"团队","dbName":"ws_fixture","role":"participant","lastSelectedAt":null}],"canCreate":false}).to_string()
                }
            };
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(response.as_bytes()).unwrap();
        }
    });
    let session = attempt.finish(&callback).unwrap();
    assert_eq!(session.subject(), "person-1");
    let list = client.list_workspaces(&session).unwrap();
    assert_eq!(list.workspaces[0].db_name, "ws_fixture");
    assert_eq!(list.workspaces[0].name, "团队");
    server.join().unwrap();
}

#[test]
fn public_discovery_is_opt_in_and_pins_all_endpoints() {
    use crate::test_http;
    assert_eq!(config().token_mode(), OidcTokenMode::ConfidentialProxy);
    assert!(config().with_public_pkce_discovery(&[]).is_err());
    assert!(config()
        .with_public_pkce_discovery(&["other.example.test"])
        .is_err());
    let public = config()
        .with_public_pkce_discovery(&["id.example.test"])
        .unwrap();
    assert_eq!(public.token_mode(), OidcTokenMode::PublicPkceDiscovery);
    let (origin, server) = test_http::serve(1, |_, request| {
        assert!(request.starts_with("GET /t/ck/.well-known/openid-configuration "));
        assert!(!request.to_ascii_lowercase().contains("authorization:"));
        test_http::json(test_http::metadata())
    });
    let mut client = IdentityClient::new(public);
    client.transport = HttpsTransport::local_fixture(origin);
    let attempt = client.begin_login().unwrap();
    assert!(attempt
        .authorization_url()
        .starts_with("https://id.example.test/t/ck/public-authorize?"));
    assert_eq!(
        attempt.endpoints.token.as_str(),
        "https://id.example.test/t/ck/public-token"
    );
    assert_eq!(
        attempt.endpoints.jwks.as_str(),
        "https://id.example.test/t/ck/public-keys"
    );
    assert!(!attempt.authorization_url().contains("offline_access"));
    let params: std::collections::HashMap<_, _> = Url::parse(attempt.authorization_url())
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect();
    assert_eq!(params["scope"], "openid");
    server.join().unwrap();
}
#[test]
fn public_discovery_missing_openid_fails_before_authorization_or_code_exchange() {
    use crate::test_http;
    for omit_field in [false, true] {
        let (origin, server) = test_http::serve(1, move |_, request| {
            assert!(request.starts_with("GET /t/ck/.well-known/openid-configuration "));
            let mut metadata = test_http::metadata();
            if omit_field {
                metadata.as_object_mut().unwrap().remove("scopes_supported");
            } else {
                metadata["scopes_supported"] = json!(["profile", "email"]);
            }
            test_http::json(metadata)
        });
        let mut client = IdentityClient::new(
            config()
                .with_public_pkce_discovery(&["id.example.test"])
                .unwrap(),
        );
        client.transport = HttpsTransport::local_fixture(origin);
        assert_eq!(client.begin_login().unwrap_err(), IdentityError::Discovery);
        server.join().unwrap();
    }
}
#[test]
fn public_discovery_redirect_and_host_changes_fail_before_code_exchange() {
    use crate::test_http;
    for redirected in [true, false] {
        let (origin, server) = test_http::serve(1, move |_, request| {
            assert!(request.starts_with("GET /t/ck/.well-known/openid-configuration "));
            assert!(!request.contains("code="));
            if redirected {
                "HTTP/1.1 302 Found\r\nLocation: https://evil.example/discovery\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned()
            } else {
                let mut data = test_http::metadata();
                data["token_endpoint"] = json!("https://evil.example/collect");
                test_http::json(data)
            }
        });
        let mut client = IdentityClient::new(
            config()
                .with_public_pkce_discovery(&["id.example.test"])
                .unwrap(),
        );
        client.transport = HttpsTransport::local_fixture(origin);
        assert_eq!(
            client.begin_login().unwrap_err(),
            if redirected {
                IdentityError::Http(302)
            } else {
                IdentityError::Discovery
            }
        );
        server.join().unwrap();
    }
}
#[test]
fn public_token_redirect_is_not_followed_or_retried_via_proxy() {
    use crate::test_http;
    let (origin, server) = test_http::serve(2, |index, request| {
        if index == 0 {
            return test_http::json(test_http::metadata());
        }
        assert!(request.starts_with("POST /t/ck/public-token "));
        assert!(!request.contains("client_secret"));
        assert!(!request.to_ascii_lowercase().contains("authorization:"));
        "HTTP/1.1 307 Temporary Redirect\r\nLocation: https://evil.example/collect\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()
    });
    let mut client = IdentityClient::new(
        config()
            .with_public_pkce_discovery(&["id.example.test"])
            .unwrap(),
    );
    client.transport = HttpsTransport::local_fixture(origin);
    let attempt = client.begin_login().unwrap();
    let callback = format!(
        "{}?state={}&code=private-fixture-code",
        attempt.redirect_uri(),
        attempt.state.as_str()
    );
    assert_eq!(
        attempt.finish(&callback).unwrap_err(),
        IdentityError::Http(307)
    );
    server.join().unwrap();
}
#[test]
fn public_native_login_and_cross_client_scope_use_real_http_contracts() {
    use crate::test_http;
    let (pair, jwks) = signer();
    let now = unix_now().unwrap();
    let (expected_send, expected_receive) = std::sync::mpsc::channel::<(String, String)>();
    let mut original_token = String::new();
    let (origin, server) = test_http::serve(6, move |index, request| match index {
        0 => test_http::json(test_http::metadata()),
        1 => {
            assert!(request.starts_with("POST /t/ck/public-token "));
            assert!(!request.to_ascii_lowercase().contains("authorization:"));
            let body = request.split_once("\r\n\r\n").unwrap().1;
            let form: std::collections::HashMap<_, _> =
                url::form_urlencoded::parse(body.as_bytes())
                    .into_owned()
                    .collect();
            let (nonce, challenge) = expected_receive.recv().unwrap();
            assert_eq!(form["client_id"], "fixture-client");
            assert_eq!(form["code"], "public-fixture-code");
            assert_eq!(pkce_challenge(&form["code_verifier"]), challenge);
            assert!(!form.contains_key("client_secret"));
            let mut claims = id_claims(now);
            claims["nonce"] = json!(nonce);
            let mut access = access_claims(now);
            access["client_id"] = json!("fixture-client");
            original_token = signed(&pair, access);
            test_http::json(
                json!({"access_token":original_token,"id_token":signed(&pair, claims),"expires_in":120,"token_type":"Bearer"}),
            )
        }
        2 | 5 => {
            assert!(request.starts_with("GET /t/ck/public-keys "));
            assert!(!request.to_ascii_lowercase().contains("authorization:"));
            test_http::json(serde_json::to_value(&jwks).unwrap())
        }
        3 => {
            assert!(request.starts_with("GET /api/session/workspaces "));
            assert!(request.contains(&format!("Bearer {original_token}")));
            test_http::json(
                json!({"workspaces":[{"slug":"target","name":"目标团队","dbName":"ws_target","role":"admin","lastSelectedAt":null}],"canCreate":false}),
            )
        }
        4 => {
            assert!(request.starts_with("POST /api/session/switch-workspace "));
            assert!(request.contains(&format!("Bearer {original_token}")));
            let body: Value =
                serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_eq!(body, json!({"workspaceSlug":"target"}));
            assert!(!request.contains("client_secret"));
            let mut claims = access_claims(now);
            claims["db"] = json!("ws_target");
            claims["ac"] = json!("admin");
            claims["client_id"] = json!("backend-confidential-client");
            test_http::json(json!({"ok":true,"accessToken":signed(&pair, claims),"expiresIn":600}))
        }
        _ => unreachable!(),
    });
    let mut client = IdentityClient::new(
        config()
            .with_public_pkce_discovery(&["id.example.test"])
            .unwrap(),
    );
    client.transport = HttpsTransport::local_fixture(origin);
    let attempt = client.begin_login().unwrap();
    expected_send
        .send((attempt.nonce.to_string(), pkce_challenge(&attempt.verifier)))
        .unwrap();
    let callback = format!(
        "{}?state={}&code=public-fixture-code",
        attempt.redirect_uri(),
        attempt.state.as_str()
    );
    let session = attempt.finish(&callback).unwrap();
    let scoped = client.switch_workspace(&session, "target").unwrap();
    assert_eq!(scoped.database(), Some("ws_target"));
    assert_eq!(scoped.subject(), session.subject());
    assert!(scoped.expires_at() <= session.expires_at());
    assert_eq!(session.database(), Some("ws_fixture"));
    server.join().unwrap();
}
#[test]
fn scope_token_failures_preserve_original_identity_and_scope() {
    let client = IdentityClient::new(config());
    let now = unix_now().unwrap();
    let (pair, jwks) = signer();
    let previous = client
        .establish(
            Zeroizing::new(signed(&pair, access_claims(now))),
            &signed(&pair, id_claims(now)),
            Some(120),
            "expected-nonce",
            &jwks,
            now,
        )
        .unwrap();
    let mut target = workspace(WorkspaceRole::Admin);
    target.db_name = "ws_target".into();
    let mut valid = access_claims(now);
    valid["db"] = json!("ws_target");
    valid["ac"] = json!("admin");
    valid["client_id"] = json!("backend-confidential-client");
    for (field, value) in [
        ("sub", json!("other-person")),
        ("iss", json!("https://evil.example")),
        ("aud", json!("other-resource")),
        ("db", json!("ws_other")),
        ("ac", json!("participant")),
        ("RL", json!(["Editor"])),
        ("exp", json!(now)),
    ] {
        let mut bad = valid.clone();
        bad[field] = value;
        assert!(
            client
                .scoped_session(
                    &previous,
                    &target,
                    Zeroizing::new(signed(&pair, bad)),
                    Some(120),
                    &jwks,
                    now
                )
                .is_err(),
            "{field}"
        );
        assert_eq!(previous.database(), Some("ws_fixture"));
        assert_eq!(previous.subject(), "person-1");
        assert!(previous.ensure_current().is_ok());
    }
    let (wrong_pair, _) = signer();
    assert!(client
        .scoped_session(
            &previous,
            &target,
            Zeroizing::new(signed(&wrong_pair, valid)),
            Some(120),
            &jwks,
            now
        )
        .is_err());
    assert_eq!(previous.database(), Some("ws_fixture"));
}
#[test]
fn scope_request_http_failure_and_forbidden_target_leave_old_session_valid() {
    use crate::test_http;
    for forbidden in [true, false] {
        let (origin, server) = test_http::serve(
            if forbidden { 1 } else { 2 },
            move |index, request| {
                if index == 0 {
                    return test_http::json(
                        json!({"workspaces":[{"slug":"target","name":"目标团队","dbName":"ws_target","role":"participant","lastSelectedAt":null}],"canCreate":false}),
                    );
                }
                assert!(request.starts_with("POST /api/session/switch-workspace "));
                "HTTP/1.1 403 Forbidden\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecret"
                    .into()
            },
        );
        let mut client = IdentityClient::new(config());
        client.transport = HttpsTransport::local_fixture(origin);
        let now = unix_now().unwrap();
        let (pair, jwks) = signer();
        let session = client
            .establish(
                Zeroizing::new(signed(&pair, access_claims(now))),
                &signed(&pair, id_claims(now)),
                Some(120),
                "expected-nonce",
                &jwks,
                now,
            )
            .unwrap();
        let error = client
            .switch_workspace(&session, if forbidden { "not-listed" } else { "target" })
            .unwrap_err();
        assert_eq!(
            error,
            if forbidden {
                IdentityError::Forbidden
            } else {
                IdentityError::Http(403)
            }
        );
        assert_eq!(session.database(), Some("ws_fixture"));
        assert!(session.ensure_current().is_ok());
        server.join().unwrap();
    }
}

#[test]
fn public_login_rejects_id_token_algorithm_not_advertised_by_discovery() {
    use crate::test_http;
    let (pair, _) = signer();
    let now = unix_now().unwrap();
    let (origin, server) = test_http::serve(2, move |index, _| {
        if index == 0 {
            let mut metadata = test_http::metadata();
            metadata["id_token_signing_alg_values_supported"] = json!(["RS256"]);
            return test_http::json(metadata);
        }
        test_http::json(
            json!({"access_token":signed(&pair,access_claims(now)),"id_token":signed(&pair,id_claims(now)),"expires_in":120,"token_type":"Bearer"}),
        )
    });
    let mut client = IdentityClient::new(
        config()
            .with_public_pkce_discovery(&["id.example.test"])
            .unwrap(),
    );
    client.transport = HttpsTransport::local_fixture(origin);
    let attempt = client.begin_login().unwrap();
    let callback = format!(
        "{}?state={}&code=fixture-code",
        attempt.redirect_uri(),
        attempt.state.as_str()
    );
    assert_eq!(attempt.finish(&callback).unwrap_err(), IdentityError::Token);
    server.join().unwrap();
}
