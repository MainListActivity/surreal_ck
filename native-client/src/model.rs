//! 连接状态不与 UI 文案混用；未连接时不伪造发送成功。
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub enum Connection {
    #[default]
    Offline,
    Connecting,
    Connected {
        peer: String,
    },
    Failed {
        reason: String,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub id: u64,
    pub body: String,
    pub delivered: bool,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Session {
    pub connection: Connection,
    pub drafts: Vec<String>,
    pub messages: Vec<Message>,
}
impl Session {
    pub fn save_draft(&mut self, text: &str) -> bool {
        let text = text.trim();
        if text.is_empty() || text.len() > 16384 {
            return false;
        }
        self.drafts.push(text.to_owned());
        true
    }
    pub fn can_send(&self) -> bool {
        matches!(self.connection, Connection::Connected { .. })
    }
    pub fn confirm_delivery(&mut self, id: u64, body: String) -> Result<(), &'static str> {
        if !self.can_send() {
            return Err("尚未连接到对方");
        }
        if body.trim().is_empty() || body.len() > 16384 {
            return Err("消息长度无效");
        }
        if !self.messages.iter().any(|m| m.id == id) {
            self.messages.push(Message {
                id,
                body,
                delivered: true,
            });
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn offline_never_claims_delivery() {
        let mut s = Session::default();
        assert!(s.confirm_delivery(1, "hello".into()).is_err());
        assert!(s.messages.is_empty());
    }
    #[test]
    fn rejects_empty_and_oversized_drafts() {
        let mut s = Session::default();
        assert!(!s.save_draft("  "));
        assert!(!s.save_draft(&"a".repeat(16385)));
        assert!(s.save_draft(" draft "));
        assert_eq!(s.drafts, vec!["draft"]);
    }
    #[test]
    fn acknowledgements_are_idempotent() {
        let mut s = Session {
            connection: Connection::Connected {
                peer: "peer".into(),
            },
            ..Default::default()
        };
        s.confirm_delivery(1, "hello".into()).unwrap();
        s.confirm_delivery(1, "hello".into()).unwrap();
        assert_eq!(s.messages.len(), 1);
    }
}
