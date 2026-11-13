//! 原生企业身份、当前工作区成员只读访问与固定信令。不得以解码 JWT 代替验证。
//! 网络调用不自动打开浏览器、不保存令牌、不创建账号或注册回调。
mod auth;
mod discovery;
mod loopback;
mod members;
mod scope;
mod signaling;
mod transport;
mod verify;

pub use auth::{
    IdentityClient, IdentityConfig, LoginAttempt, Session, Workspace, WorkspaceList, WorkspaceRole,
};
pub use discovery::OidcTokenMode;
pub use loopback::LoopbackReceiver;
pub use members::{load_members, Member, SurrealConfig};
pub use signaling::{SignalBinding, SignalConnection, SignalRow, SignalStatus, SignalSummary};
pub use transport::HttpsTransport;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum IdentityError {
    #[error("企业登录配置缺失或不安全，请先配置已注册的原生回调和对应客户端")]
    Configuration,
    #[error("OIDC discovery 的 issuer、端点主机或 public S256 能力不符合受信任配置")]
    Discovery,
    #[error("当前平台未实现此原生回调方式；桌面回调需明确的 loopback 地址和端口")]
    CallbackUnsupported,
    #[error("无法监听已配置的本机登录回调端口，请关闭占用该端口的程序后重试")]
    CallbackBind,
    #[error("无法生成安全登录随机数")]
    Random,
    #[error("登录请求已过期，请重新登录")]
    LoginExpired,
    #[error("登录回调地址、state 或参数不匹配")]
    Callback,
    #[error("登录未获授权或已取消")]
    LoginRejected,
    #[error("网络请求失败或超时，请重试")]
    Network,
    #[error("服务返回 HTTP {0}；未建立或扩大访问权限")]
    Http(u16),
    #[error("服务响应格式无效")]
    Response,
    #[error("身份签名、签发者、接收者、nonce 或有效期验证失败")]
    Token,
    #[error("登录会话已过期，请重新登录")]
    SessionExpired,
    #[error("当前用户无权访问此工作区")]
    Forbidden,
    #[error("当前令牌未切换至此工作区；请先显式切换工作区")]
    WorkspaceNotSelected,
    #[error("数据库拒绝认证或查询；未读取成员")]
    Database,
    #[error("此信令需要已验证的真人 RECORD 会话；不能用管理员 system 身份代替")]
    SignalRecordRequired,
    #[error("当前成员会话未能绑定到本工作区的真人记录；信令未启用")]
    SignalIdentityMissing,
    #[error("成员记录标识格式无法用于信令")]
    SignalMemberKey,
    #[error("信令不存在、已过期、状态已变化或数据库拒绝操作")]
    SignalUnavailable,
    #[error("信令完整绑定或响应不匹配")]
    SignalBinding,
    #[error("信令标识或 SDP 不符合固定协议")]
    SignalInput,
    #[error("信令请求结果不确定；请核对状态，不要自动重复发送")]
    SignalUncertain,
    #[error("信令请求过于频繁，请等待后重试")]
    SignalRateLimited,
    #[error("本工作区数据库尚未启用信令结构（062 native_signal 迁移未应用）；信令未启用")]
    SignalSchemaMissing,
    #[error("数据库拒绝了信令会话（认证已失效或权限不足）；请重新连接")]
    SignalDenied,
}
pub type Result<T> = std::result::Result<T, IdentityError>;

#[cfg(test)]
mod test_http;
