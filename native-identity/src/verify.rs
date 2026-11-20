use crate::{IdentityError, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use serde::Deserialize;

#[derive(Clone, Deserialize)]
#[serde(untagged)]
pub(crate) enum Audience {
    One(String),
    Many(Vec<String>),
}
impl Audience {
    pub(crate) fn len(&self) -> usize {
        match self {
            Self::One(_) => 1,
            Self::Many(a) => a.len(),
        }
    }
    pub(crate) fn contains(&self, value: &str) -> bool {
        match self {
            Self::One(a) => a == value,
            Self::Many(a) => a.iter().any(|a| a == value),
        }
    }
}
#[derive(Clone, Deserialize)]
pub(crate) struct Claims {
    pub sub: String,
    pub iss: String,
    pub aud: Audience,
    pub exp: u64,
    pub iat: u64,
    pub nbf: Option<u64>,
    pub nonce: Option<String>,
    pub azp: Option<String>,
    pub at_hash: Option<String>,
    pub db: Option<String>,
    pub ac: Option<String>,
    #[serde(rename = "RL", default)]
    pub roles: Vec<String>,
}
/// 只允许非对称 RS256/ES256；JWKS 地址由受信任配置生成，忽略 JWT 的 jku/x5u。
pub(crate) fn verify(
    token: &str,
    jwks: &JwkSet,
    issuer: &str,
    audience: &str,
    now: u64,
) -> Result<Claims> {
    let raw_header = token.split('.').next().ok_or(IdentityError::Token)?;
    let header_json: serde_json::Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(raw_header)
            .map_err(|_| IdentityError::Token)?,
    )
    .map_err(|_| IdentityError::Token)?;
    // 本模块不支持任何 JWS critical extension，不能悄悄忽略。
    if header_json.get("crit").is_some() {
        return Err(IdentityError::Token);
    }
    let header = decode_header(token).map_err(|_| IdentityError::Token)?;
    if !matches!(header.alg, Algorithm::RS256 | Algorithm::ES256) {
        return Err(IdentityError::Token);
    }
    let kid = header.kid.ok_or(IdentityError::Token)?;
    let candidates: Vec<_> = jwks
        .keys
        .iter()
        .filter(|j| j.common.key_id.as_ref() == Some(&kid))
        .collect();
    if candidates.len() != 1 {
        return Err(IdentityError::Token);
    }
    let jwk = candidates[0];
    let json = serde_json::to_value(jwk).map_err(|_| IdentityError::Token)?;
    let expected_alg = match header.alg {
        Algorithm::RS256 => "RS256",
        _ => "ES256",
    };
    if json.get("alg").is_some_and(|v| v != expected_alg)
        || json.get("use").is_some_and(|v| v != "sig")
        || json.get("key_ops").is_some_and(|v| {
            !v.as_array()
                .is_some_and(|a| a.iter().any(|v| v == "verify"))
        })
    {
        return Err(IdentityError::Token);
    }
    let key = DecodingKey::from_jwk(jwk).map_err(|_| IdentityError::Token)?;
    let mut validation = Validation::new(header.alg);
    validation.set_issuer(&[issuer]);
    validation.set_audience(&[audience]);
    validation.set_required_spec_claims(&["exp", "sub", "iss", "aud", "iat"]);
    // 注入时钟便于精确测试，签名校验始终启用；时间在下一行严格校验。
    validation.validate_exp = false;
    validation.validate_nbf = false;
    let claims = decode::<Claims>(token, &key, &validation)
        .map_err(|_| IdentityError::Token)?
        .claims;
    if claims.sub.is_empty()
        || claims.iss != issuer
        || !claims.aud.contains(audience)
        || claims.exp <= now
        || claims.iat > now.saturating_add(60)
        || claims.nbf.is_some_and(|nbf| nbf > now)
        || claims.iat >= claims.exp
    {
        return Err(IdentityError::Token);
    }
    Ok(claims)
}
