use crate::{transport::endpoint, IdentityClient, IdentityError, Result, Session};
use serde::Deserialize;
use std::{fmt, time::SystemTime};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use zeroize::Zeroizing;

#[derive(Clone)]
pub struct IceServer {
    pub urls: Vec<String>,
    pub username: Option<Zeroizing<String>>,
    pub credential: Option<Zeroizing<String>>,
}

impl fmt::Debug for IceServer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("IceServer([REDACTED])")
    }
}

#[derive(Clone, Debug)]
pub struct IceServers {
    pub ice_servers: Vec<IceServer>,
    pub expires_at: SystemTime,
}

#[derive(Deserialize)]
struct WireServer {
    urls: Vec<String>,
    username: Option<String>,
    credential: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireConfig {
    ice_servers: Vec<WireServer>,
    ttl_seconds: u16,
    expires_at: String,
}

fn parse(body: &[u8]) -> Result<IceServers> {
    let wire: WireConfig = serde_json::from_slice(body).map_err(|_| IdentityError::Response)?;
    if !(1..=900).contains(&wire.ttl_seconds) || wire.ice_servers.is_empty() {
        return Err(IdentityError::Response);
    }
    let expires_at = OffsetDateTime::parse(&wire.expires_at, &Rfc3339)
        .map_err(|_| IdentityError::Response)?
        .into();
    let mut ice_servers = Vec::with_capacity(wire.ice_servers.len());
    for server in wire.ice_servers {
        let username = server.username.map(Zeroizing::new);
        let credential = server.credential.map(Zeroizing::new);
        let prefixes: &[_] = match (&username, &credential) {
            (None, None) => &["stun:"],
            (Some(user), Some(password)) if !user.is_empty() && !password.is_empty() => {
                &["turn:", "turns:"]
            }
            _ => return Err(IdentityError::Response),
        };
        if server.urls.is_empty()
            || server.urls.iter().any(|url| {
                url.chars().any(|c| c.is_whitespace() || c.is_control())
                    || !prefixes.iter().any(|prefix| {
                        url.strip_prefix(prefix)
                            .is_some_and(|host| !host.is_empty())
                    })
            })
        {
            return Err(IdentityError::Response);
        }
        ice_servers.push(IceServer {
            urls: server.urls,
            username,
            credential,
        });
    }
    Ok(IceServers {
        ice_servers,
        expires_at,
    })
}

impl IdentityClient {
    pub async fn meeting_ice_servers(&self, session: &Session) -> Result<IceServers> {
        self.require_session(session)?;
        let client = self.clone();
        let token = Zeroizing::new(session.access_token().to_owned());
        let result = tokio::task::spawn_blocking(move || client.meeting_ice_with_token(&token))
            .await
            .map_err(|_| IdentityError::Network)?;
        self.require_session(session)?;
        result
    }

    fn meeting_ice_with_token(&self, token: &str) -> Result<IceServers> {
        let body = self
            .transport
            .json(
                &endpoint(&self.config.api_base, "/api/meeting/ice-servers"),
                token,
                "{}",
            )
            .map_err(|error| match error {
                IdentityError::Http(401) => IdentityError::Token,
                IdentityError::Http(403) => IdentityError::Forbidden,
                IdentityError::Http(503) => IdentityError::MeetingUnavailable,
                other => other,
            })?;
        parse(&body)
    }
}
