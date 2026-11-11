//! Windows 候选实现；必须通过 Windows 原生负例测试后才能启用接收能力。
//! 逐层固定目录 HANDLE，独占临时文件，并从已验证的同一文件对象无覆盖发布。
//! 仅支持本地 NTFS；不支持网络盘、UNC、设备路径和已有 reparse point。
//! 不提供进程崩溃后的临时文件回收；正常取消仅按 HANDLE 删除，绝不按路径清理。
//! 创建前用严格句柄阻止目录写入；锁定 staging 后靠 NTFS 非空目录不能安装
//! 改变路径解析的 name-surrogate（junction/symlink）规则保持安全，再释放严格句柄。
//! 此约束不概括到 Cloud Filter 等其他 reparse tag；已有 tag 一律拒绝。
//! 这一转换与 FSCTL_SET_REPARSE_POINT 攻击必须在 Windows 原生 runner 验证。
use std::{
    ffi::c_void,
    fs::File,
    io,
    mem::size_of,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    sync::atomic::{AtomicU64, Ordering},
};
use windows_sys::{
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            FileRenameInformation, NtCreateFile, NtSetInformationFile, FILE_CREATE,
            FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
            FILE_RENAME_INFORMATION, FILE_SYNCHRONOUS_IO_NONALERT,
        },
    },
    Win32::{
        Foundation::{
            LocalFree, RtlNtStatusToDosError, ERROR_FILE_NOT_FOUND, HANDLE, INVALID_HANDLE_VALUE,
            OBJ_CASE_INSENSITIVE, UNICODE_STRING,
        },
        Security::{
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            },
            GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
        },
        Storage::FileSystem::*,
        System::{
            Threading::{GetCurrentProcess, OpenProcessToken},
            IO::IO_STATUS_BLOCK,
        },
    },
};

pub(super) struct Destination {
    // 保留整条目录链，不分享 DELETE。每层有不可删除的下一层，最终层有 staging。
    // NTFS 非空目录不能安装 junction/symlink；创建阶段另持不分享 WRITE 的严格句柄。
    directories: Vec<OwnedHandle>,
    name: Vec<u16>,
    path: PathBuf,
    // 与交给 Receiver 的 File 是同一内核文件对象的复制 HANDLE。
    // Receiver 可以先释放其 HANDLE；取消仍通过这个 HANDLE 清理。
    staging: File,
    published: bool,
}

fn last_error() -> String {
    io::Error::last_os_error().to_string()
}

fn checked_path(path: &Path) -> Result<Vec<Vec<u16>>, String> {
    // 不用 components()：它会折叠点和重复分隔符，掩盖不允许的原始输入。
    let raw: Vec<u16> = path.as_os_str().encode_wide().collect();
    if raw.len() < 4
        || raw.len() > 32760
        || !((b'A' as u16..=b'Z' as u16).contains(&raw[0])
            || (b'a' as u16..=b'z' as u16).contains(&raw[0]))
        || raw[1] != b':' as u16
        || raw[2] != b'\\' as u16
    {
        return Err("choose a local absolute drive-letter destination".into());
    }
    let parts: Vec<Vec<u16>> = raw[3..]
        .split(|c| *c == b'\\' as u16)
        .map(|part| part.to_vec())
        .collect();
    for part in &parts {
        if part.is_empty()
            || part.len() > 255
            || part
                .last()
                .is_some_and(|c| *c == b'.' as u16 || *c == b' ' as u16)
            || part
                .iter()
                .any(|c| *c < 32 || b"/:<>\"|?*".iter().any(|bad| *c == u16::from(*bad)))
        {
            return Err("invalid destination component".into());
        }
        // 禁止不完整 UTF-16，避免两个 API 层采用不同的替换字符解释。
        let text = String::from_utf16(part).map_err(|_| "invalid destination Unicode")?;
        let stem = text
            .split('.')
            .next()
            .unwrap()
            .trim_end_matches(' ')
            .to_uppercase();
        let serial = stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"));
        if matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || serial.is_some_and(|s| {
            matches!(
                s,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        }) {
            return Err("reserved DOS destination name".into());
        }
    }
    Ok(parts)
}

// 所有缓冲区按 usize 对齐，供包含指针的 Win32 可变长结构使用。
fn aligned(bytes: usize) -> Vec<usize> {
    vec![0; bytes.div_ceil(size_of::<usize>())]
}

struct LocalAllocation(*mut c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // SAFETY: 仅接管由 Convert* API 分配且尚未释放的 LocalAlloc 内存。
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn private_descriptor() -> Result<LocalAllocation, String> {
    let mut token = null_mut();
    // SAFETY: 有效进程伪句柄；输出 token 在成功后接管一次。
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(last_error());
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut length = 0;
    // SAFETY: 第一次调用只查询 TokenUser 所需长度。
    unsafe {
        GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut length);
    }
    if length < size_of::<TOKEN_USER>() as u32 {
        return Err(last_error());
    }
    let mut buffer = aligned(length as usize);
    // SAFETY: buffer 足够长且对齐；只在成功后读取 TOKEN_USER。
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return Err(last_error());
    }
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    let mut sid = null_mut();
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut sid) } == 0 {
        return Err(last_error());
    }
    let sid_allocation = LocalAllocation(sid.cast());
    let mut sid_length = 0;
    // SAFETY: 成功 API 返回 NUL 结尾 UTF-16 SID，生命周期由 sid_allocation 保持。
    while unsafe { *sid.add(sid_length) } != 0 {
        sid_length += 1;
    }
    let sid_text = String::from_utf16(unsafe { std::slice::from_raw_parts(sid, sid_length) })
        .map_err(|_| "invalid token SID")?;
    drop(sid_allocation);
    // protected DACL 阻止目录继承；只授予当前进程 token 用户完整权限。
    let sddl: Vec<u16> = format!("D:P(A;;FA;;;{sid_text})")
        .encode_utf16()
        .chain([0])
        .collect();
    let mut descriptor = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(last_error());
    }
    Ok(LocalAllocation(descriptor))
}

fn open_relative(
    parent: HANDLE,
    name: &[u16],
    access: u32,
    share: u32,
    disposition: u32,
    options: u32,
    descriptor: *const c_void,
) -> Result<OwnedHandle, io::Error> {
    let byte_length = u16::try_from(name.len() * 2)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "component too long"))?;
    let unicode = UNICODE_STRING {
        Length: byte_length,
        MaximumLength: byte_length,
        Buffer: name.as_ptr().cast_mut(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent,
        ObjectName: &unicode,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: descriptor.cast(),
        SecurityQualityOfService: null(),
    };
    let mut handle = null_mut();
    let mut status_block = IO_STATUS_BLOCK::default();
    // SAFETY: 单组件相对名、父句柄及描述符活到同步调用返回；输出只接管一次。
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            access | SYNCHRONIZE,
            &attributes,
            &mut status_block,
            null(),
            FILE_ATTRIBUTE_NORMAL,
            share,
            disposition,
            options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            null(),
            0,
        )
    };
    if status < 0 {
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ));
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

fn check_directory(handle: HANDLE) -> Result<(), String> {
    let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
    // SAFETY: 结构大小准确，句柄由调用者保持。
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileAttributeTagInfo,
            (&mut info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
    {
        return Err(last_error());
    }
    if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
    {
        return Err("destination contains a reparse point or non-directory".into());
    }
    Ok(())
}

fn identity(file: &File) -> Result<(u32, u32, u32), String> {
    handle_identity(file.as_raw_handle())
}

fn handle_identity(handle: HANDLE) -> Result<(u32, u32, u32), String> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
        return Err(last_error());
    }
    Ok((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}

impl Destination {
    pub(super) fn prepare(path: PathBuf) -> Result<(Self, File), String> {
        let parts = checked_path(&path)?;
        let drive = path.as_os_str().encode_wide().next().unwrap();
        let root = [drive, b':' as u16, b'\\' as u16, 0];
        // DRIVE_FIXED=3；拒绝网络映射、可移动盘和未知设备，不降级。
        if unsafe { GetDriveTypeW(root.as_ptr()) } != 3 {
            return Err("secure receiving requires a local fixed drive".into());
        }
        // SAFETY: NUL 结尾绝对卷根；不分享 DELETE，以保持卷根目录引用。
        let root_handle = unsafe {
            CreateFileW(
                root.as_ptr(),
                FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if root_handle == INVALID_HANDLE_VALUE {
            return Err(last_error());
        }
        let root_handle = unsafe { OwnedHandle::from_raw_handle(root_handle) };
        check_directory(root_handle.as_raw_handle())?;
        let mut flags = 0;
        let mut filesystem = [0u16; 32];
        // FILE_PERSISTENT_ACLS=0x8；非空目录的 reparse 约束仅采用 NTFS 官方保证。
        if unsafe {
            GetVolumeInformationByHandleW(
                root_handle.as_raw_handle(),
                null_mut(),
                0,
                null_mut(),
                null_mut(),
                &mut flags,
                filesystem.as_mut_ptr(),
                filesystem.len() as u32,
            )
        } == 0
        {
            return Err(last_error());
        }
        let filesystem_name = String::from_utf16_lossy(
            &filesystem[..filesystem
                .iter()
                .position(|c| *c == 0)
                .ok_or("invalid filesystem name")?],
        );
        if flags & 0x8 == 0 || filesystem_name != "NTFS" {
            return Err("secure receiving requires local NTFS with persistent ACLs".into());
        }
        // 同时保留两套句柄。严格套仍阻止 WRITE，因此较宽分享的第二套不会提前解锁。
        let relaxed_root = unsafe {
            CreateFileW(
                root.as_ptr(),
                FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if relaxed_root == INVALID_HANDLE_VALUE {
            return Err(last_error());
        }
        let relaxed_root = unsafe { OwnedHandle::from_raw_handle(relaxed_root) };
        check_directory(relaxed_root.as_raw_handle())?;
        if handle_identity(root_handle.as_raw_handle())?
            != handle_identity(relaxed_root.as_raw_handle())?
        {
            return Err("destination drive changed during preparation".into());
        }
        let mut strict_directories = vec![root_handle];
        let mut directories = vec![relaxed_root];
        for part in &parts[..parts.len() - 1] {
            let handle = open_relative(
                directories.last().unwrap().as_raw_handle(),
                part,
                FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ,
                FILE_OPEN,
                FILE_DIRECTORY_FILE,
                null(),
            )
            .map_err(|e| e.to_string())?;
            check_directory(handle.as_raw_handle())?;
            let relaxed = open_relative(
                directories.last().unwrap().as_raw_handle(),
                part,
                FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                FILE_OPEN,
                FILE_DIRECTORY_FILE,
                null(),
            )
            .map_err(|e| e.to_string())?;
            check_directory(relaxed.as_raw_handle())?;
            if handle_identity(handle.as_raw_handle())? != handle_identity(relaxed.as_raw_handle())?
            {
                return Err("destination directory changed during preparation".into());
            }
            strict_directories.push(handle);
            directories.push(relaxed);
        }
        let parent = directories.last().unwrap().as_raw_handle();
        let name = parts.last().unwrap().clone();
        // 早期拒绝已有文件；最终无覆盖操作仍独立处理 late-target 竞争。
        match open_relative(
            parent,
            &name,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_OPEN,
            0,
            null(),
        ) {
            Ok(_) => return Err("destination already exists; choose another name".into()),
            Err(e) if e.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) => {}
            Err(e) => return Err(e.to_string()),
        }
        let descriptor = private_descriptor()?;
        static NEXT: AtomicU64 = AtomicU64::new(0);
        // 名称不承担安全性：FILE_CREATE 原子拒绝碰撞，share=0 阻止其他数据句柄。
        let temp_name: Vec<u16> = format!(
            ".surreal-ck-{}-{}.part",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )
        .encode_utf16()
        .collect();
        let staging = File::from(
            open_relative(
                parent,
                &temp_name,
                FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | DELETE,
                0,
                FILE_CREATE,
                FILE_NON_DIRECTORY_FILE,
                descriptor.0,
            )
            .map_err(|e| e.to_string())?,
        );
        let destination = Self {
            directories,
            name,
            path,
            staging,
            published: false,
        };
        // 从现在起，每层目录至少含一个不能移动/删除的下层对象：目录链或 staging。
        // NTFS 的非空目录规则接替严格 WRITE 分享限制；较宽句柄始终禁止 DELETE。
        drop(strict_directories);
        // 从这里开始所有错误都经过 Destination::drop 的同句柄清理。
        let writer = destination.staging.try_clone().map_err(|e| e.to_string())?;
        Ok((destination, writer))
    }

    #[cfg(test)]
    pub(super) fn publish(self, file: &File) -> Result<PathBuf, String> {
        self.publish_tracked(file, &mut false)
    }

    // 与生产传输层保持一致：一旦原子发布成功，后置检查失败不能抹去保存事实。
    pub(super) fn publish_tracked(
        mut self,
        file: &File,
        published: &mut bool,
    ) -> Result<PathBuf, String> {
        if identity(file)? != identity(&self.staging)? {
            return Err("received file identity changed".into());
        }
        for directory in &self.directories {
            check_directory(directory.as_raw_handle())?;
        }
        file.sync_all().map_err(|e| e.to_string())?;
        // NtSetInformationFile 的原生结构明确支持固定 RootDirectory + 单组件名。
        // 不依赖 Win32 包装层的 DOS 路径转换，也不回退到绝对路径重命名。
        // 按 FILE_RENAME_INFORMATION 文档提供 sizeof(struct) + 名称字节数，
        // 保留零填充尾部；FileNameLength 仅计 UTF-16 名称，不含尾部 NUL/对齐。
        let bytes = size_of::<FILE_RENAME_INFORMATION>() + self.name.len() * 2;
        let mut buffer = aligned(bytes);
        let mut status_block = IO_STATUS_BLOCK::default();
        // SAFETY: 对齐缓冲区包含完整原生结构及 UTF-16 尾数组；句柄同步且存活。
        unsafe {
            let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
            (*info).Anonymous.ReplaceIfExists = false;
            (*info).RootDirectory = self.directories.last().unwrap().as_raw_handle();
            (*info).FileNameLength = (self.name.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(
                self.name.as_ptr(),
                (*info).FileName.as_mut_ptr(),
                self.name.len(),
            );
            // 源始终是持有的同一对象，目标始终是固定父目录 HANDLE 的单组件名。
            let status = NtSetInformationFile(
                self.staging.as_raw_handle(),
                &mut status_block,
                buffer.as_ptr().cast(),
                bytes as u32,
                FileRenameInformation,
            );
            // staging 使用 FILE_SYNCHRONOUS_IO_NONALERT；本调用完成后才释放缓冲区。
            // 不用 GetLastError 解释 NTSTATUS，保留原生状态便于核对具体失败阶段。
            if status < 0 {
                return Err(format!(
                    "NtSetInformationFile(FileRenameInformation) failed (NTSTATUS {:#010x}): {}",
                    status as u32,
                    io::Error::from_raw_os_error(RtlNtStatusToDosError(status) as i32)
                ));
            }
        }
        self.published = true;
        *published = true;
        // 已发布后失败也不得删除目标；只报告目录检查失败，不按名称回滚。
        for directory in &self.directories {
            check_directory(directory.as_raw_handle())?;
        }
        Ok(self.path.clone())
    }
}

impl Drop for Destination {
    fn drop(&mut self) {
        if !self.published {
            let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
            // SAFETY: 仅标记持有的临时对象删除。失败也不按可替换路径回退清理。
            // Drop 无返回值；原生测试必须验证支持的文件系统能完成此操作。
            unsafe {
                SetFileInformationByHandle(
                    self.staging.as_raw_handle(),
                    FileDispositionInfo,
                    (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                    size_of::<FILE_DISPOSITION_INFO>() as u32,
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Write, os::windows::fs::symlink_dir};

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "surreal-windows-destination-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn target(&self) -> PathBuf {
            self.0.join("received.bin")
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn rejects_ambiguous_and_reserved_paths() {
        for path in [
            "relative.bin",
            "C:relative.bin",
            "C:/parent/file",
            "C:\\parent/file", // 混合分隔符仍拒绝；夹具必须逐组件join。
            "\\\\server\\share\\file",
            "\\\\?\\C:\\file",
            "\\\\.\\C:\\file",
            "C:\\",
            "C:\\a\\..\\file",
            "C:\\.\\file",
            "C:\\a\\\\file",
            "C:\\a\\file.",
            "C:\\a\\file ",
            "C:\\a\\file:stream",
            "C:\\NUL.txt",
            "C:\\COM1",
            "C:\\LPT³.txt",
            "C:\\a\0b",
            "C:\\a?b",
        ] {
            assert!(checked_path(&PathBuf::from(path)).is_err(), "{path:?}");
        }
        assert!(checked_path(&PathBuf::from("C:\\approved\\中文.bin")).is_ok());
    }

    #[test]
    fn publishes_same_object_and_preserves_completed_file() {
        let dir = TestDir::new();
        let (destination, mut file) = Destination::prepare(dir.target()).unwrap();
        file.write_all(b"verified bytes").unwrap();
        let before = identity(&file).unwrap();
        assert_eq!(destination.publish(&file).unwrap(), dir.target());
        drop(file); // 独占源句柄关闭后才允许路径读取。
        assert_eq!(
            identity(&File::open(dir.target()).unwrap()).unwrap(),
            before
        );
        assert_eq!(fs::read(dir.target()).unwrap(), b"verified bytes");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn staging_dacl_is_protected_and_has_only_one_explicit_grant() {
        use windows_sys::Win32::Security::{
            Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
            EqualSid, GetAce, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
            ACCESS_ALLOWED_ACE, DACL_SECURITY_INFORMATION, SE_DACL_PROTECTED,
        };
        let dir = TestDir::new();
        let (destination, file) = Destination::prepare(dir.target()).unwrap();
        let mut descriptor = null_mut();
        assert_eq!(
            unsafe {
                GetSecurityInfo(
                    file.as_raw_handle(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    &mut descriptor,
                )
            },
            0
        );
        let allocation = LocalAllocation(descriptor);
        let mut control = 0;
        let mut revision = 0;
        assert_ne!(
            unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) },
            0
        );
        assert_ne!(control & SE_DACL_PROTECTED, 0);
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl = null_mut();
        assert_ne!(
            unsafe {
                GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted)
            },
            0
        );
        assert_ne!(present, 0);
        assert!(!dacl.is_null());
        assert_eq!(unsafe { (*dacl).AceCount }, 1);
        let expected = private_descriptor().unwrap();
        let mut expected_dacl = null_mut();
        assert_ne!(
            unsafe {
                GetSecurityDescriptorDacl(
                    expected.0,
                    &mut present,
                    &mut expected_dacl,
                    &mut defaulted,
                )
            },
            0
        );
        let mut actual_ace = null_mut();
        let mut expected_ace = null_mut();
        assert_ne!(unsafe { GetAce(dacl, 0, &mut actual_ace) }, 0);
        assert_ne!(unsafe { GetAce(expected_dacl, 0, &mut expected_ace) }, 0);
        // SAFETY: 两个 ACL 均由安全 API 返回；单个 grant 必须是 ACCESS_ALLOWED_ACE。
        unsafe {
            let actual = &*actual_ace.cast::<ACCESS_ALLOWED_ACE>();
            let expected = &*expected_ace.cast::<ACCESS_ALLOWED_ACE>();
            assert_eq!(actual.Header.AceType, 0);
            assert_eq!(actual.Header.AceFlags, 0);
            assert_eq!(actual.Mask, FILE_ALL_ACCESS);
            assert_ne!(
                EqualSid(
                    (&actual.SidStart as *const u32).cast_mut().cast(),
                    (&expected.SidStart as *const u32).cast_mut().cast()
                ),
                0
            );
        }
        drop(allocation);
        drop(destination);
        drop(file);
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
    }

    #[test]
    fn existing_and_late_targets_are_never_overwritten_or_deleted() {
        let dir = TestDir::new();
        fs::write(dir.target(), b"existing").unwrap();
        assert!(Destination::prepare(dir.target()).is_err());
        fs::remove_file(dir.target()).unwrap();
        let (destination, file) = Destination::prepare(dir.target()).unwrap();
        fs::write(dir.target(), b"late target").unwrap();
        let mut published = false;
        let error = destination
            .publish_tracked(&file, &mut published)
            .unwrap_err();
        // 不允许 API 参数错误冒充“禁止覆盖”通过，必须是实际目标名称碰撞。
        assert!(error.contains("NTSTATUS 0xc0000035"), "{error}");
        assert!(!published);
        drop(file);
        assert_eq!(fs::read(dir.target()).unwrap(), b"late target");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn source_and_ancestors_cannot_be_reopened_renamed_or_deleted() {
        let dir = TestDir::new();
        let approved = dir.0.join("approved");
        fs::create_dir(&approved).unwrap();
        let (destination, file) = Destination::prepare(approved.join("received.bin")).unwrap();
        let staging = fs::read_dir(&approved)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert!(File::open(&staging).is_err());
        assert!(fs::OpenOptions::new().write(true).open(&staging).is_err());
        assert!(fs::rename(&staging, approved.join("stolen")).is_err());
        assert!(fs::remove_file(&staging).is_err());
        assert!(fs::rename(&approved, dir.0.join("moved")).is_err());
        assert!(fs::rename(&dir.0, dir.0.with_extension("moved")).is_err());
        let sentinel = approved.join("unrelated.part");
        fs::write(&sentinel, b"keep").unwrap();
        drop(file); // Receiving/hash failure 可以先释放 writer。
        drop(destination);
        assert!(!staging.exists());
        assert_eq!(fs::read(sentinel).unwrap(), b"keep");
        assert_eq!(fs::read_dir(approved).unwrap().count(), 1);
    }

    #[test]
    fn cancellation_before_writer_drop_and_wrong_file_publish_are_safe() {
        let dir = TestDir::new();
        let (destination, file) = Destination::prepare(dir.target()).unwrap();
        drop(destination);
        drop(file);
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
        let sentinel = dir.0.join("sentinel.bin");
        fs::write(&sentinel, b"keep").unwrap();
        let (destination, file) = Destination::prepare(dir.target()).unwrap();
        assert!(destination
            .publish(&File::open(&sentinel).unwrap())
            .is_err());
        drop(file);
        assert_eq!(fs::read(sentinel).unwrap(), b"keep");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn existing_directory_delete_handle_causes_fail_closed() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = TestDir::new();
        let delete_handle = fs::OpenOptions::new()
            .access_mode(DELETE)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&dir.0)
            .unwrap();
        assert!(Destination::prepare(dir.target()).is_err());
        drop(delete_handle);
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
    }

    #[test]
    fn existing_directory_write_handle_causes_fail_closed_before_staging() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = TestDir::new();
        let writer = fs::OpenOptions::new()
            .access_mode(FILE_GENERIC_WRITE)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&dir.0)
            .unwrap();
        // 已存在可执行 FSCTL 的写句柄时，严格分享限制必须阻止开始接收。
        assert!(Destination::prepare(dir.target()).is_err());
        drop(writer);
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
    }

    #[test]
    fn late_directory_is_not_replaced_or_cleaned_up() {
        let dir = TestDir::new();
        let (destination, file) = Destination::prepare(dir.target()).unwrap();
        fs::create_dir(dir.target()).unwrap();
        let sentinel = dir.target().join("sentinel");
        fs::write(&sentinel, b"keep").unwrap();
        assert!(destination.publish(&file).is_err());
        drop(file);
        assert_eq!(fs::read(sentinel).unwrap(), b"keep");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn shortest_target_name_uses_full_native_rename_structure() {
        let dir = TestDir::new();
        let target = dir.0.join("x");
        let (destination, mut file) = Destination::prepare(target.clone()).unwrap();
        file.write_all(b"short name").unwrap();
        let before = identity(&file).unwrap();
        let mut published = false;
        assert_eq!(
            destination.publish_tracked(&file, &mut published).unwrap(),
            target
        );
        assert!(published);
        drop(file);
        assert_eq!(identity(&File::open(&target).unwrap()).unwrap(), before);
        assert_eq!(fs::read(target).unwrap(), b"short name");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn empty_unicode_file_publishes_relative_to_approved_parent() {
        let dir = TestDir::new();
        let parent = dir.0.join("approved");
        fs::create_dir(&parent).unwrap();
        let target = parent.join("空文件.bin");
        let (destination, file) = Destination::prepare(target.clone()).unwrap();
        let before = identity(&file).unwrap();
        let mut published = false;
        assert_eq!(
            destination.publish_tracked(&file, &mut published).unwrap(),
            target
        );
        assert!(published);
        drop(file);
        let published = File::open(&target).unwrap();
        assert_eq!(identity(&published).unwrap(), before);
        assert_eq!(published.metadata().unwrap().len(), 0);
        assert!(!dir.0.join("空文件.bin").exists());
    }

    fn exercise_nonempty_name_surrogate(symlink: bool) {
        use std::os::windows::fs::MetadataExt;
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::System::IO::DeviceIoControl;

        fn install(directory: &Path, target: &Path, symlink: bool) -> Result<(), io::Error> {
            // REPARSE_DATA_BUFFER：8 字节通用头，mount-point 8 字节名称头，symlink 12 字节。
            // 用实际 FSCTL 调用验证，不拿预检查或 mock 代替内核行为。
            let substitute: Vec<u16> = format!("\\??\\{}", target.display())
                .encode_utf16()
                .collect();
            let print: Vec<u16> = target.as_os_str().encode_wide().collect();
            let header_bytes = if symlink { 12 } else { 8 };
            let data_bytes = header_bytes + (substitute.len() + 1 + print.len() + 1) * 2;
            let mut buffer = vec![0u8; data_bytes + 8];
            let tag: u32 = if symlink { 0xA000000C } else { 0xA0000003 };
            buffer[0..4].copy_from_slice(&tag.to_le_bytes());
            buffer[4..6].copy_from_slice(&(data_bytes as u16).to_le_bytes());
            buffer[10..12].copy_from_slice(&((substitute.len() * 2) as u16).to_le_bytes());
            buffer[12..14].copy_from_slice(&(((substitute.len() + 1) * 2) as u16).to_le_bytes());
            buffer[14..16].copy_from_slice(&((print.len() * 2) as u16).to_le_bytes());
            for (index, unit) in substitute
                .into_iter()
                .chain([0])
                .chain(print)
                .chain([0])
                .enumerate()
            {
                let start = 8 + header_bytes + index * 2;
                buffer[start..start + 2].copy_from_slice(&unit.to_le_bytes());
            }
            let handle = fs::OpenOptions::new()
                .access_mode(FILE_GENERIC_WRITE)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(directory)?;
            let mut returned = 0;
            // FSCTL_SET_REPARSE_POINT = CTL_CODE(FILE_DEVICE_FILE_SYSTEM, 41, METHOD_BUFFERED, FILE_ANY_ACCESS).
            if unsafe {
                DeviceIoControl(
                    handle.as_raw_handle(),
                    0x000900A4,
                    buffer.as_ptr().cast(),
                    buffer.len() as u32,
                    null_mut(),
                    0,
                    &mut returned,
                    null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        let dir = TestDir::new();
        let elsewhere = TestDir::new();
        let control = dir.0.join("empty-control");
        fs::create_dir(&control).unwrap();
        // 正控制必须成功，防止权限不足、错误 buffer 或 API 不支持使负例假通过。
        install(&control, &elsewhere.0, symlink).unwrap();
        assert_ne!(
            fs::symlink_metadata(&control).unwrap().file_attributes()
                & FILE_ATTRIBUTE_REPARSE_POINT,
            0
        );
        fs::remove_dir(&control).unwrap();
        let approved = dir.0.join("approved");
        fs::create_dir(&approved).unwrap();
        let target = approved.join("received.bin");
        let (destination, mut file) = Destination::prepare(target.clone()).unwrap();
        for directory in [&dir.0, &approved] {
            let error = install(directory, &elsewhere.0, symlink).unwrap_err();
            assert_eq!(
                error.raw_os_error(),
                Some(145),
                "expected ERROR_DIR_NOT_EMPTY: {error}"
            );
        }
        file.write_all(b"verified bytes").unwrap();
        destination.publish(&file).unwrap();
        drop(file);
        assert_eq!(fs::read(target).unwrap(), b"verified bytes");
        assert_eq!(fs::read_dir(&elsewhere.0).unwrap().count(), 0);
    }

    #[test]
    fn ntfs_nonempty_chain_rejects_actual_junction_installation_after_share_transition() {
        exercise_nonempty_name_surrogate(false);
    }

    #[test]
    #[ignore = "requires a Windows runner already permitted to issue symlink FSCTL; no privilege changes"]
    fn ntfs_nonempty_chain_rejects_actual_symlink_installation_after_share_transition() {
        exercise_nonempty_name_surrogate(true);
    }

    #[test]
    #[ignore = "requires a Windows runner with symlink creation capability; run explicitly"]
    fn existing_and_late_destination_reparse_points_preserve_victim() {
        use std::os::windows::fs::symlink_file;
        let dir = TestDir::new();
        let victim = dir.0.join("victim.bin");
        fs::write(&victim, b"keep").unwrap();
        symlink_file(&victim, dir.target()).unwrap();
        assert!(Destination::prepare(dir.target()).is_err());
        fs::remove_file(dir.target()).unwrap();
        let (destination, file) = Destination::prepare(dir.target()).unwrap();
        symlink_file(&victim, dir.target()).unwrap();
        assert!(destination.publish(&file).is_err());
        drop(file);
        assert!(fs::symlink_metadata(dir.target())
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(victim).unwrap(), b"keep");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 2);
    }

    #[test]
    #[ignore = "requires a Windows runner with symlink creation capability; run explicitly"]
    fn rejects_reparse_points_at_every_directory_depth() {
        let dir = TestDir::new();
        let real = dir.0.join("real");
        fs::create_dir(&real).unwrap();
        fs::create_dir(real.join("nested")).unwrap();
        let alias = dir.0.join("alias");
        symlink_dir(&real, &alias).unwrap();
        assert!(Destination::prepare(alias.join("received.bin")).is_err());
        assert!(Destination::prepare(alias.join("nested\\received.bin")).is_err());
        let inner = real.join("inner");
        symlink_dir(real.join("nested"), &inner).unwrap();
        assert!(Destination::prepare(inner.join("received.bin")).is_err());
        assert_eq!(fs::read_dir(real.join("nested")).unwrap().count(), 0);
    }
}
