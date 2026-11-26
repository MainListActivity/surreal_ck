//! 正式名册会议的 HTTPS 控制面；外部席位不使用工作区身份。
use crate::{
    transport::{endpoint, HttpsTransport},
    IdentityClient, IdentityError, Result, Session, Workspace, WorkspaceRole,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use url::Url;
use zeroize::Zeroizing;

const PUBLIC: &str = "/api/meeting/roster";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Waiting,
    Admitted,
    Replaced,
    Kicked,
    Revoked,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Focus {
    #[default]
    Auto,
    Speaker,
    Screen,
}

#[derive(Deserialize)]
pub struct Status {
    pub state: State,
    pub title: String,
    pub name: String,
    #[serde(default)]
    pub ended: bool,
    #[serde(default)]
    pub focus: Focus,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Host,
    Listener,
}

pub struct Credentials {
    pub url: Url,
    pub token: Zeroizing<String>,
    pub lease_expires_at: u64,
    pub role: Role,
}

fn decode<T: DeserializeOwned>(body: &[u8]) -> Result<T> {
    serde_json::from_slice(body).map_err(|_| IdentityError::Response)
}

fn credentials(body: &[u8], expected: Role) -> Result<Credentials> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Wire {
        url: String,
        token: String,
        lease_expires_at: u64,
        role: Role,
    }
    let wire: Wire = decode(body)?;
    let token = Zeroizing::new(wire.token);
    let url = Url::parse(&wire.url).map_err(|_| IdentityError::Response)?;
    if wire.role != expected
        || url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/api/meeting/sfu/signal"
        || url.query().is_some()
        || url.fragment().is_some()
        || token.is_empty()
    {
        return Err(IdentityError::Response);
    }
    Ok(Credentials {
        url,
        token,
        lease_expires_at: wire.lease_expires_at,
        role: wire.role,
    })
}

pub struct Guest {
    api: Url,
    transport: HttpsTransport,
    cookie: Zeroizing<String>,
}

impl IdentityClient {
    pub fn verify_roster(
        &self,
        invitation: &str,
        code: &str,
        check: Option<&str>,
    ) -> Result<(Guest, Status)> {
        let invitation = Url::parse(invitation).map_err(|_| IdentityError::MeetingInput)?;
        let api = &self.config.api_base;
        if invitation.origin() != api.origin()
            || invitation.path() != "/meeting/roster"
            || invitation.query().is_some()
            || !invitation.username().is_empty()
            || invitation.password().is_some()
        {
            return Err(IdentityError::MeetingInput);
        }
        let mut pass = None;
        for (key, value) in
            url::form_urlencoded::parse(invitation.fragment().unwrap_or("").as_bytes())
        {
            if key == "pass" && pass.replace(value).is_some() {
                return Err(IdentityError::MeetingInput);
            }
        }
        let pass = pass
            .filter(|value| !value.is_empty())
            .ok_or(IdentityError::MeetingInput)?;
        #[derive(Serialize)]
        struct Verification<'a> {
            pass: &'a str,
            code: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            check: Option<&'a str>,
        }
        let body = Zeroizing::new(
            serde_json::to_string(&Verification {
                pass: &pass,
                code,
                check,
            })
            .map_err(|_| IdentityError::MeetingInput)?,
        );
        let (data, cookie) = self.transport.roster(
            "POST",
            &endpoint(api, &format!("{PUBLIC}/verify")),
            &[("Origin", &api.origin().ascii_serialization())],
            Some(&body),
        )?;
        Ok((
            Guest {
                api: api.clone(),
                transport: self.transport.clone(),
                cookie: cookie.ok_or(IdentityError::Response)?,
            },
            decode(&data)?,
        ))
    }

    pub fn roster_host<'a>(
        &'a self,
        session: &'a Session,
        workspace: &Workspace,
    ) -> Result<Host<'a>> {
        if workspace.role != WorkspaceRole::Admin {
            return Err(IdentityError::Forbidden);
        }
        session.require_scope(workspace)?;
        self.require_session(session)?;
        let url = append(
            endpoint(&self.config.api_base, "/api/workspaces"),
            &[&workspace.slug, "roster-meetings"],
        )?;
        Ok(Host {
            client: self,
            session,
            url,
        })
    }
}

impl Guest {
    fn request(&self, method: &str, operation: &str) -> Result<Zeroizing<Vec<u8>>> {
        self.transport
            .roster(
                method,
                &endpoint(&self.api, &format!("{PUBLIC}/{operation}")),
                &[
                    ("Cookie", &self.cookie),
                    ("Origin", &self.api.origin().ascii_serialization()),
                ],
                None,
            )
            .map(|(body, _)| body)
    }

    pub fn status(&self) -> Result<Status> {
        decode(&self.request("GET", "session")?)
    }

    pub fn credentials(&self) -> Result<Credentials> {
        credentials(&self.request("POST", "credentials")?, Role::Listener)
    }

    pub fn raise_hand(&self) -> Result<()> {
        self.request("POST", "raise-hand").map(|_| ())
    }
}

#[derive(Deserialize)]
pub struct Meeting {
    pub id: String,
    pub title: String,
    pub status: String,
    pub room_id: Option<String>,
}

#[derive(Deserialize)]
pub struct Participant {
    pub id: String,
    pub pass: String,
    pub name: String,
    #[serde(rename = "raisedAt")]
    pub raised_at: Option<u64>,
    pub speaking: bool,
}

#[derive(Deserialize)]
pub struct Moderation {
    pub locked: bool,
    pub focus: Focus,
    pub participants: Vec<Participant>,
}

#[derive(Serialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum Command<'a> {
    Lock { locked: bool },
    Focus { focus: Focus },
    Allow { identity: &'a str },
    Withdraw { identity: &'a str },
    MuteAll,
}

pub struct Host<'a> {
    client: &'a IdentityClient,
    session: &'a Session,
    url: Url,
}

fn append(mut url: Url, path: &[&str]) -> Result<Url> {
    if path.iter().any(|part| matches!(*part, "" | "." | "..")) {
        return Err(IdentityError::MeetingInput);
    }
    url.path_segments_mut()
        .map_err(|_| IdentityError::Configuration)?
        .extend(path.iter().copied());
    Ok(url)
}

impl Host<'_> {
    fn request(&self, method: &str, url: Url, body: Option<&str>) -> Result<Zeroizing<Vec<u8>>> {
        self.session.ensure_current()?;
        let bearer = Zeroizing::new(format!("Bearer {}", self.session.access_token()));
        self.client
            .transport
            .roster(method, &url, &[("Authorization", &bearer)], body)
            .map(|(body, _)| body)
    }

    pub fn meetings(&self) -> Result<Vec<Meeting>> {
        #[derive(Deserialize)]
        struct List {
            meetings: Vec<Meeting>,
        }
        Ok(decode::<List>(&self.request("GET", self.url.clone(), None)?)?.meetings)
    }

    pub fn start(&self, meeting: &str) -> Result<String> {
        #[derive(Deserialize)]
        struct Room {
            id: String,
        }
        Ok(decode::<Room>(&self.request(
            "POST",
            append(self.url.clone(), &[meeting, "start"])?,
            None,
        )?)?
        .id)
    }

    pub fn credentials(&self, room: &str) -> Result<Credentials> {
        let url = endpoint(&self.client.config.api_base, "/api/meeting/sfu/rooms");
        credentials(
            &self.request("POST", append(url, &[room, "credentials"])?, None)?,
            Role::Host,
        )
    }

    pub fn moderation(&self, meeting: &str, command: Option<Command<'_>>) -> Result<Moderation> {
        let url = append(self.url.clone(), &[meeting, "moderation"])?;
        let body = command
            .map(|command| serde_json::to_string(&command))
            .transpose()
            .map_err(|_| IdentityError::MeetingInput)?;
        let method = if body.is_some() { "POST" } else { "GET" };
        decode(&self.request(method, url, body.as_deref())?)
    }

    pub fn revoke(&self, meeting: &str, pass: &str) -> Result<()> {
        self.request(
            "DELETE",
            append(self.url.clone(), &[meeting, "passes", pass])?,
            None,
        )
        .map(|_| ())
    }

    pub fn end(&self, meeting: &str) -> Result<()> {
        self.request("POST", append(self.url.clone(), &[meeting, "end"])?, None)
            .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_require_the_expected_role_and_private_signal_endpoint() {
        let body = |url, role| {
            serde_json::json!({
                "url": url, "token": "fixture", "leaseExpiresAt": 100, "role": role
            })
            .to_string()
        };
        let secure = "https://signal.example/api/meeting/sfu/signal";
        assert!(credentials(body(secure, "listener").as_bytes(), Role::Listener).is_ok());
        assert!(credentials(body(secure, "host").as_bytes(), Role::Listener).is_err());
        assert!(credentials(
            body("https://signal.example/rtc", "listener").as_bytes(),
            Role::Listener
        )
        .is_err());
        assert!(credentials(
            body("http://signal.example/api/meeting/sfu/signal", "listener").as_bytes(),
            Role::Listener
        )
        .is_err());
    }

    #[test]
    fn roster_commands_and_opaque_ids_follow_the_wire_contract() {
        assert_eq!(
            serde_json::to_value(Command::MuteAll).unwrap(),
            serde_json::json!({"action": "mute-all"})
        );
        assert_eq!(
            serde_json::to_value(Command::Focus {
                focus: Focus::Screen
            })
            .unwrap(),
            serde_json::json!({"action": "focus", "focus": "screen"})
        );
        let base = Url::parse("https://app.example/roster-meetings").unwrap();
        assert_eq!(
            append(base.clone(), &["meeting:part/part", "end"])
                .unwrap()
                .path(),
            "/roster-meetings/meeting:part%2Fpart/end"
        );
        assert!(append(base, &["..", "end"]).is_err());
    }
}
