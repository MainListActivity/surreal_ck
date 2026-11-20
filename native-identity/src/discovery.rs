//! Public PKCE 模式只接受受信任 issuer 与显式主机白名单中的 HTTPS endpoints。
use crate::{
    transport::{endpoint, https_base},
    HttpsTransport, IdentityError, Result,
};
use jsonwebtoken::Algorithm;
use serde::Deserialize;
use url::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OidcTokenMode {
    /// 默认兼容既有 Web confidential proxy；不会自动升级到 public client。
    ConfidentialProxy,
    /// 独立原生 public client，PKCE 换票直达经过验证的 discovery token_endpoint。
    PublicPkceDiscovery,
}
#[derive(Clone, Debug)]
pub(crate) struct LoginEndpoints {
    pub authorization: Url,
    pub token: Url,
    pub jwks: Url,
    pub id_token_algorithms: Vec<Algorithm>,
}
#[derive(Deserialize)]
struct Metadata {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    response_types_supported: Vec<String>,
    grant_types_supported: Vec<String>,
    code_challenge_methods_supported: Vec<String>,
    scopes_supported: Vec<String>,
    token_endpoint_auth_methods_supported: Vec<String>,
    id_token_signing_alg_values_supported: Vec<String>,
}
pub(crate) fn allowed_hosts(hosts: &[&str]) -> Result<Vec<String>> {
    if hosts.is_empty() {
        return Err(IdentityError::Configuration);
    }
    let mut result = Vec::new();
    for host in hosts {
        if host.is_empty() || host.contains('*') || host.bytes().any(|b| b.is_ascii_whitespace()) {
            return Err(IdentityError::Configuration);
        }
        let url = https_base(&format!("https://{host}"))?;
        if url.path() != "/" || url.port().is_some() || url.host_str() != Some(*host) {
            return Err(IdentityError::Configuration);
        }
        if !result.iter().any(|entry| entry == host) {
            result.push((*host).to_owned());
        }
    }
    Ok(result)
}
pub(crate) fn allowed_endpoint(raw: &str, hosts: &[String]) -> Result<Url> {
    let url = https_base(raw).map_err(|_| IdentityError::Discovery)?;
    if url.port_or_known_default() != Some(443)
        || !hosts
            .iter()
            .any(|host| Some(host.as_str()) == url.host_str())
    {
        return Err(IdentityError::Discovery);
    }
    Ok(url)
}
pub(crate) fn discover(
    issuer: &Url,
    hosts: &[String],
    transport: &HttpsTransport,
) -> Result<LoginEndpoints> {
    allowed_endpoint(issuer.as_str(), hosts)?;
    let location = endpoint(issuer, "/.well-known/openid-configuration");
    let response = transport.get(&location, None)?;
    validate_metadata(&response, issuer, hosts)
}
fn validate_metadata(bytes: &[u8], issuer: &Url, hosts: &[String]) -> Result<LoginEndpoints> {
    let data: Metadata = serde_json::from_slice(bytes).map_err(|_| IdentityError::Discovery)?;
    if data.issuer != issuer.as_str().trim_end_matches('/')
        || !data.response_types_supported.iter().any(|v| v == "code")
        || !data
            .grant_types_supported
            .iter()
            .any(|v| v == "authorization_code")
        || !data
            .code_challenge_methods_supported
            .iter()
            .any(|v| v == "S256")
        || !data
            .token_endpoint_auth_methods_supported
            .iter()
            .any(|v| v == "none")
        || !data.scopes_supported.iter().any(|v| v == "openid")
        || !data
            .id_token_signing_alg_values_supported
            .iter()
            .any(|v| matches!(v.as_str(), "RS256" | "ES256"))
    {
        return Err(IdentityError::Discovery);
    }
    Ok(LoginEndpoints {
        authorization: allowed_endpoint(&data.authorization_endpoint, hosts)?,
        token: allowed_endpoint(&data.token_endpoint, hosts)?,
        jwks: allowed_endpoint(&data.jwks_uri, hosts)?,
        id_token_algorithms: data
            .id_token_signing_alg_values_supported
            .iter()
            .filter_map(|value| match value.as_str() {
                "RS256" => Some(Algorithm::RS256),
                "ES256" => Some(Algorithm::ES256),
                _ => None,
            })
            .collect(),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn metadata() -> serde_json::Value {
        json!({"issuer":"https://id.example.test/t/ck","authorization_endpoint":"https://id.example.test/t/ck/authorize","token_endpoint":"https://id.example.test/t/ck/token","jwks_uri":"https://id.example.test/t/ck/jwks.json","response_types_supported":["code"],"grant_types_supported":["authorization_code"],"code_challenge_methods_supported":["S256"],"scopes_supported":["openid"],"token_endpoint_auth_methods_supported":["none"],"id_token_signing_alg_values_supported":["RS256"]})
    }
    #[test]
    fn discovery_requires_exact_issuer_pkce_public_client_and_trusted_https_hosts() {
        let issuer = Url::parse("https://id.example.test/t/ck").unwrap();
        let hosts = allowed_hosts(&["id.example.test"]).unwrap();
        assert!(
            validate_metadata(&serde_json::to_vec(&metadata()).unwrap(), &issuer, &hosts).is_ok()
        );
        for field in ["token_endpoint", "authorization_endpoint", "jwks_uri"] {
            for url in [
                "http://id.example.test/token",
                "https://evil.example/token",
                "https://id.example.test.evil.example/token",
                "https://id.example.test:8443/token",
                "https://user:password@id.example.test/token",
                "https://id.example.test/token?destination=evil",
                "https://id.example.test/token#fragment",
            ] {
                let mut data = metadata();
                data[field] = json!(url);
                assert!(
                    validate_metadata(&serde_json::to_vec(&data).unwrap(), &issuer, &hosts)
                        .is_err()
                );
            }
        }
        for (field, invalid) in [
            ("issuer", json!("https://id.example.test/t/other")),
            ("issuer", json!("https://id.example.test/t/ck/")),
            ("code_challenge_methods_supported", json!(["plain"])),
            (
                "token_endpoint_auth_methods_supported",
                json!(["client_secret_basic"]),
            ),
            ("response_types_supported", json!(["token"])),
            ("grant_types_supported", json!(["client_credentials"])),
            ("scopes_supported", json!(["profile", "email"])),
            ("id_token_signing_alg_values_supported", json!(["HS256"])),
        ] {
            let mut data = metadata();
            data[field] = invalid;
            assert!(
                validate_metadata(&serde_json::to_vec(&data).unwrap(), &issuer, &hosts).is_err()
            );
        }
    }
    #[test]
    fn public_discovery_requires_explicit_openid_scope_without_asking_for_extra_scopes() {
        let issuer = Url::parse("https://id.example.test/t/ck").unwrap();
        let hosts = allowed_hosts(&["id.example.test"]).unwrap();
        for scopes in [
            json!([]),
            json!(["openid profile email"]),
            json!(["OpenID"]),
            json!(null),
        ] {
            let mut data = metadata();
            data["scopes_supported"] = scopes;
            assert!(
                validate_metadata(&serde_json::to_vec(&data).unwrap(), &issuer, &hosts).is_err()
            );
        }
        let mut missing = metadata();
        missing.as_object_mut().unwrap().remove("scopes_supported");
        assert!(
            validate_metadata(&serde_json::to_vec(&missing).unwrap(), &issuer, &hosts).is_err()
        );
        let mut managed = metadata();
        managed["scopes_supported"] = json!(["openid", "content.read", "content.publish"]);
        assert!(validate_metadata(&serde_json::to_vec(&managed).unwrap(), &issuer, &hosts).is_ok());
    }
    #[test]
    fn host_allowlist_is_explicit_and_not_a_suffix_or_url_pattern() {
        assert!(allowed_hosts(&[]).is_err());
        for host in [
            "*.example.test",
            "id.example.test:443",
            "id.example.test/path",
            "user@id.example.test",
            "https://id.example.test",
            "ID.example.test",
        ] {
            assert!(allowed_hosts(&[host]).is_err(), "{host}");
        }
        let issuer = Url::parse("https://id.example.test/t/ck").unwrap();
        let mut data = metadata();
        data["token_endpoint"] = json!("https://token.example.test/token");
        let hosts = allowed_hosts(&["id.example.test", "token.example.test"]).unwrap();
        assert!(validate_metadata(&serde_json::to_vec(&data).unwrap(), &issuer, &hosts).is_ok());
    }
}
