//! 工作区认证的一对一邀请协议。SDP 只作信令，聊天、文件及媒体不得进入数据库。
//! 不提供从手工字符串构造 AuthenticatedOffer/Answer 的公共 API。
mod protocol;
mod session;
pub use protocol::{AuthenticatedAnswer, AuthenticatedOffer, Error, InvitationSummary, Result};
pub use session::Signaling;

/// 无数据库强制规则及用户 fork 实测证据时保持关闭；不能用 mock 结果开启。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Availability {
    BlockedPendingDatabaseRulesAndForkVerification,
}
pub fn availability() -> Availability {
    Availability::BlockedPendingDatabaseRulesAndForkVerification
}

// 仅用于检验协议设计，不是生产授权器。没有 mock 开关或可注入的认证证明入口。
#[cfg(test)]
mod model;
