use crate::{IdentityError, Result};
use std::time::Duration;
use url::Url;
use zeroize::Zeroizing;

pub(crate) const MAX_RESPONSE: u64 = 2 * 1024 * 1024;

/// 固定 HTTPS、无自动重定向、无持久 cookie。远端错误正文可能含令牌，不透传。
#[derive(Clone)]
pub struct HttpsTransport {
    agent: ureq::Agent,
    #[cfg(test)]
    test_origin: Option<Url>,
}
impl Default for HttpsTransport {
    fn default() -> Self {
        Self {
            #[cfg(test)]
            test_origin: None,
            agent: ureq::Agent::config_builder()
                .max_redirects(0)
                .max_redirects_will_error(false)
                .http_status_as_error(false)
                .timeout_global(Some(Duration::from_secs(15)))
                .build()
                .into(),
        }
    }
}
impl HttpsTransport {
    // 只编译进单元测试：HTTPS 信任校验不变，仅将通过校验的请求送到本机协议夹具。
    #[cfg(test)]
    pub(crate) fn local_fixture(origin: Url) -> Self {
        Self {
            test_origin: Some(origin),
            ..Self::default()
        }
    }
    fn request_url(&self, url: &Url) -> Url {
        #[cfg(test)]
        if let Some(origin) = &self.test_origin {
            let mut local = origin.clone();
            local.set_path(url.path());
            local.set_query(url.query());
            return local;
        }
        url.clone()
    }
    pub(crate) fn get(&self, url: &Url, token: Option<&str>) -> Result<Zeroizing<Vec<u8>>> {
        let mut request = self
            .agent
            .get(self.request_url(url).as_str())
            .header("Accept", "application/json");
        let header = token.map(|s| Zeroizing::new(format!("Bearer {s}")));
        if let Some(header) = &header {
            request = request.header("Authorization", header.as_str());
        }
        read_response(request.call().map_err(|_| IdentityError::Network)?)
    }
    pub(crate) fn json(&self, url: &Url, token: &str, body: &str) -> Result<Zeroizing<Vec<u8>>> {
        let bearer = Zeroizing::new(format!("Bearer {token}"));
        read_response(
            self.agent
                .post(self.request_url(url).as_str())
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .header("Authorization", bearer.as_str())
                .send(body)
                .map_err(|_| IdentityError::Network)?,
        )
    }
    pub(crate) fn form(&self, url: &Url, form: &str) -> Result<Zeroizing<Vec<u8>>> {
        read_response(
            self.agent
                .post(self.request_url(url).as_str())
                .header("Content-Type", "application/x-www-form-urlencoded")
                .header("Accept", "application/json")
                .send(form)
                .map_err(|_| IdentityError::Network)?,
        )
    }
}
fn read_response(mut response: ureq::http::Response<ureq::Body>) -> Result<Zeroizing<Vec<u8>>> {
    if response.status() != 200 {
        return Err(IdentityError::Http(response.status().as_u16()));
    }
    response
        .body_mut()
        .with_config()
        .limit(MAX_RESPONSE)
        .read_to_vec()
        .map(Zeroizing::new)
        .map_err(|_| IdentityError::Response)
}
pub(crate) fn https_base(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| IdentityError::Configuration)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(IdentityError::Configuration);
    }
    Ok(url)
}
pub(crate) fn endpoint(base: &Url, suffix: &str) -> Url {
    let mut url = base.clone();
    url.set_path(&format!("{}{}", base.path().trim_end_matches('/'), suffix));
    url
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };
    fn fixture(response: &'static str) -> (Url, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut all = vec![];
            let mut buffer = [0u8; 1024];
            loop {
                let size = stream.read(&mut buffer).unwrap();
                all.extend_from_slice(&buffer[..size]);
                let text = String::from_utf8_lossy(&all);
                if let Some(end) = text.find("\r\n\r\n") {
                    let length: usize = text[..end]
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::to_owned)
                        })
                        .unwrap_or_else(|| "0".into())
                        .parse()
                        .unwrap();
                    if all.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8(all).unwrap()
        });
        (
            Url::parse(&format!("http://{address}/api/auth/token")).unwrap(),
            server,
        )
    }
    #[test]
    fn real_http_post_preserves_pkce_and_never_adds_client_secret() {
        let (url, server) =
            fixture("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
        assert_eq!(
            HttpsTransport::default()
                .form(&url, "code=fixture&code_verifier=fixture-verifier")
                .unwrap()
                .as_slice(),
            b"{}"
        );
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /api/auth/token "));
        assert!(request.contains("code_verifier=fixture-verifier"));
        assert!(!request.contains("client_secret"));
        assert!(!request.to_ascii_lowercase().contains("authorization:"));
    }
    #[test]
    fn real_http_errors_are_redacted_and_redirects_are_not_followed() {
        for response in ["HTTP/1.1 403 Forbidden\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecret", "HTTP/1.1 302 Found\r\nLocation: https://evil.test/collect\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecret"] {
            let (url, server) = fixture(response);
            let error = HttpsTransport::default().get(&url, Some("fixture-token")).unwrap_err();
            assert!(matches!(error, IdentityError::Http(403 | 302)));
            assert!(!error.to_string().contains("secret"));
            assert!(!error.to_string().contains("fixture-token"));
            let request = server.join().unwrap().to_ascii_lowercase();
            assert!(request.contains("authorization: bearer fixture-token"));
        }
    }
}
