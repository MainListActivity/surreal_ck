use crate::{IdentityError, LoginAttempt, Result};
use std::{
    net::{IpAddr, SocketAddr, TcpListener},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};
use url::{Host, Url};
use zeroize::Zeroizing;

/// 先 bind 成功，再打开系统浏览器。取消接收任务会关闭 listener；不改变防火墙或系统设置。
/// 仅桌面明确注册的 loopback 回调，不能把它当作 Android 深链实现。
pub struct LoopbackReceiver {
    listener: TcpListener,
    redirect: Url,
}
impl LoopbackReceiver {
    pub fn bind(attempt: &LoginAttempt) -> Result<Self> {
        let redirect =
            Url::parse(attempt.redirect_uri()).map_err(|_| IdentityError::Configuration)?;
        if redirect.scheme() != "http" {
            return Err(IdentityError::CallbackUnsupported);
        }
        let ip = match redirect.host() {
            Some(Host::Ipv4(ip)) if ip == std::net::Ipv4Addr::LOCALHOST => IpAddr::V4(ip),
            Some(Host::Ipv6(ip)) if ip == std::net::Ipv6Addr::LOCALHOST => IpAddr::V6(ip),
            _ => return Err(IdentityError::CallbackUnsupported),
        };
        let port = redirect
            .port()
            .filter(|p| *p != 0)
            .ok_or(IdentityError::CallbackUnsupported)?;
        attempt.remaining()?;
        let listener = TcpListener::bind(SocketAddr::new(ip, port))
            .map_err(|_| IdentityError::CallbackBind)?;
        listener
            .set_nonblocking(true)
            .map_err(|_| IdentityError::CallbackBind)?;
        Ok(Self { listener, redirect })
    }
    /// 不将 URL、code、state 写入响应或日志；返回后仍需一次性 attempt.finish 验证并换票。
    pub async fn receive(self, attempt: &LoginAttempt) -> Result<Zeroizing<String>> {
        if self.redirect.as_str() != attempt.redirect_uri() {
            return Err(IdentityError::Callback);
        }
        let deadline = attempt.remaining()?;
        let listener = tokio::net::TcpListener::from_std(self.listener)
            .map_err(|_| IdentityError::CallbackBind)?;
        timeout(deadline, async {
            loop {
                let (mut stream, peer) = listener.accept().await.map_err(|_| IdentityError::Network)?;
                if !peer.ip().is_loopback() { continue; }
                let candidate = timeout(Duration::from_secs(5), read_callback(&mut stream, &self.redirect)).await;
                let valid = match candidate {
                    Ok(Ok(callback)) => match attempt.validate_callback(&callback) {
                        Ok(_) | Err(IdentityError::LoginRejected) => Some(callback),
                        _ => None,
                    },
                    _ => None,
                };
                let (status, body) = if valid.is_some() {
                    ("200 OK", "Login response received. Return to the app to check the result.")
                } else {
                    ("400 Bad Request", "Invalid login response.")
                };
                let response = format!("HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len());
                let _ = timeout(Duration::from_secs(1), async { stream.write_all(response.as_bytes()).await?; stream.shutdown().await }).await;
                if let Some(callback) = valid { return Ok(callback); }
            }
        }).await.map_err(|_| IdentityError::LoginExpired)?
    }
}
async fn read_callback(stream: &mut TcpStream, redirect: &Url) -> Result<Zeroizing<String>> {
    let mut bytes = Zeroizing::new(Vec::new());
    let mut chunk = [0; 1024];
    loop {
        let count = stream
            .read(&mut chunk)
            .await
            .map_err(|_| IdentityError::Callback)?;
        if count == 0 {
            return Err(IdentityError::Callback);
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() > 8192 {
            return Err(IdentityError::Callback);
        }
        if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| IdentityError::Callback)?;
    parse_request(text, redirect)
}
fn parse_request(request: &str, redirect: &Url) -> Result<Zeroizing<String>> {
    let end = request.find("\r\n\r\n").ok_or(IdentityError::Callback)?;
    if end + 4 != request.len() || request.len() > 8192 {
        return Err(IdentityError::Callback);
    }
    let mut lines = request[..end].split("\r\n");
    let first: Vec<_> = lines
        .next()
        .ok_or(IdentityError::Callback)?
        .split(' ')
        .collect();
    if first.len() != 3
        || first[0] != "GET"
        || first[2] != "HTTP/1.1"
        || !first[1].starts_with('/')
        || first[1].starts_with("//")
    {
        return Err(IdentityError::Callback);
    }
    let authority = format!(
        "{}:{}",
        redirect.host().ok_or(IdentityError::Callback)?,
        redirect.port().ok_or(IdentityError::Callback)?
    );
    let mut hosts = 0;
    for line in lines {
        if line.starts_with([' ', '\t']) {
            return Err(IdentityError::Callback);
        }
        let (key, value) = line.split_once(':').ok_or(IdentityError::Callback)?;
        if key.eq_ignore_ascii_case("host") {
            hosts += 1;
            if value.trim() != authority {
                return Err(IdentityError::Callback);
            }
        }
        if key.eq_ignore_ascii_case("transfer-encoding")
            || (key.eq_ignore_ascii_case("content-length") && value.trim() != "0")
        {
            return Err(IdentityError::Callback);
        }
    }
    if hosts != 1 {
        return Err(IdentityError::Callback);
    }
    let callback = Zeroizing::new(format!("http://{authority}{}", first[1]));
    let parsed = Url::parse(&callback).map_err(|_| IdentityError::Callback)?;
    if parsed.path() != redirect.path() || parsed.fragment().is_some() {
        return Err(IdentityError::Callback);
    }
    Ok(callback)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{IdentityClient, IdentityConfig};
    fn attempt() -> LoginAttempt {
        let temp = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = temp.local_addr().unwrap().port();
        drop(temp);
        IdentityClient::new(
            IdentityConfig::new(
                "https://id.example.test",
                "https://app.example.test",
                "client",
                "aud",
                &format!("http://127.0.0.1:{port}/auth/callback"),
            )
            .unwrap(),
        )
        .begin_login()
        .unwrap()
    }
    #[test]
    fn request_host_path_method_and_size_are_checked() {
        let redirect = Url::parse("http://127.0.0.1:43123/auth/callback").unwrap();
        let valid =
            "GET /auth/callback?code=test&state=test HTTP/1.1\r\nHost: 127.0.0.1:43123\r\n\r\n";
        assert!(parse_request(valid, &redirect).is_ok());
        for invalid in [
            valid.replace("GET", "POST"),
            valid.replace("Host: 127.0.0.1", "Host: evil.test"),
            valid.replace("43123", "43124"),
            valid.replace("auth/callback", "wrong/path"),
            valid.replace("HTTP/1.1", "HTTP/1.0"),
            valid.replace("Host:", "Host: other\r\nHost:"),
            valid.replace("Host:", "Transfer-Encoding: chunked\r\nHost:"),
            valid.replace("Host:", "Content-Length: 4\r\nHost:"),
            format!("{valid}body"),
            valid.replace("code=test", &format!("code={}", "x".repeat(8192))),
        ] {
            assert_eq!(
                parse_request(&invalid, &redirect),
                Err(IdentityError::Callback)
            );
        }
        let ipv6 = Url::parse("http://[::1]:43123/auth/callback").unwrap();
        assert!(parse_request(&valid.replace("127.0.0.1", "[::1]"), &ipv6).is_ok());
    }
    #[tokio::test]
    async fn loopback_receives_only_state_bound_callback_without_leaking_code() {
        let attempt = attempt();
        let receiver = LoopbackReceiver::bind(&attempt).unwrap();
        assert!(matches!(
            LoopbackReceiver::bind(&attempt),
            Err(IdentityError::CallbackBind)
        ));
        let url = Url::parse(attempt.authorization_url()).unwrap();
        let state = url
            .query_pairs()
            .find(|(k, _)| k == "state")
            .unwrap()
            .1
            .to_string();
        let redirect = Url::parse(attempt.redirect_uri()).unwrap();
        let address = format!("127.0.0.1:{}", redirect.port().unwrap());
        let browser = tokio::spawn(async move {
            for state in ["wrong-state".to_owned(), state] {
                let mut stream = TcpStream::connect(&address).await.unwrap();
                let request = format!("GET /auth/callback?state={state}&code=private-test-code HTTP/1.1\r\nHost: {address}\r\n\r\n");
                stream.write_all(request.as_bytes()).await.unwrap();
                let mut response = String::new();
                stream.read_to_string(&mut response).await.unwrap();
                assert!(!response.contains("private-test-code"));
                assert!(!response.contains(&state));
                if state == "wrong-state" {
                    assert!(response.starts_with("HTTP/1.1 400"));
                } else {
                    assert!(response.starts_with("HTTP/1.1 200"));
                }
            }
        });
        let received = receiver.receive(&attempt).await.unwrap();
        assert_eq!(
            attempt.callback_code(&received).unwrap().as_str(),
            "private-test-code"
        );
        browser.await.unwrap();
        assert!(
            LoopbackReceiver::bind(&attempt).is_ok(),
            "successful callback must not prevent a new login"
        );
    }
    #[tokio::test]
    async fn cancelling_receive_releases_bound_port() {
        let attempt = attempt();
        let receiver = LoopbackReceiver::bind(&attempt).unwrap();
        assert!(
            timeout(Duration::from_millis(10), receiver.receive(&attempt))
                .await
                .is_err()
        );
        assert!(LoopbackReceiver::bind(&attempt).is_ok());
    }
    #[test]
    fn custom_scheme_is_explicitly_unsupported_by_receiver() {
        let client = IdentityClient::new(
            IdentityConfig::new(
                "https://id.example.test",
                "https://app.example.test",
                "client",
                "aud",
                "top.maplayer.collaboration:/auth/callback",
            )
            .unwrap(),
        );
        assert!(matches!(
            LoopbackReceiver::bind(&client.begin_login().unwrap()),
            Err(IdentityError::CallbackUnsupported)
        ));
    }
}
