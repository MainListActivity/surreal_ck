# 桌面安全接收原生验证

此独立小crate只编译候选后端，不构建WebRTC或整个客户端。生产`transfer::receive_supported()`仍只允许Linux/Android；这里通过编译不能恢复macOS/Windows接收，必须先通过下面的原生门槛。

## 稳定命令

在真实macOS或Windows runner的仓库根目录运行：

```sh
cargo check --locked --manifest-path native-transport/validation/desktop-receive-probe/Cargo.toml --tests
cargo test --locked --manifest-path native-transport/validation/desktop-receive-probe/Cargo.toml
cargo clippy --locked --manifest-path native-transport/validation/desktop-receive-probe/Cargo.toml --tests -- -D warnings
```

Windows还必须在**原本就具有符号链接创建能力**的runner执行：

```sh
cargo test --locked --manifest-path native-transport/validation/desktop-receive-probe/Cargo.toml -- --ignored
```

不能为了跑测试提权、修改系统安全设置或开启Developer Mode。没有这项能力时，三项symlink/reparse测试未验收，不得把其余测试通过当作完整安全接收支持。默认执行的junction测试还有真实FSCTL正控制；正控制失败必须报错，不得当作攻击被成功阻止。

现有Linux开发环境仅做以下实际目标的metadata检查，不链接、不模拟原生API；`CARGO_TARGET_DIR`固定复用`native-client/target`，`CARGO_PROFILE_DEV_DEBUG=0`，使用`--offline`且不下载依赖：

```sh
cargo check --offline --locked --manifest-path native-transport/validation/desktop-receive-probe/Cargo.toml --target aarch64-apple-darwin --tests
cargo check --offline --locked --manifest-path native-transport/validation/desktop-receive-probe/Cargo.toml --target x86_64-pc-windows-gnu --tests
```

## macOS候选边界

- 只接受本地APFS，不尝试网络卷、FUSE、外部提供商或不支持的文件系统。逐层`openat(O_DIRECTORY|O_NOFOLLOW)`固定目标，不跟随用户路径里的符号链接。目录必须有读取权限；路径如`/tmp`、`/var`的符号链接别名不自动归一化，用户需选择真实路径。
- 在目标内创建/打开固定名称`.surreal-ck-receive`，对实际FD验证所有者为当前有效UID、其他用户无mode权限、无扩展ACL。使用`fstatx_np`和`filesec_query_property(FILESEC_ACL)`，不是将`acl_get_fd_np`的任意NULL/ENOENT当成无ACL。
- 根内每次创建独有0700子目录与0600文件。在数据到来前验证权限。拒绝继承ACL，不修改用户已有目录的权限。源目录项只有当前UID可以修改，所以从固定子dirfd以`renameatx_np(..., RENAME_EXCL)`发布不会被另一个本地用户换源。不同于Linux的直接inode链接，这不是对同UID文件修改者的隔离。
- 取消、失败和正常发布后，仅从固定私有dirfd删除payload和空子目录。不从用户目标目录按顶层staging名称清理；因此正常运行也保留空staging根。攻击者移动根后可以留下多个空根。进程崩溃或无法再证明私有权限时可能遗留临时数据，不递归清理不可信路径。
- 用户目标父路径移动/替换后报错，固定FD不会转向替换目录。若恰在发布后移动，已校验文件可能留在原目录；不按旧路径删除它。`RENAME_EXCL`失败不降级普通rename/copy。

Apple官方资料：[open/openat](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/open.2)、[renameatx_np与RENAME_EXCL](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/rename.2)、[filesec接口声明](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h)、[fstatx_np声明](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/stat.h)、[fstatx的ACL属性填充](https://github.com/apple-oss-distributions/Libc/blob/main/sys/statx_np.c)。本模块自行声明缓存libc未导出的公开filesec API，需要ARM与Intel原生链接验证。

## Windows候选边界

- 仅本地固定盘NTFS，固定卷根和逐级目录HANDLE；严格单文件名路径，不接受UNC、设备路径、ADS或已有reparse层。
- 临时文件创建时设置当前用户SID专用protected DACL，不继承父目录ACL；独占打开并保持同一文件对象的清理HANDLE。
- 仅使用`SetFileInformationByHandle(FileRenameInfo)`从已校验文件HANDLE发布，`RootDirectory`固定目标目录，`ReplaceIfExists=FALSE`。不用`MoveFile`、路径`CreateHardLink`或检查后按路径重开源。
- 正常取消只对源HANDLE设置`FileDispositionInfo`，不按临时文件名删除。成功后关闭清理guard，不能误删最终文件。进程崩溃时尚不保证回收命名临时文件。
- 创建阶段并持两套已核对同身份的目录HANDLE，严格套不分享WRITE/DELETE，另一套允许WRITE但同样拒DELETE。独占staging创建后，祖先每层包含不可删除的下一层，最终目录包含不可删除的staging，此时才释放严格套，让rename内部打开不会被自身WRITE分享限制挡住。
- NTFS非空目录不能新建改变路径解析的name-surrogate junction/symlink，这是交接后的保护依据，不能泛称所有reparse tag或其他文件系统。已有Cloud Filter等tag也拒绝。实际FSCTL测试先在空目录成功设置同一种tag作为正控制，再对接收期间的祖先和最终目录要求ERROR_DIR_NOT_EMPTY，最后必须成功发布。symlink FSCTL测试需要runner原有权限。
- 双套句柄交接、rename内部打开及运行期reparse转换尚未原生执行。没有native通过记录之前，本候选不是可启用的平台支持。

Microsoft官方资料：[NtCreateFile的RootDirectory和创建选项](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)、[FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info)、[重命名所需访问与目标内部打开](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information)、[NTFS reparse点限制](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points)。

## 不能省略的原生验收

1. macOS ARM和Intel、本地APFS；Windows MSVC、本地NTFS。日志记录OS/文件系统/架构/精确commit，所有普通测试与具备权限时的ignored测试均执行，不能只编译或过滤掉失败项。
2. 创建、校验、同步、发布后文件身份与原已打开文件一致，目标已有和临时出现的普通文件、目录、symlink/reparse均不覆盖；空文件和Unicode名称正确。
3. 攻击者移动/替换各祖先及staging根，结果只能安全失败或发布到原固定目录；不得转向替换目录，不得清理无关文件。Windows还需反复尝试运行期将目录转为reparse。
4. macOS继承扩展ACL即使mode显示0700也必须拒绝；Windows必须验证新文件DACL已protected且只允许当前用户SID。使用预先准备的**另一个普通本地账号**尝试读/写/改名staging内容，验证确实被OS拒绝；此仓库不创建账号、凭据或改变机器安全策略。
5. 取消、hash失败、连接关闭、写入/flush/sync失败必须没有COMPLETE；现有Linux传输层协议测试不替代两平台原生集成测试。加入实际权限拒绝、磁盘满和进程中断，分别确认安全性与已披露残留范围。
6. 未列出的文件系统明确fail-closed。相同OS账户能控制本进程或读写其私有对象、管理员/内核攻击不在隔离承诺内；不承诺发布后本地目录写入者永远不能删除或改名文件，也不承诺掉电后目录项持久化。

只有原生后端测试和真实transport接收/最终ACK集成均通过后，另行审查并启用生产平台分支。不能仅以本harness的交叉检查或CI配置存在宣称macOS/Windows接收已恢复。

## 2026-11-10复核记录（不构成原生验收）

- Linux云环境中，使用缓存依赖和已安装target，`aarch64-apple-darwin`、`x86_64-pc-windows-gnu`的`check --tests`与`clippy --tests -- -D warnings`通过；候选harness格式检查通过。没有链接、没有运行任何Apple/Windows测试。
- `x86_64-apple-darwin`缺少target，检查报E0463；未安装新target或下载SDK/MinGW。Windows MSVC未检查。交叉metadata检查不验证Darwin符号、APFS ACL或NTFS句柄行为。
- 新增原生测试定义：macOS额外硬链接拒绝、准备后私有权限改变时拒绝发布且保留staging；Windows已有目录写句柄阻止准备、late目录保留、固定父HANDLE发布空Unicode文件。它们仅通过目标编译，尚未执行。
- Microsoft当前`FILE_RENAME_INFO`文档明确允许相对`FileName`搭配目录`RootDirectory`；源码使用的是这一组合。仍需原生测试验证分享模式交接及内部打开，不能把结构字段可编译当作API成功的证据。
- 复核未改变生产分支或支持开关；候选仍冻结在独立harness范围。macOS私有staging只隔离其他UID，不将文件FD身份检查误称为阻止同UID替换payload名称的机制；权限/ACL改变后无法证明私有性时故意不清理。
