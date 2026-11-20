use crate::{auth::safe_identifier, IdentityClient, IdentityError, Result, Session};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::{
    io::{AsyncRead, AsyncWrite},
    time::timeout,
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
    WebSocketStream,
};
use url::Url;

// 与 web/src/lib/members-data.ts 完全一致；不引入通用查询或跨库权限子查询。
const MEMBERS_QUERY: &str = "SELECT id, display_name, email, is_admin, subject FROM user WHERE kind = 'human' AND disabled_at = NONE";
#[derive(Clone, Debug)]
pub struct SurrealConfig {
    pub(crate) endpoint: Url,
    pub(crate) namespace: String,
}
impl SurrealConfig {
    pub fn new(endpoint: &str, namespace: &str) -> Result<Self> {
        let endpoint = Url::parse(endpoint).map_err(|_| IdentityError::Configuration)?;
        if endpoint.scheme() != "wss"
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || endpoint.path() != "/rpc"
            || !safe_identifier(namespace)
        {
            return Err(IdentityError::Configuration);
        }
        Ok(Self {
            endpoint,
            namespace: namespace.to_owned(),
        })
    }
    pub fn from_env() -> Result<Self> {
        let url =
            std::env::var("SURREAL_CK_SURREAL_URL").map_err(|_| IdentityError::Configuration)?;
        let ns = std::env::var("SURREAL_CK_SURREAL_NS").unwrap_or_else(|_| "main".into());
        Self::new(&url, &ns)
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub id: String,
    pub display_name: Option<String>,
    pub email: String,
    pub is_admin: bool,
    pub pending: bool,
}
#[derive(Deserialize)]
struct MemberRow {
    id: String,
    display_name: Option<String>,
    email: String,
    is_admin: Option<bool>,
    subject: Option<String>,
}

/// 重新获取服务端工作区索引，以用户当前 JWT 直连 WSS：use → authenticate → 只读查询。
/// 不切换 scope、不写成员；非当前库明确返回 WorkspaceNotSelected。授权由数据库最终判定。
pub async fn load_members(
    client: &IdentityClient,
    session: &Session,
    config: &SurrealConfig,
    slug: &str,
) -> Result<Vec<Member>> {
    let workspaces = client.list_workspaces_async(session).await?;
    let workspace = workspaces
        .workspaces
        .iter()
        .find(|w| w.slug == slug)
        .ok_or(IdentityError::Forbidden)?;
    session.require_collaboration_scope(workspace)?;
    let mut socket = connect_authenticated(session, config, workspace).await?;
    let result = timeout(Duration::from_secs(30), async {
        let data = rpc(&mut socket, 3, "query", json!([MEMBERS_QUERY, {}])).await?;
        parse_members(data)
    })
    .await
    .map_err(|_| IdentityError::Network)
    .and_then(|r| r);
    let _ = timeout(Duration::from_secs(1), socket.close(None)).await;
    result
}
pub(crate) type DatabaseSocket =
    WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
pub(crate) async fn connect_authenticated(
    session: &Session,
    config: &SurrealConfig,
    workspace: &crate::Workspace,
) -> Result<DatabaseSocket> {
    session.require_collaboration_scope(workspace)?;
    let mut request = config
        .endpoint
        .as_str()
        .into_client_request()
        .map_err(|_| IdentityError::Configuration)?;
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        "json".parse().map_err(|_| IdentityError::Configuration)?,
    );
    let ws_config = WebSocketConfig::default()
        .max_message_size(Some(2 * 1024 * 1024))
        .max_frame_size(Some(2 * 1024 * 1024));
    let (mut socket, _) = timeout(
        Duration::from_secs(15),
        connect_async_with_config(request, Some(ws_config), false),
    )
    .await
    .map_err(|_| IdentityError::Network)?
    .map_err(|_| IdentityError::Network)?;
    timeout(Duration::from_secs(30), async {
        rpc(
            &mut socket,
            1,
            "use",
            json!([config.namespace, workspace.db_name]),
        )
        .await?;
        rpc(
            &mut socket,
            2,
            "authenticate",
            json!([session.access_token()]),
        )
        .await?;
        session.ensure_current()?;
        Ok::<_, IdentityError>(())
    })
    .await
    .map_err(|_| IdentityError::Network)??;
    Ok(socket)
}

pub(crate) async fn rpc<S: AsyncRead + AsyncWrite + Unpin>(
    socket: &mut WebSocketStream<S>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value> {
    rpc_outcome(socket, id, method, params)
        .await?
        .map_err(|_| IdentityError::Database)
}
/// 与 `rpc` 相同，但把数据库返回的 RPC 错误对象原样交给调用方分类（不含 token）。
/// 没有 `id` 的服务端通知帧被忽略，不能让无关推送把当前请求判成失败。
pub(crate) async fn rpc_outcome<S: AsyncRead + AsyncWrite + Unpin>(
    socket: &mut WebSocketStream<S>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<std::result::Result<Value, Value>> {
    socket
        .send(Message::Text(
            json!({"id": id, "method": method, "params": params})
                .to_string()
                .into(),
        ))
        .await
        .map_err(|_| IdentityError::Network)?;
    while let Some(message) = socket.next().await {
        match message.map_err(|_| IdentityError::Network)? {
            Message::Text(text) => {
                let response: Value =
                    serde_json::from_str(&text).map_err(|_| IdentityError::Response)?;
                match response.get("id") {
                    None | Some(Value::Null) => continue,
                    Some(value) if value.as_u64() != Some(id) => {
                        return Err(IdentityError::Database)
                    }
                    Some(_) => {}
                }
                if let Some(error) = response.get("error") {
                    return Ok(Err(error.clone()));
                }
                return response
                    .get("result")
                    .cloned()
                    .map(Ok)
                    .ok_or(IdentityError::Response);
            }
            Message::Ping(data) => socket
                .send(Message::Pong(data))
                .await
                .map_err(|_| IdentityError::Network)?,
            Message::Pong(_) => {}
            _ => return Err(IdentityError::Database),
        }
    }
    Err(IdentityError::Database)
}
fn parse_members(data: Value) -> Result<Vec<Member>> {
    let statements = data
        .as_array()
        .filter(|a| a.len() == 1)
        .ok_or(IdentityError::Response)?;
    let statement = &statements[0];
    if statement.get("status").and_then(Value::as_str) != Some("OK") {
        return Err(IdentityError::Database);
    }
    let rows: Vec<MemberRow> = serde_json::from_value(
        statement
            .get("result")
            .cloned()
            .ok_or(IdentityError::Response)?,
    )
    .map_err(|_| IdentityError::Response)?;
    if rows.len() > 10_000
        || rows
            .iter()
            .any(|r| !r.id.starts_with("user:") || r.id.len() <= 5)
    {
        return Err(IdentityError::Response);
    }
    Ok(rows
        .into_iter()
        .map(|r| Member {
            id: r.id,
            display_name: r.display_name,
            email: r.email,
            is_admin: r.is_admin == Some(true),
            pending: r.subject.is_none(),
        })
        .collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn member_contract_and_pending() {
        let rows = parse_members(json!([{"status":"OK","result":[{"id":"user:u1","email":"one@example.test","subject":null,"is_admin":false}]}])).unwrap();
        assert!(rows[0].pending);
        assert!(!rows[0].is_admin);
        assert_eq!(rows[0].display_name, None);
        assert_eq!(
            parse_members(json!([{"status":"ERR","result":"token should never be shown"}])),
            Err(IdentityError::Database)
        );
        assert_eq!(
            parse_members(
                json!([{"status":"OK","result":[{"id":"employee:x","email":"one@example.test"}]}])
            ),
            Err(IdentityError::Response)
        );
    }
    #[test]
    fn endpoints_are_wss_only() {
        assert!(SurrealConfig::new("wss://data.example.test/rpc", "main").is_ok());
        for endpoint in [
            "ws://data.example.test/rpc",
            "wss://user:pass@data.example.test/rpc",
            "wss://data.example.test/rpc?token=bad",
            "wss://data.example.test/sql",
        ] {
            assert!(SurrealConfig::new(endpoint, "main").is_err());
        }
    }
    #[tokio::test]
    async fn websocket_rejects_wrong_ids_and_auth_errors_without_echoing() {
        for reply in [
            json!({"id":99,"result":null}),
            json!({"id":2,"error":{"message":"private-token-do-not-echo"}}),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                let _request = ws.next().await.unwrap().unwrap();
                ws.send(Message::Text(reply.to_string().into()))
                    .await
                    .unwrap();
            });
            let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
                .await
                .unwrap();
            let error = rpc(&mut ws, 2, "authenticate", json!(["fixture-token"]))
                .await
                .unwrap_err();
            assert_eq!(error, IdentityError::Database);
            assert!(!error.to_string().contains("private-token"));
            server.await.unwrap();
        }
    }
    #[tokio::test]
    async fn real_local_websocket_protocol_and_fail_closed() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            for (id, method) in [(1, "use"), (2, "authenticate"), (3, "query")] {
                let msg = ws.next().await.unwrap().unwrap();
                let value: Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
                assert_eq!(value["id"], id);
                assert_eq!(value["method"], method);
                if id == 1 {
                    assert_eq!(value["params"], json!(["main", "ws_fixture"]));
                }
                if id == 3 {
                    assert_eq!(value["params"][0], MEMBERS_QUERY);
                }
                let result = if id == 3 {
                    json!([{"status":"OK","result":[]}])
                } else {
                    Value::Null
                };
                ws.send(Message::Text(
                    json!({"id":id,"result":result}).to_string().into(),
                ))
                .await
                .unwrap();
            }
        });
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
            .await
            .unwrap();
        rpc(&mut ws, 1, "use", json!(["main", "ws_fixture"]))
            .await
            .unwrap();
        rpc(&mut ws, 2, "authenticate", json!(["synthetic-test-only"]))
            .await
            .unwrap();
        let result = rpc(&mut ws, 3, "query", json!([MEMBERS_QUERY, {}]))
            .await
            .unwrap();
        assert!(parse_members(result).unwrap().is_empty());
        server.await.unwrap();
    }
}
