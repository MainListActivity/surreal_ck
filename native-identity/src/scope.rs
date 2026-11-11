//! Workspace Scope Module 的显式调用。原生客户端不直接调用 IdP /scope，也不持有 secret。
use crate::{
    auth::unix_now, transport::endpoint, verify, IdentityClient, IdentityError, Result, Session,
    Workspace,
};
use jsonwebtoken::jwk::JwkSet;
use serde::Deserialize;
use std::sync::Arc;
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScopeResponse {
    ok: bool,
    access_token: String,
    expires_in: Option<u64>,
}
impl IdentityClient {
    /// 用户明确选定 slug 后调用；后端会更新 last_selected_at 并换 scope，不是只读方法。
    /// 先获取权威列表，后端再次鉴权；新会话验证成功前不修改/销毁旧会话。
    pub fn switch_workspace(&self, session: &Session, slug: &str) -> Result<Session> {
        self.require_session(session)?;
        let list = self.list_workspaces(session)?;
        let target = list
            .workspaces
            .iter()
            .find(|w| w.slug == slug)
            .ok_or(IdentityError::Forbidden)?;
        let body = serde_json::json!({"workspaceSlug": target.slug}).to_string();
        let response = self.transport.json(
            &endpoint(&self.config.api_base, "/api/session/switch-workspace"),
            session.access_token(),
            &body,
        )?;
        let response: ScopeResponse =
            serde_json::from_slice(&response).map_err(|_| IdentityError::Response)?;
        let token = Zeroizing::new(response.access_token);
        if !response.ok || response.expires_in == Some(0) {
            return Err(IdentityError::Token);
        }
        let jwks_body = self.transport.get(&session.jwks_uri, None)?;
        let jwks: JwkSet =
            serde_json::from_slice(&jwks_body).map_err(|_| IdentityError::Response)?;
        self.scoped_session(
            session,
            target,
            token,
            response.expires_in,
            &jwks,
            unix_now()?,
        )
    }
    /// 会话由后台 actor 的 Arc 保管；返回新 Session 后调用方仍需检查登录代际再替换。
    pub async fn switch_workspace_async(
        &self,
        session: Arc<Session>,
        slug: String,
    ) -> Result<Session> {
        let client = self.clone();
        tokio::task::spawn_blocking(move || client.switch_workspace(&session, &slug))
            .await
            .map_err(|_| IdentityError::Network)?
    }
    pub(crate) fn scoped_session(
        &self,
        previous: &Session,
        target: &Workspace,
        token: Zeroizing<String>,
        expires_in: Option<u64>,
        jwks: &JwkSet,
        now: u64,
    ) -> Result<Session> {
        self.require_session(previous)?;
        let claims = verify::verify(
            &token,
            jwks,
            self.config.issuer.as_str().trim_end_matches('/'),
            &self.config.audience,
            now,
        )?;
        if claims.sub != previous.subject() {
            return Err(IdentityError::Token);
        }
        // ma_hono 同租户同 audience 的 scope 换票允许 client_id 改为后端 confidential client。
        // 不因 client_id 不同拒绝；仍必须验证签名/issuer/audience/sub/db/ac 与剩余有效期。
        let expires_at = claims
            .exp
            .min(previous.expires_at())
            .min(expires_in.map_or(u64::MAX, |s| now.saturating_add(s)));
        if expires_at <= now {
            return Err(IdentityError::Token);
        }
        let session = Session {
            origin: previous.origin.clone(),
            access_token: token,
            subject: claims.sub,
            expires_at,
            database: claims.db,
            access: claims.ac,
            roles: claims.roles,
            jwks_uri: previous.jwks_uri.clone(),
        };
        session.require_scope(target)?;
        Ok(session)
    }
}
