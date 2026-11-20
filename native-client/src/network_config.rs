//! 显式 ICE 配置：默认仅本地候选，绝不内置第三方服务或持久化 TURN 凭据。
use std::{
    fmt,
    net::{Ipv4Addr, Ipv6Addr},
};
use surreal_ck_peer_transport::Route;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionMode {
    Direct,
    Relay,
    RelayPossible,
}
impl ConnectionMode {
    pub(crate) fn with_remote_relay(self, remote_relay: bool) -> Self {
        if self == Self::Direct && remote_relay {
            Self::RelayPossible
        } else {
            self
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Direct => "已连接 · P2P 直连",
            Self::Relay => "已连接 · TURN 中继",
            Self::RelayPossible => "已连接 · 对端提供中继，实际路径待核验",
        }
    }
}

#[derive(Default)]
pub struct ConnectionSettings {
    stun: Vec<String>,
    relay: Option<RelaySettings>,
}
struct RelaySettings {
    urls: Vec<String>,
    username: String,
    credential: String,
}
impl fmt::Debug for ConnectionSettings {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnectionSettings")
            .field("mode", &self.mode())
            .finish_non_exhaustive()
    }
}
impl ConnectionSettings {
    /// 输入为空表示仅本地候选；填写服务即明确选择向该服务披露网络地址。
    pub fn direct(stun: &str) -> Result<Self, String> {
        if stun.split_whitespace().any(|url| url.starts_with("stuns:")) {
            return Err(
                "本版本尚未实现 STUN over TLS（stuns:）；请显式选择支持的 stun: 服务，不会降级连接"
                    .into(),
            );
        }
        Ok(Self {
            stun: parse_urls(stun, false)?,
            relay: None,
        })
    }
    /// 只有明确点击失败后中继重试才应构造；不把 STUN 称为中继。
    pub fn relay(urls: &str, username: &str, credential: &str) -> Result<Self, String> {
        let urls = parse_urls(urls, true)?;
        if urls.is_empty()
            || username.trim().is_empty()
            || credential.is_empty()
            || username.len() > 1024
            || credential.len() > 4096
            || username.chars().any(char::is_control)
            || credential.chars().any(char::is_control)
        {
            return Err("请填写 TURN 服务、用户名和密码，且不可包含控制字符".into());
        }
        Ok(Self {
            stun: vec![],
            relay: Some(RelaySettings {
                urls,
                username: username.into(),
                credential: credential.into(),
            }),
        })
    }
    pub fn mode(&self) -> ConnectionMode {
        if self.relay.is_some() {
            ConnectionMode::Relay
        } else {
            ConnectionMode::Direct
        }
    }
    pub(crate) fn into_transport(self) -> (Route, Vec<String>) {
        let route = match self.relay {
            None => Route::Direct,
            Some(r) => Route::RelayFallback {
                urls: r.urls,
                username: r.username,
                credential: r.credential,
            },
        };
        (route, self.stun)
    }
}
fn parse_urls(input: &str, relay: bool) -> Result<Vec<String>, String> {
    if input.len() > 8192
        || input
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
    {
        return Err("ICE 服务列表过长或含非法字符".into());
    }
    let urls: Vec<_> = input.split_whitespace().map(str::to_owned).collect();
    if urls.len() > 8 || urls.iter().any(|url| !valid_url(url, relay)) {
        return Err(if relay { "TURN 地址格式无效：使用 turn:主机:端口 或 turns:主机:端口，可附 ?transport=udp/tcp；禁止用户名、密码、路径和片段" } else { "STUN 地址格式无效：使用 stun:主机:端口；禁止用户名、密码、路径和查询参数" }.into());
    }
    Ok(urls)
}
fn valid_url(url: &str, relay: bool) -> bool {
    if url.len() > 1024 || !url.is_ascii() || url.contains(['@', '/', '#', '%', '\\']) {
        return false;
    }
    let Some((scheme, rest)) = url.split_once(':') else {
        return false;
    };
    if !if relay {
        matches!(scheme, "turn" | "turns")
    } else {
        scheme == "stun"
    } {
        return false;
    }
    let authority = if let Some((authority, query)) = rest.split_once('?') {
        if !relay
            || !matches!(query, "transport=udp" | "transport=tcp")
            || (scheme == "turns" && query == "transport=udp")
        {
            return false;
        }
        authority
    } else {
        rest
    };
    let (host, port) = if let Some(stripped) = authority.strip_prefix('[') {
        let Some((host, suffix)) = stripped.split_once(']') else {
            return false;
        };
        if host.parse::<Ipv6Addr>().is_err() {
            return false;
        }
        if suffix.is_empty() {
            return true;
        }
        let Some(port) = suffix.strip_prefix(':') else {
            return false;
        };
        (host, Some(port))
    } else {
        let (host, port) = match authority.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        };
        if host.is_empty() || host.len() > 253 {
            return false;
        }
        if host.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
            if host.parse::<Ipv4Addr>().is_err() {
                return false;
            }
        } else if !host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        }) {
            return false;
        }
        (host, port)
    };
    let _ = host;
    port.is_none_or(|p| {
        !p.is_empty()
            && p.bytes().all(|b| b.is_ascii_digit())
            && p.parse::<u16>().is_ok_and(|n| n != 0)
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_candidates_are_not_selected_pair_measurements() {
        assert_eq!(
            ConnectionMode::Direct.with_remote_relay(false),
            ConnectionMode::Direct
        );
        assert_eq!(
            ConnectionMode::Direct.with_remote_relay(true),
            ConnectionMode::RelayPossible
        );
        assert_eq!(
            ConnectionMode::Relay.with_remote_relay(true),
            ConnectionMode::Relay
        );
        assert!(ConnectionMode::RelayPossible.label().contains("路径待核验"));
        assert!(!ConnectionMode::RelayPossible.label().contains("P2P"));
    }
    #[test]
    fn default_never_contacts_service() {
        let (route, stun) = ConnectionSettings::default().into_transport();
        assert!(matches!(route, Route::Direct));
        assert!(stun.is_empty());
    }
    #[test]
    fn validates_without_network() {
        for url in ["stun:example.org:3478", "stun:[::1]:3478", "stun:127.0.0.1"] {
            assert!(ConnectionSettings::direct(url).is_ok(), "{url}");
        }
        for url in [
            "stuns:example.org:5349",
            "https://example.org",
            "stun://example.org",
            "stun:user:secret@example.org",
            "stun:example.org:0",
            "stun:example.org:65536",
            "stun:example.org/path",
            "stun:example.org?transport=udp",
            "stun:-bad.org",
            "stun:bad..org",
            "stun:999.0.0.1",
            "stun:[oops]",
            "turn:example.org",
            "stun:example.org#secret",
        ] {
            assert!(ConnectionSettings::direct(url).is_err(), "{url}");
        }
        assert!(
            ConnectionSettings::relay("turn:example.org:3478?transport=udp", "user", "password")
                .is_ok()
        );
        assert!(
            ConnectionSettings::relay("turns:example.org:5349?transport=tcp", "user", "password")
                .is_ok()
        );
        assert!(
            ConnectionSettings::relay("turns:example.org?transport=udp", "user", "password")
                .is_err()
        );
    }
    #[test]
    fn secrets_never_appear_in_debug_or_validation_errors() {
        let settings =
            ConnectionSettings::relay("turn:example.org", "private-user", "private-secret")
                .unwrap();
        let debug = format!("{settings:?}");
        assert!(!debug.contains("private-"));
        let error = ConnectionSettings::relay(
            "turn:private-user:private-secret@example.org",
            "user",
            "password",
        )
        .unwrap_err();
        assert!(!error.contains("private-"));
    }
}
