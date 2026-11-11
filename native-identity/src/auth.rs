use crate::{
    discovery::{self, LoginEndpoints, OidcTokenMode},
    transport::{endpoint, https_base},
    verify, HttpsTransport, IdentityError, Result,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::jwk::JwkSet;
use ring::rand::{SecureRandom, SystemRandom};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fmt,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use url::Url;
use zeroize::Zeroizing;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdentityConfig {
    pub(crate) issuer: Url,
    pub(crate) api_base: Url,
    client_id: String,
    pub(crate) audience: String,
    redirect_uri: Url,
    token_mode: OidcTokenMode,
    allowed_oidc_hosts: Vec<String>,
}
impl IdentityConfig {
    /// 回调必须已由部署方注册；此方法只检查安全格式，不表示 IdP 已注册。
    /// 使用现有 /api/auth/token 时 client_id 必须与该代理的 confidential client 相同。
    pub fn new(
        issuer: &str,
        api_base: &str,
        client_id: &str,
        audience: &str,
        redirect_uri: &str,
    ) -> Result<Self> {
        let issuer = https_base(issuer)?;
        let api_base = https_base(api_base)?;
        let redirect_uri = Url::parse(redirect_uri).map_err(|_| IdentityError::Configuration)?;
        let loopback = redirect_uri.scheme() == "http"
            && matches!(redirect_uri.host_str(), Some("127.0.0.1" | "[::1]"))
            && redirect_uri.port().is_some_and(|port| port != 0);
        let private_scheme =
            redirect_uri.scheme().contains('.') && !redirect_uri.cannot_be_a_base();
        if (!loopback && !private_scheme)
            || !redirect_uri.username().is_empty()
            || redirect_uri.password().is_some()
            || redirect_uri.query().is_some()
            || redirect_uri.fragment().is_some()
            || redirect_uri.path().is_empty()
            || redirect_uri.path() == "/"
            || client_id.trim().is_empty()
            || client_id == "change_me"
            || audience.trim().is_empty()
        {
            return Err(IdentityError::Configuration);
        }
        Ok(Self {
            issuer,
            api_base,
            client_id: client_id.to_owned(),
            audience: audience.to_owned(),
            redirect_uri,
            token_mode: OidcTokenMode::ConfidentialProxy,
            allowed_oidc_hosts: Vec::new(),
        })
    }
    /// 显式选择独立 native public client；host 必须来自受信任发布配置，而非 discovery/回调。
    pub fn with_public_pkce_discovery(mut self, allowed_hosts: &[&str]) -> Result<Self> {
        let hosts = discovery::allowed_hosts(allowed_hosts)?;
        discovery::allowed_endpoint(self.issuer.as_str(), &hosts)
            .map_err(|_| IdentityError::Configuration)?;
        self.allowed_oidc_hosts = hosts;
        self.token_mode = OidcTokenMode::PublicPkceDiscovery;
        Ok(self)
    }
    pub fn token_mode(&self) -> OidcTokenMode {
        self.token_mode
    }
    /// 无缺省原生 client/redirect，避免把 Web 配置误当原生注册证明。
    pub fn from_env() -> Result<Self> {
        let read = |name| std::env::var(name).map_err(|_| IdentityError::Configuration);
        let config = Self::new(
            &read("SURREAL_CK_OIDC_ISSUER")?,
            &read("SURREAL_CK_API_BASE_URL")?,
            &read("SURREAL_CK_OIDC_CLIENT_ID")?,
            &read("SURREAL_CK_OIDC_AUDIENCE")?,
            &read("SURREAL_CK_NATIVE_REDIRECT_URI")?,
        )?;
        match std::env::var("SURREAL_CK_OIDC_TOKEN_MODE").as_deref() {
            Err(std::env::VarError::NotPresent) | Ok("confidential-proxy") => Ok(config),
            Ok("public-pkce-discovery") => {
                let hosts = read("SURREAL_CK_OIDC_ALLOWED_HOSTS")?;
                config.with_public_pkce_discovery(
                    &hosts.split(',').map(str::trim).collect::<Vec<_>>(),
                )
            }
            _ => Err(IdentityError::Configuration),
        }
    }
}
#[derive(Clone)]
pub struct IdentityClient {
    pub(crate) config: IdentityConfig,
    pub(crate) transport: HttpsTransport,
}
impl IdentityClient {
    pub fn new(config: IdentityConfig) -> Self {
        Self {
            config,
            transport: HttpsTransport::default(),
        }
    }
    /// Public 模式包含 discovery HTTPS；渲染线程应使用 begin_login_async。
    pub fn begin_login(&self) -> Result<LoginAttempt> {
        let endpoints = match self.config.token_mode {
            OidcTokenMode::ConfidentialProxy => LoginEndpoints {
                authorization: endpoint(&self.config.issuer, "/authorize"),
                token: endpoint(&self.config.api_base, "/api/auth/token"),
                jwks: endpoint(&self.config.issuer, "/jwks.json"),
                id_token_algorithms: vec![
                    jsonwebtoken::Algorithm::RS256,
                    jsonwebtoken::Algorithm::ES256,
                ],
            },
            OidcTokenMode::PublicPkceDiscovery => discovery::discover(
                &self.config.issuer,
                &self.config.allowed_oidc_hosts,
                &self.transport,
            )?,
        };
        let random = SystemRandom::new();
        let mut value = [0u8; 32];
        let mut fresh = || {
            random.fill(&mut value).map_err(|_| IdentityError::Random)?;
            Ok::<_, IdentityError>(Zeroizing::new(URL_SAFE_NO_PAD.encode(value)))
        };
        let verifier = fresh()?;
        let state = fresh()?;
        let nonce = fresh()?;
        let mut authorization_url = endpoints.authorization.clone();
        authorization_url.query_pairs_mut().extend_pairs([
            ("response_type", "code"),
            ("client_id", &self.config.client_id),
            ("redirect_uri", self.config.redirect_uri.as_str()),
            // 身份验证只需要 openid；业务 claim 由已注册 client/hook 决定。
            ("scope", "openid"),
            ("audience", &self.config.audience),
            ("state", &state),
            ("nonce", &nonce),
            ("code_challenge", &pkce_challenge(&verifier)),
            ("code_challenge_method", "S256"),
        ]);
        Ok(LoginAttempt {
            authorization_url,
            endpoints,
            verifier,
            state,
            nonce,
            created: Instant::now(),
            client: self.clone(),
        })
    }
    pub async fn begin_login_async(&self) -> Result<LoginAttempt> {
        let client = self.clone();
        tokio::task::spawn_blocking(move || client.begin_login())
            .await
            .map_err(|_| IdentityError::Network)?
    }
    /// 同步有界 HTTPS 调用；原生 UI 应放在工作线程，不在渲染线程调用。
    pub fn list_workspaces(&self, session: &Session) -> Result<WorkspaceList> {
        self.require_session(session)?;
        self.list_workspaces_with_token(session.access_token())
    }
    /// 异步 UI/actor 入口：阻塞 TLS/HTTP 在专用工作线程运行。
    pub async fn list_workspaces_async(&self, session: &Session) -> Result<WorkspaceList> {
        self.require_session(session)?;
        let client = self.clone();
        let token = Zeroizing::new(session.access_token().to_owned());
        let list = tokio::task::spawn_blocking(move || client.list_workspaces_with_token(&token))
            .await
            .map_err(|_| IdentityError::Network)??;
        self.require_session(session)?;
        Ok(list)
    }
    pub(crate) fn require_session(&self, session: &Session) -> Result<()> {
        session.ensure_current()?;
        if session.origin != self.config {
            return Err(IdentityError::Configuration);
        }
        Ok(())
    }
    fn list_workspaces_with_token(&self, token: &str) -> Result<WorkspaceList> {
        let body = self.transport.get(
            &endpoint(&self.config.api_base, "/api/session/workspaces"),
            Some(token),
        )?;
        let list: WorkspaceList =
            serde_json::from_slice(&body).map_err(|_| IdentityError::Response)?;
        if list.workspaces.iter().any(|w| {
            w.slug.is_empty()
                || w.name.is_empty()
                || !safe_identifier(&w.db_name)
                || w.db_name == "_system"
        }) {
            return Err(IdentityError::Response);
        }
        Ok(list)
    }
    fn exchange(&self, attempt: &LoginAttempt, code: &str) -> Result<Session> {
        let form = Zeroizing::new(
            url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs([
                    ("grant_type", "authorization_code"),
                    ("client_id", &self.config.client_id),
                    ("code", code),
                    ("redirect_uri", self.config.redirect_uri.as_str()),
                    ("code_verifier", &attempt.verifier),
                ])
                .finish(),
        );
        let token_body = self.transport.form(&attempt.endpoints.token, &form)?;
        let token: TokenResponse =
            serde_json::from_slice(&token_body).map_err(|_| IdentityError::Response)?;
        let access = Zeroizing::new(token.access_token);
        let id = Zeroizing::new(token.id_token);
        if !token.token_type.eq_ignore_ascii_case("bearer") || token.expires_in == Some(0) {
            return Err(IdentityError::Token);
        }
        let id_header = jsonwebtoken::decode_header(&id).map_err(|_| IdentityError::Token)?;
        if !attempt
            .endpoints
            .id_token_algorithms
            .contains(&id_header.alg)
        {
            return Err(IdentityError::Token);
        }
        let jwks_body = self.transport.get(&attempt.endpoints.jwks, None)?;
        let jwks: JwkSet =
            serde_json::from_slice(&jwks_body).map_err(|_| IdentityError::Response)?;
        let mut session = self.establish(
            access,
            &id,
            token.expires_in,
            &attempt.nonce,
            &jwks,
            unix_now()?,
        )?;
        session.jwks_uri = attempt.endpoints.jwks.clone();
        Ok(session)
    }
    fn establish(
        &self,
        access: Zeroizing<String>,
        id: &str,
        expires_in: Option<u64>,
        nonce: &str,
        jwks: &JwkSet,
        now: u64,
    ) -> Result<Session> {
        let issuer = self.config.issuer.as_str().trim_end_matches('/');
        let identity = verify::verify(id, jwks, issuer, &self.config.client_id, now)?;
        let claims = verify::verify(&access, jwks, issuer, &self.config.audience, now)?;
        if !identity.nonce.as_deref().is_some_and(|v| equal(v, nonce))
            || identity.sub != claims.sub
            || identity
                .azp
                .as_ref()
                .is_some_and(|v| v != &self.config.client_id)
            || (identity.aud.len() > 1 && identity.azp.is_none())
        {
            return Err(IdentityError::Token);
        }
        if let Some(expected) = identity.at_hash {
            let hash = Sha256::digest(access.as_bytes());
            if !equal(&expected, &URL_SAFE_NO_PAD.encode(&hash[..16])) {
                return Err(IdentityError::Token);
            }
        }
        let expires_at = identity
            .exp
            .min(claims.exp)
            .min(expires_in.map_or(u64::MAX, |n| now.saturating_add(n)));
        if expires_at <= now {
            return Err(IdentityError::Token);
        }
        Ok(Session {
            origin: self.config.clone(),
            access_token: access,
            subject: claims.sub,
            expires_at,
            database: claims.db,
            access: claims.ac,
            roles: claims.roles,
            jwks_uri: endpoint(&self.config.issuer, "/jwks.json"),
        })
    }
}

/// 一次性且不 Clone；finish 消耗整个请求，取消时直接 drop。不会打印 verifier/code/token。
pub struct LoginAttempt {
    authorization_url: Url,
    endpoints: LoginEndpoints,
    verifier: Zeroizing<String>,
    state: Zeroizing<String>,
    nonce: Zeroizing<String>,
    created: Instant,
    client: IdentityClient,
}
impl fmt::Debug for LoginAttempt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LoginAttempt([REDACTED])")
    }
}
impl LoginAttempt {
    pub fn authorization_url(&self) -> &str {
        self.authorization_url.as_str()
    }
    pub fn redirect_uri(&self) -> &str {
        self.client.config.redirect_uri.as_str()
    }
    /// 本次登录剩余的正数有效期；平台 receiver 可据此设置等待期限。
    /// 预检或重新读取期限不会延长请求，过期后必须发起新的登录请求。
    pub fn remaining(&self) -> Result<Duration> {
        Duration::from_secs(300)
            .checked_sub(self.created.elapsed())
            .filter(|remaining| !remaining.is_zero())
            .ok_or(IdentityError::LoginExpired)
    }
    /// 预检系统浏览器/平台深链回调，不进行网络请求或暴露授权码。
    /// 与 finish 使用同一验证器：精确 URI、state、可选 issuer、参数和期限。
    /// 合法的拒绝回调返回 LoginRejected，平台 receiver 应把它作为终态处理。
    ///
    /// 此方法只借用请求，不消费它。receiver 负责仅接收一个终态、取消路由并
    /// 丢弃迟到/重复回调；之后仍须调用消费 self 的 finish 或 finish_async。
    /// 取消登录时丢弃 LoginAttempt，新请求不会接受旧请求的 state。
    pub fn validate_callback(&self, raw: &str) -> Result<()> {
        self.callback_code(raw).map(|_| ())
    }
    /// 将令牌交换放入专用阻塞线程；取消外部任务时调用方必须丢弃迟到结果。
    pub async fn finish_async(self, callback: Zeroizing<String>) -> Result<Session> {
        tokio::task::spawn_blocking(move || self.finish(&callback))
            .await
            .map_err(|_| IdentityError::Network)?
    }
    /// 消费本次登录请求并重新验证回调，然后才进行换票。
    /// 已消费或取消的请求不能再次使用：
    ///
    /// ```compile_fail
    /// use surreal_ck_native_identity::LoginAttempt;
    /// fn cannot_reuse(attempt: LoginAttempt) {
    ///     let _ = attempt.finish("");
    ///     let _ = attempt.finish("");
    /// }
    /// ```
    pub fn finish(self, callback_url: &str) -> Result<Session> {
        let code = self.callback_code(callback_url)?;
        self.client.exchange(&self, &code)
    }
    pub(crate) fn callback_code(&self, raw: &str) -> Result<Zeroizing<String>> {
        self.remaining()?;
        let mut callback = Url::parse(raw).map_err(|_| IdentityError::Callback)?;
        if callback.fragment().is_some() || raw.len() > 16 * 1024 {
            return Err(IdentityError::Callback);
        }
        let pairs: Vec<_> = callback.query_pairs().into_owned().collect();
        callback.set_query(None);
        if callback != self.client.config.redirect_uri {
            return Err(IdentityError::Callback);
        }
        let one = |name: &str| -> Result<Option<&str>> {
            let found: Vec<_> = pairs.iter().filter(|(k, _)| k == name).collect();
            if found.len() > 1 {
                return Err(IdentityError::Callback);
            }
            Ok(found.first().map(|(_, v)| v.as_str()))
        };
        if !one("state")?.is_some_and(|s| equal(s, &self.state)) {
            return Err(IdentityError::Callback);
        }
        if one("iss")?
            .is_some_and(|s| s != self.client.config.issuer.as_str().trim_end_matches('/'))
        {
            return Err(IdentityError::Callback);
        }
        if one("error")?.is_some() {
            return Err(IdentityError::LoginRejected);
        }
        let code = one("code")?
            .filter(|s| !s.is_empty())
            .ok_or(IdentityError::Callback)?;
        Ok(Zeroizing::new(code.to_owned()))
    }
}

pub struct Session {
    pub(crate) origin: IdentityConfig,
    pub(crate) access_token: Zeroizing<String>,
    pub(crate) subject: String,
    pub(crate) expires_at: u64,
    pub(crate) database: Option<String>,
    pub(crate) access: Option<String>,
    pub(crate) roles: Vec<String>,
    pub(crate) jwks_uri: Url,
}
impl fmt::Debug for Session {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Session([REDACTED])")
    }
}
impl Session {
    pub fn subject(&self) -> &str {
        &self.subject
    }
    pub fn expires_at(&self) -> u64 {
        self.expires_at
    }
    pub fn database(&self) -> Option<&str> {
        self.database.as_deref()
    }
    pub fn ensure_current(&self) -> Result<()> {
        if unix_now()? >= self.expires_at {
            Err(IdentityError::SessionExpired)
        } else {
            Ok(())
        }
    }
    pub(crate) fn access_token(&self) -> &str {
        &self.access_token
    }
    pub(crate) fn require_scope(&self, workspace: &Workspace) -> Result<()> {
        self.ensure_current()?;
        if self.database.as_deref() != Some(&workspace.db_name)
            || self.access.as_deref() != Some(workspace.role.access_name())
        {
            return Err(IdentityError::WorkspaceNotSelected);
        }
        // participant 是 RECORD access，RL=[Owner] 也不意味着管理员；权限仍由数据库判定。
        if workspace.role == WorkspaceRole::Admin && !self.roles.iter().any(|r| r == "Owner") {
            return Err(IdentityError::Token);
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceRole {
    Admin,
    Participant,
}
impl WorkspaceRole {
    pub fn access_name(&self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Participant => "participant",
        }
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub slug: String,
    pub name: String,
    pub db_name: String,
    pub role: WorkspaceRole,
    pub last_selected_at: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceList {
    pub workspaces: Vec<Workspace>,
    pub can_create: bool,
}
#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    id_token: String,
    token_type: String,
    expires_in: Option<u64>,
}
fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
fn equal(a: &str, b: &str) -> bool {
    bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}
pub(crate) fn safe_identifier(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}
pub(crate) fn unix_now() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| IdentityError::SessionExpired)
}

#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;
