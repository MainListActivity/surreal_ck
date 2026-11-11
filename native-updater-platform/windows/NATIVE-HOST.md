# Windows 原生更新宿主（实验阶段）

本模块使用原生 Win32 API，不启动 PowerShell、不绕过执行策略、不请求提权。默认客户端开关应关闭。当前只完成生产源码的真实 Windows GNU 目标类型检查、严格 clippy，以及六个跨平台协议/持久尝试规则测试；未链接完整 Windows 客户端、未在 Windows 执行 ACL/Authenticode/安装/重启验收。不能据此宣称全自动更新已可用。

## 宿主合同

手写 Windows main 在 NSH/UI 初始化前调用 `windows::dispatch_helper()`。返回 None 才继续正常启动；返回 Some(Ok(())) 退出0，Some(Err(_)) 记录错误并退出非零，禁止退回普通UI。正常调用会登记当前进程有 helper dispatch。未接该入口的 NSH 自动生成 runner 会被 prepare 拒绝，不能打包为支持更新的产品。

仅在核心 `run_startup_with_installer` 已验签、校验防回滚并验证下载后的闭包内调用：

```rust
let handoff = windows::prepare(windows::VerifiedUpdate {
    old_version: env!("CARGO_PKG_VERSION"),
    target_version: &release.version,
    bytes,
    sha256: &release.sha256,
    publisher: &release.publisher,
})?;
handoff.arm_for_exit()?;
```

映射实际 release publisher 类型后接入；本 API 不解析发布策略，不应从未验证网络输入构造。`arm_for_exit` 成功只表示 helper 接受交接，宿主必须正常退出旧进程，仍不得发送 Ready/挂载业务。helper 等待父进程最多120秒，不会强杀父进程。退出失败会停止安装。新进程仍须通过完整启动 Gate，安装器 exit0 绝不是 Ready。

## 约束与验证

- 只支持 KnownFolder LocalAppData/Programs/SurrealCK 的当前用户 Inno 安装。安装器必须配置非管理员模式并接受固定静默参数；不支持任意安装器、自定义安装目录、UNC、非 Unicode 路径或不同发布者证书轮换。
- 原子创建随机暂存目录，保护 DACL 仅允许当前用户和 SYSTEM，复核 owner/ACL。逐层拒绝 reparse，目录句柄拒绝删除共享；文件拒绝写/删除共享。创建新目录ACL不修改既有系统设置。
- 再校验核心指定 SHA256 和大小；WinVerifyTrust 验证链及吊销状态，再取已验证签名者 DER SHA256 匹配核心签名策略 publisher。当前客户端、复制 helper、安装器及重启文件均要求同一合法证书。未签 preview 必须失败。
- 父进程 PID、创建时间及实际映像路径绑定；私有管道 nonce 分阶段 READY/COMMIT/COMMITTED。两次父端等待各限60秒。取消交接只终止自己启动的 helper。
- 固定 Inno 参数禁止安装器关闭旧应用、自动重启应用或系统；只在父进程退出后启动安装。安装成功后验签重启文件，再启动新的完整 Gate。
- helper本身不独立验证核心策略签名/防回滚；必须由已通过核心验证的宿主调用。手工同用户构造请求不在其安全边界内，不抵御同用户恶意进程；同一用户恶意进程并非 Windows ACL 的隔离边界。真实 Windows 还需验证 DLL 搜索路径、自复制 helper 的运行依赖、目录共享对 Inno 替换的兼容性、吊销离线行为、失败诊断、磁盘满和各系统版本。
- 收到有效 COMMIT 后建立终态清理守卫，成功/错误均先释放安装器句柄再删除自身 setup.exe，并在私有控制目录写有界结果（含清理失败）。崩溃/被杀不能保证清理；保留最多8个stage、总计2GiB（计入新包/helper），跨进程独占reservation避免并发超额，超限停止而非继续堆积。helper.exe/request.json仍保留供受控清理，因此即使每次成功，第9次升级也会停止直到人工审查清理，这是实验安全上限而非长期可用的自动更新缓存管理。
- COMMIT发送前独占创建并fsync每hash尝试记录，绑定旧版本、目标版本、hash、nonce和commit-intent；helper核对该记录后才ACK。任何同hash记录（含不完整/不确定）都拒绝自动重试，因此exit0装回旧版也不能循环。不同hash修复版仍可在核心验证后尝试。版本是否已达目标只由核心Gate决定，本层不比较版本字符串、不宣称Ready。记录历史上限127次尝试，每次预留一个结果文件，加reservation最多255文件，超限需人工处理。准备后未commit可重试；commit写失败不发送COMMIT，残缺记录保守锁定。

## 可复验小测试

`tests/windows-api` 直接用 path 引用生产 windows.rs/windows_protocol.rs，没有复制替身或假 Windows 类型。不需编译 NSH/ring，不能代替完整宿主构建。

```sh
cargo test --locked --offline --manifest-path tests/windows-api/Cargo.toml
cargo check --locked --offline --manifest-path tests/windows-api/Cargo.toml --target x86_64-pc-windows-gnu
cargo clippy --locked --offline --manifest-path tests/windows-api/Cargo.toml --target x86_64-pc-windows-gnu -- -D warnings
```

实测六项协议/尝试规则测试通过，真实目标 check/clippy 通过。没有执行真实安装、改变权限设置或触发远端工作流。
