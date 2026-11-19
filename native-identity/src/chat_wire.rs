use super::{ChatError, ChatResult};
use crate::members::DatabaseSocket;
use futures_util::{stream::SplitSink, SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    sync::{mpsc, oneshot, watch, Mutex},
    task::JoinHandle,
    time::timeout,
};
use tokio_tungstenite::tungstenite::Message;

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<ChatResult<Value>>>>>;

pub(super) struct Wire {
    writer: Mutex<SplitSink<DatabaseSocket, Message>>,
    pending: Pending,
    reader: JoinHandle<()>,
    next_id: std::sync::atomic::AtomicU64,
    pub notices: mpsc::Receiver<Value>,
    pub failure: watch::Receiver<Option<ChatError>>,
    pub live_ids: Vec<Value>,
}

impl Wire {
    pub fn new(socket: DatabaseSocket) -> Self {
        let (writer, mut stream) = socket.split();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let requests = pending.clone();
        let (tx, notices) = mpsc::channel(256);
        let (failed, failure) = watch::channel(None);
        let reader = tokio::spawn(async move {
            let error = loop {
                let value = match timeout(Duration::from_secs(30), stream.next()).await {
                    Err(_) => break ChatError::Timeout,
                    Ok(Some(Ok(Message::Text(text)))) => match serde_json::from_str::<Value>(&text)
                    {
                        Ok(value) => value,
                        Err(_) => break ChatError::Protocol,
                    },
                    Ok(Some(Ok(Message::Pong(_)))) => continue,
                    // tungstenite queues its automatic pong; outgoing requests / heartbeats flush it.
                    Ok(Some(Ok(Message::Ping(_)))) => continue,
                    _ => break ChatError::Network,
                };
                if let Some(id) = value.get("id").and_then(Value::as_u64) {
                    if let Some(reply) = requests.lock().await.remove(&id) {
                        let result = if let Some(error) = value.get("error") {
                            Err(rpc_error(error))
                        } else {
                            value.get("result").cloned().ok_or(ChatError::Protocol)
                        };
                        let _ = reply.send(result);
                    }
                } else if value["result"]["id"].is_string() {
                    if tx.try_send(value["result"].clone()).is_err() {
                        break ChatError::Overflow;
                    }
                } else {
                    break ChatError::Protocol;
                }
            };
            failed.send_replace(Some(error));
            for (_, reply) in requests.lock().await.drain() {
                let _ = reply.send(Err(error));
            }
        });
        Self {
            writer: Mutex::new(writer),
            pending,
            reader,
            next_id: std::sync::atomic::AtomicU64::new(100),
            notices,
            failure,
            live_ids: Vec::new(),
        }
    }

    pub async fn rpc(&self, method: &str, params: Value) -> ChatResult<Value> {
        if let Some(error) = *self.failure.borrow() {
            return Err(error);
        }
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            if pending.len() >= 16 {
                return Err(ChatError::Overflow);
            }
            pending.insert(id, tx);
        }
        let result = timeout(Duration::from_secs(15), async {
            self.writer
                .lock()
                .await
                .send(Message::Text(
                    json!({"id":id,"method":method,"params":params})
                        .to_string()
                        .into(),
                ))
                .await
                .map_err(|_| ChatError::Network)?;
            rx.await.map_err(|_| ChatError::Network)?
        })
        .await
        .map_err(|_| ChatError::Timeout)
        .and_then(|v| v);
        self.pending.lock().await.remove(&id);
        result
    }

    pub async fn query(&self, sql: &str, vars: Value) -> ChatResult<Value> {
        let result = self.rpc("query", json!([sql, vars])).await?;
        let statements = result.as_array().ok_or(ChatError::Protocol)?;
        for statement in statements {
            if statement["status"] != "OK" {
                return Err(query_error(statement));
            }
        }
        statements
            .last()
            .and_then(|v| v.get("result"))
            .cloned()
            .ok_or(ChatError::Protocol)
    }

    pub async fn live(&mut self, sql: &str) -> ChatResult<String> {
        let id = self.query(sql, json!({})).await?;
        let text = id.as_str().ok_or(ChatError::Protocol)?.to_owned();
        self.live_ids.push(id);
        Ok(text)
    }

    pub async fn close(&mut self) {
        let _ = timeout(Duration::from_secs(2), async {
            for id in std::mem::take(&mut self.live_ids) {
                let _ = self.rpc("kill", json!([id])).await;
            }
            let _ = self.writer.lock().await.close().await;
        })
        .await;
        self.reader.abort();
    }
}

impl Drop for Wire {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

fn query_error(statement: &Value) -> ChatError {
    if statement["details"]["retryable"] == true && statement["details"]["code"] == "quota_conflict"
    {
        ChatError::Conflict
    } else if statement["result"]
        == "Function 'fn::chat_active' not found: The function 'fn::chat_active' does not exist"
    {
        ChatError::NotEnabled
    } else {
        ChatError::Database
    }
}

fn rpc_error(error: &Value) -> ChatError {
    if error["details"]["code"] == "quota_conflict" && error["details"]["retryable"] == true {
        ChatError::Conflict
    } else if error["kind"] == "NotAllowed" && error["details"]["kind"] == "Auth" {
        match error["details"]["details"]["kind"].as_str() {
            Some("TokenExpired" | "SessionExpired") => ChatError::Expired,
            _ => ChatError::Authentication,
        }
    } else {
        ChatError::Database
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dispatches_out_of_order_responses_live_and_kills_before_close() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
            let mut requests = Vec::new();
            for _ in 0..2 {
                let request = socket.next().await.unwrap().unwrap().into_text().unwrap();
                requests.push(serde_json::from_str::<Value>(&request).unwrap());
            }
            socket.send(Message::Text(json!({"result":{"id":"live-one","action":"CREATE","result":{"id":"message-one"}}}).to_string().into())).await.unwrap();
            for request in requests.into_iter().rev() {
                socket
                    .send(Message::Text(
                        json!({"id":request["id"],"result":request["method"]})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
            }
            for live in ["live-one", "live-two"] {
                let request = socket.next().await.unwrap().unwrap().into_text().unwrap();
                let request: Value = serde_json::from_str(&request).unwrap();
                assert_eq!(request["method"], "kill");
                assert_eq!(request["params"], json!([live]));
                socket
                    .send(Message::Text(
                        json!({"id":request["id"],"result":null}).to_string().into(),
                    ))
                    .await
                    .unwrap();
            }
            assert!(matches!(socket.next().await, Some(Ok(Message::Close(_)))));
        });
        let (socket, _) = tokio_tungstenite::connect_async(endpoint).await.unwrap();
        let mut wire = Wire::new(socket);
        let (first, second) =
            tokio::join!(wire.rpc("first", json!([])), wire.rpc("second", json!([])));
        assert_eq!(first.unwrap(), "first");
        assert_eq!(second.unwrap(), "second");
        assert_eq!(wire.notices.recv().await.unwrap()["id"], "live-one");
        wire.live_ids = vec![json!("live-one"), json!("live-two")];
        wire.close().await;
        timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[test]
    fn classifies_structured_errors_without_retaining_server_text() {
        assert_eq!(
            query_error(
                &json!({"status":"ERR","result":"Function 'fn::chat_active' not found: The function 'fn::chat_active' does not exist"})
            ),
            ChatError::NotEnabled
        );
        assert_eq!(
            query_error(&json!({"status":"ERR","result":"unrelated database error"})),
            ChatError::Database
        );
        assert_eq!(
            query_error(
                &json!({"status":"ERR","details":{"code":"quota_conflict","retryable":true}})
            ),
            ChatError::Conflict
        );
        assert_eq!(
            rpc_error(&json!({"kind":"Validation"})),
            ChatError::Database
        );
        assert_eq!(
            rpc_error(
                &json!({"kind":"Quota","details":{"code":"quota_conflict","retryable":true}})
            ),
            ChatError::Conflict
        );
        for kind in ["TokenExpired", "SessionExpired"] {
            assert_eq!(
                rpc_error(
                    &json!({"kind":"NotAllowed","details":{"kind":"Auth","details":{"kind":kind}}})
                ),
                ChatError::Expired
            );
        }
        assert_eq!(
            rpc_error(
                &json!({"kind":"NotAllowed","details":{"kind":"Auth","details":{"kind":"InvalidAuth"}}})
            ),
            ChatError::Authentication
        );
    }
}
