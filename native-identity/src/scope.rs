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
    /// 已选工作区内的协作会话。当前 token 已是 participant 时返回 `None`（直接沿用）；
    /// 管理员 `ac=admin`（TYPE JWT，`$auth` 为空）时请求后端把同一主体降级为同库
    /// participant RECORD 会话，使信令 `$auth.id` 绑定到本人 user 行。
    /// 新 token 验证失败时返回错误，调用方原有管理员 Session 保持不变；
    /// 管理员专用 HTTP API 仍应使用原 Session。
    pub fn collaboration_session(&self, session: &Session, slug: &str) -> Result<Option<Session>> {
        self.require_session(session)?;
        let list = self.list_workspaces(session)?;
        let target = list
            .workspaces
            .iter()
            .find(|w| w.slug == slug)
            .ok_or(IdentityError::Forbidden)?;
        // 只降级当前已显式选定的工作区；不借此跨库换票。
        session.require_scope(target)?;
        match session.access.as_deref() {
            Some("participant") => return Ok(None),
            Some("admin") => {}
            _ => return Err(IdentityError::WorkspaceNotSelected),
        }
        let body =
            serde_json::json!({"workspaceSlug": target.slug, "dbName": target.db_name}).to_string();
        let response = self.transport.json(
            &endpoint(&self.config.api_base, "/api/session/collaboration-scope"),
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
        self.participant_session(
            session,
            target,
            token,
            response.expires_in,
            &jwks,
            unix_now()?,
        )
        .map(Some)
    }
    /// 异步版本：participant 会话原样复用同一 Arc，管理员则得到新的 participant Arc。
    pub async fn collaboration_session_async(
        &self,
        session: Arc<Session>,
        slug: String,
    ) -> Result<Arc<Session>> {
        let client = self.clone();
        let previous = session.clone();
        let next =
            tokio::task::spawn_blocking(move || client.collaboration_session(&previous, &slug))
                .await
                .map_err(|_| IdentityError::Network)??;
        Ok(next.map_or(session, Arc::new))
    }
    pub(crate) fn participant_session(
        &self,
        previous: &Session,
        target: &Workspace,
        token: Zeroizing<String>,
        expires_in: Option<u64>,
        jwks: &JwkSet,
        now: u64,
    ) -> Result<Session> {
        self.require_session(previous)?;
        previous.require_scope(target)?;
        let claims = verify::verify(
            &token,
            jwks,
            self.config.issuer.as_str().trim_end_matches('/'),
            &self.config.audience,
            now,
        )?;
        if claims.sub != previous.subject()
            || claims.db.as_deref() != Some(target.db_name.as_str())
            || claims.ac.as_deref() != Some("participant")
            // 只能保留剩余有效期，绝不延长。
            || claims.exp > previous.token_expires_at
        {
            return Err(IdentityError::Token);
        }
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
            token_expires_at: claims.exp,
            database: claims.db,
            access: claims.ac,
            roles: claims.roles,
            jwks_uri: previous.jwks_uri.clone(),
        };
        session.require_collaboration_scope(target)?;
        Ok(session)
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
            token_expires_at: claims.exp,
            database: claims.db,
            access: claims.ac,
            roles: claims.roles,
            jwks_uri: previous.jwks_uri.clone(),
        };
        session.require_scope(target)?;
        Ok(session)
    }
}
