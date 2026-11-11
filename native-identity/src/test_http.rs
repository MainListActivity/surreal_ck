//! 本机协议夹具；无生产网络、真实凭据或持久认证数据。
use std::{
    io::{Read, Write},
    net::TcpListener,
    thread,
    time::{Duration, Instant},
};
use url::Url;

pub(crate) fn serve(
    count: usize,
    mut reply: impl FnMut(usize, &str) -> String + Send + 'static,
) -> (Url, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let server = thread::spawn(move || {
        let started = Instant::now();
        for index in 0..count {
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(connection) => break connection,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            started.elapsed() < Duration::from_secs(5),
                            "fixture request missing"
                        );
                        thread::sleep(Duration::from_millis(1));
                    }
                    Err(error) => panic!("fixture accept: {error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0; 1024];
            let request = loop {
                let count = stream.read(&mut chunk).unwrap();
                assert_ne!(count, 0);
                bytes.extend_from_slice(&chunk[..count]);
                assert!(bytes.len() <= 65536);
                let text = String::from_utf8(bytes.clone()).unwrap();
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
                    if bytes.len() >= end + 4 + length {
                        break text;
                    }
                }
            };
            stream.write_all(reply(index, &request).as_bytes()).unwrap();
        }
    });
    (Url::parse(&format!("http://{addr}")).unwrap(), server)
}
pub(crate) fn json(body: serde_json::Value) -> String {
    let body = body.to_string();
    format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len())
}
pub(crate) fn metadata() -> serde_json::Value {
    serde_json::json!({"issuer":"https://id.example.test/t/ck","authorization_endpoint":"https://id.example.test/t/ck/public-authorize","token_endpoint":"https://id.example.test/t/ck/public-token","jwks_uri":"https://id.example.test/t/ck/public-keys","response_types_supported":["code"],"grant_types_supported":["authorization_code"],"code_challenge_methods_supported":["S256"],"scopes_supported":["openid"],"token_endpoint_auth_methods_supported":["none"],"id_token_signing_alg_values_supported":["ES256"]})
}
