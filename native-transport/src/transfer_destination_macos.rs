//! macOS候选接收后端：固定目录FD、受保护的staging、RENAME_EXCL发布。
//! 仅由独立原生验证harness编入；原生负例验收前不启用生产接收。
//! 与O_TMPFILE不同，顶层私有staging根有名称，且故意保留为空目录。
//! 不通过可被本地目录写入者置换的顶层名称做清理。
use std::{
    ffi::{c_void, CStr, CString, OsStr},
    fs::File,
    io,
    mem::MaybeUninit,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::ffi::OsStrExt,
    },
    path::{Component, Path, PathBuf},
};

const ROOT_NAME: &CStr = c".surreal-ck-receive";
const PAYLOAD: &CStr = c"payload";
const FILESEC_ACL: libc::c_int = 5;

// libc 0.2.191没有导出这些公开Darwin接口。声明来自Apple sys/fcntl.h和sys/stat.h；
// 不把acl_get_fd_np的NULL/ENOENT模糊结果当作无ACL证据。
unsafe extern "C" {
    fn filesec_init() -> *mut c_void;
    fn filesec_free(security: *mut c_void);
    fn filesec_query_property(
        security: *mut c_void,
        property: libc::c_int,
        present: *mut libc::c_int,
    ) -> libc::c_int;
    #[cfg_attr(target_arch = "x86_64", link_name = "fstatx_np$INODE64")]
    fn fstatx_np(fd: libc::c_int, stat: *mut libc::stat, security: *mut c_void) -> libc::c_int;
}

struct FileSecurity(*mut c_void);
impl Drop for FileSecurity {
    fn drop(&mut self) {
        // SAFETY: 指针只由filesec_init成功结果创建并在这里释放一次。
        unsafe { filesec_free(self.0) };
    }
}

fn last_error() -> String {
    io::Error::last_os_error().to_string()
}
fn owned(fd: RawFd) -> Result<OwnedFd, String> {
    if fd < 0 {
        Err(last_error())
    } else {
        // SAFETY: 成功open/openat返回新FD，所有权仅接管一次。
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}
fn name(value: &OsStr) -> Result<CString, String> {
    CString::new(value.as_bytes()).map_err(|_| "invalid local destination name".into())
}
fn stat(fd: RawFd) -> Result<libc::stat, String> {
    let mut stat = MaybeUninit::uninit();
    // SAFETY: FD存活，成功时完整初始化stat。
    if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
        return Err(last_error());
    }
    // SAFETY: 已检查fstat成功。
    Ok(unsafe { stat.assume_init() })
}
fn identity(fd: RawFd) -> Result<(libc::dev_t, libc::ino_t), String> {
    let stat = stat(fd)?;
    Ok((stat.st_dev, stat.st_ino))
}
fn directory(path: &Path) -> Result<OwnedFd, String> {
    if !path.is_absolute() {
        return Err("destination directory must be absolute".into());
    }
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: 静态绝对路径，只打开现有目录。
    let mut parent = owned(unsafe { libc::open(c"/".as_ptr(), flags) })?;
    for component in path.components() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(value) => {
                let value = name(value)?;
                // SAFETY: 仅相对固定FD解析单个分量；每层拒绝符号链接。
                parent = owned(unsafe { libc::openat(parent.as_raw_fd(), value.as_ptr(), flags) })?;
            }
            _ => return Err("choose a destination without parent traversal or symlinks".into()),
        }
    }
    Ok(parent)
}

fn local_filesystem(fd: RawFd) -> Result<(), String> {
    let mut fs = MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: FD存活，成功时初始化fs。
    if unsafe { libc::fstatfs(fd, fs.as_mut_ptr()) } != 0 {
        return Err(last_error());
    }
    // SAFETY: 已检查fstatfs成功；用数组有界切片读取文件系统名。
    let fs = unsafe { fs.assume_init() };
    let kind: Vec<u8> = fs
        .f_fstypename
        .iter()
        .take_while(|&&v| v != 0)
        .map(|&v| v as u8)
        .collect();
    if fs.f_flags & libc::MNT_LOCAL as u32 == 0 || kind != b"apfs" {
        return Err("secure receiving currently requires a local APFS volume".into());
    }
    Ok(())
}

fn private_object(fd: RawFd, expected_type: libc::mode_t) -> Result<libc::stat, String> {
    // SAFETY: 无参数，返回由filesec_free管理的新描述对象。
    let security = unsafe { filesec_init() };
    if security.is_null() {
        return Err(last_error());
    }
    let security = FileSecurity(security);
    let mut info = MaybeUninit::<libc::stat>::uninit();
    // SAFETY: FD和security有效，成功时初始化info。
    if unsafe { fstatx_np(fd, info.as_mut_ptr(), security.0) } != 0 {
        return Err(format!(
            "cannot verify staging permissions: {}",
            last_error()
        ));
    }
    let mut acl_present = -1;
    // SAFETY: security由成功fstatx填充，present指向有效int。
    if unsafe { filesec_query_property(security.0, FILESEC_ACL, &mut acl_present) } != 0 {
        return Err(format!("cannot verify staging ACL: {}", last_error()));
    }
    // SAFETY: fstatx成功，geteuid不接受指针。
    let info = unsafe { info.assume_init() };
    let uid = unsafe { libc::geteuid() };
    if info.st_uid != uid
        || info.st_mode & libc::S_IFMT != expected_type
        || info.st_mode & 0o077 != 0
        || info.st_mode & 0o7000 != 0
        || acl_present != 0
    {
        return Err("staging must be owned by this user, private, and have no extended ACL".into());
    }
    Ok(info)
}

fn open_private_child(parent: RawFd, child: &CStr, create: bool) -> Result<OwnedFd, String> {
    if create {
        // SAFETY: parent固定，child为单个分量，创建0700目录但不改已有目录权限。
        if unsafe { libc::mkdirat(parent, child.as_ptr(), 0o700) } != 0 {
            return Err(last_error());
        }
    }
    // SAFETY: 拒符号链接并持有返回的目录FD。
    let fd = owned(unsafe {
        libc::openat(
            parent,
            child.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    })?;
    private_object(fd.as_raw_fd(), libc::S_IFDIR)?;
    Ok(fd)
}

pub(super) struct Destination {
    directory: OwnedFd,
    staging_root: OwnedFd,
    staging: OwnedFd,
    child_name: CString,
    name: CString,
    path: PathBuf,
    source_identity: Option<(libc::dev_t, libc::ino_t)>,
    pending: bool,
}

impl Destination {
    pub(super) fn prepare(path: PathBuf) -> Result<(Self, File), String> {
        if !matches!(path.components().next_back(), Some(Component::Normal(_))) {
            return Err("choose a destination file".into());
        }
        let path = if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .map_err(|e| e.to_string())?
                .join(path)
        };
        let name = name(path.file_name().ok_or("choose a destination file")?)?;
        if name.as_c_str() == ROOT_NAME {
            return Err("choose a filename other than the private receiving directory".into());
        }
        let directory = directory(path.parent().ok_or("choose a destination directory")?)?;
        local_filesystem(directory.as_raw_fd())?;
        let mut existing = MaybeUninit::<libc::stat>::uninit();
        // SAFETY: 只做提前用户反馈；真正无覆盖由RENAME_EXCL保证。
        if unsafe {
            libc::fstatat(
                directory.as_raw_fd(),
                name.as_ptr(),
                existing.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } == 0
        {
            return Err("destination already exists; choose another name".into());
        }
        if io::Error::last_os_error().raw_os_error() != Some(libc::ENOENT) {
            return Err(last_error());
        }
        // 此名称可被其他目录写入者移动。我们从不根据这个名称清理任何对象。
        // SAFETY: 固定目录FD、固定单分量；EEXIST仅允许随后打开并验证实际FD。
        if unsafe { libc::mkdirat(directory.as_raw_fd(), ROOT_NAME.as_ptr(), 0o700) } != 0
            && io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST)
        {
            return Err(last_error());
        }
        let staging_root = open_private_child(directory.as_raw_fd(), ROOT_NAME, false)?;
        local_filesystem(staging_root.as_raw_fd())?;
        if stat(staging_root.as_raw_fd())?.st_dev != stat(directory.as_raw_fd())?.st_dev {
            return Err("staging must be on the approved destination volume".into());
        }
        let mut random = [0u8; 16];
        // SAFETY: arc4random_buf填满给定缓冲区，不作为认证凭据。
        unsafe { libc::arc4random_buf(random.as_mut_ptr().cast(), random.len()) };
        let child_name = CString::new(
            random
                .iter()
                .map(|v| format!("{v:02x}"))
                .collect::<String>(),
        )
        .expect("hex name");
        let staging = open_private_child(staging_root.as_raw_fd(), &child_name, true)?;
        let mut destination = Self {
            directory,
            staging_root,
            staging,
            child_name,
            name,
            path,
            source_identity: None,
            pending: false,
        };
        // 根和子目录均已验证为私有且无ACL。其他UID无法替换payload目录项。
        // SAFETY: 固定私有目录FD，O_EXCL拒任何现有对象，包括符号链接。
        let file = File::from(owned(unsafe {
            libc::openat(
                destination.staging.as_raw_fd(),
                PAYLOAD.as_ptr(),
                libc::O_CREAT | libc::O_EXCL | libc::O_RDWR | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600 as libc::c_uint,
            )
        })?);
        destination.pending = true;
        let info = private_object(file.as_raw_fd(), libc::S_IFREG)?;
        if info.st_nlink != 1 {
            return Err("unexpected staging hard link".into());
        }
        destination.source_identity = Some((info.st_dev, info.st_ino));
        destination.check_directory()?;
        Ok((destination, file))
    }

    fn check_directory(&self) -> Result<(), String> {
        let current = directory(self.path.parent().expect("prepared absolute destination"))
            .map_err(|_| "approved destination directory changed; select it again")?;
        if identity(current.as_raw_fd())? != identity(self.directory.as_raw_fd())? {
            return Err("approved destination directory changed; select it again".into());
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn publish(self, file: &File) -> Result<PathBuf, String> {
        self.publish_tracked(file, &mut false)
    }

    // 与生产传输层保持一致：一旦原子发布成功，后置检查失败不能抹去保存事实。
    pub(super) fn publish_tracked(
        self,
        file: &File,
        published: &mut bool,
    ) -> Result<PathBuf, String> {
        self.publish_tracked_inner(file, published, || {})
    }

    fn publish_tracked_inner(
        mut self,
        file: &File,
        published: &mut bool,
        after_commit: impl FnOnce(),
    ) -> Result<PathBuf, String> {
        self.check_directory()?;
        private_object(self.staging_root.as_raw_fd(), libc::S_IFDIR)?;
        private_object(self.staging.as_raw_fd(), libc::S_IFDIR)?;
        let info = private_object(file.as_raw_fd(), libc::S_IFREG)?;
        if Some((info.st_dev, info.st_ino)) != self.source_identity || info.st_nlink != 1 {
            return Err("staging file identity changed".into());
        }
        // 身份检查是内部不变量检查，不声称消除同UID攻击。安全源于已经固定且
        // 其他UID无法修改内容的私有staging，而不是lstat之后的路径rename。
        // SAFETY: 两个FD存活，名称均单分量；RENAME_EXCL禁止覆盖任何目标项。
        if unsafe {
            libc::renameatx_np(
                self.staging.as_raw_fd(),
                PAYLOAD.as_ptr(),
                self.directory.as_raw_fd(),
                self.name.as_ptr(),
                libc::RENAME_EXCL,
            )
        } != 0
        {
            return Err(last_error());
        }
        self.pending = false;
        *published = true;
        after_commit();
        self.check_directory().map_err(|_| "destination directory moved during publication; the verified file may remain in the originally approved directory".to_owned())?;
        Ok(self.path.clone())
    }
}

impl Drop for Destination {
    fn drop(&mut self) {
        // 仅在持有的私有目录FD内部清理；从不按目标父路径/顶层staging名称删除。
        // 私有权限验证失败时宁可留下staging，不能误删可能变得可替换的目录项。
        if private_object(self.staging_root.as_raw_fd(), libc::S_IFDIR).is_err()
            || private_object(self.staging.as_raw_fd(), libc::S_IFDIR).is_err()
        {
            return;
        }
        if self.pending {
            // SAFETY: payload位于其他UID不可写的固定目录内；不跟随符号链接。
            unsafe { libc::unlinkat(self.staging.as_raw_fd(), PAYLOAD.as_ptr(), 0) };
        }
        // SAFETY: 子目录名称位于同样受保护的固定根中，只移除空目录，不递归删除。
        unsafe {
            libc::unlinkat(
                self.staging_root.as_raw_fd(),
                self.child_name.as_ptr(),
                libc::AT_REMOVEDIR,
            )
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        os::unix::fs::{symlink, MetadataExt, PermissionsExt},
    };

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let mut random = [0u8; 16];
            // SAFETY: 缓冲区有效。
            unsafe { libc::arc4random_buf(random.as_mut_ptr().cast(), random.len()) };
            let path = std::env::temp_dir().join(format!(
                "surreal-ck-macos-{:032x}",
                u128::from_ne_bytes(random)
            ));
            std::fs::create_dir(&path).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            Self(path.canonicalize().unwrap())
        }
        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn private_staging_publishes_same_inode_and_cancel_keeps_only_empty_root() {
        let dir = TestDir::new();
        let path = dir.path("received.bin");
        let (destination, mut file) = Destination::prepare(path.clone()).unwrap();
        assert_eq!(file.metadata().unwrap().mode() & 0o777, 0o600);
        file.write_all(b"verified bytes").unwrap();
        file.sync_all().unwrap();
        let inode = file.metadata().unwrap().ino();
        let mut published = false;
        assert_eq!(
            destination.publish_tracked(&file, &mut published).unwrap(),
            path
        );
        assert!(published);
        assert_eq!(std::fs::metadata(&path).unwrap().ino(), inode);
        assert_eq!(std::fs::read(&path).unwrap(), b"verified bytes");
        drop(Destination::prepare(dir.path("cancel.bin")).unwrap());
        assert!(!dir.path("cancel.bin").exists());
        assert_eq!(
            std::fs::read_dir(dir.path(".surreal-ck-receive"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn existing_and_late_targets_are_never_overwritten() {
        let dir = TestDir::new();
        let victim = dir.path("victim");
        std::fs::write(&victim, b"unrelated").unwrap();
        assert!(Destination::prepare(victim.clone()).is_err());
        for kind in ["file", "directory", "symlink"] {
            let path = dir.path(kind);
            let (destination, mut file) = Destination::prepare(path.clone()).unwrap();
            file.write_all(b"received").unwrap();
            match kind {
                "file" => std::fs::write(&path, b"late").unwrap(),
                "directory" => std::fs::create_dir(&path).unwrap(),
                _ => symlink(&victim, &path).unwrap(),
            }
            let mut published = false;
            assert!(destination.publish_tracked(&file, &mut published).is_err());
            assert!(!published);
            assert_eq!(std::fs::read(&victim).unwrap(), b"unrelated");
            assert!(std::fs::symlink_metadata(&path).is_ok());
        }
    }

    #[test]
    fn replaced_staging_root_cannot_redirect_publish_or_cancel() {
        let dir = TestDir::new();
        let path = dir.path("received");
        let (destination, mut file) = Destination::prepare(path.clone()).unwrap();
        file.write_all(b"verified").unwrap();
        let root = dir.path(".surreal-ck-receive");
        let moved = dir.path("moved-staging");
        std::fs::rename(&root, &moved).unwrap();
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(root.join("payload"), b"unrelated").unwrap();
        destination.publish(&file).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"verified");
        assert_eq!(std::fs::read(root.join("payload")).unwrap(), b"unrelated");
        assert_eq!(std::fs::read_dir(&moved).unwrap().count(), 0);
        std::fs::remove_file(root.join("payload")).unwrap();
        let pending = Destination::prepare(dir.path("cancel")).unwrap();
        std::fs::rename(&root, dir.path("moved-cancel")).unwrap();
        symlink(&moved, &root).unwrap();
        drop(pending);
        assert!(std::fs::symlink_metadata(&root).unwrap().is_symlink());
        assert_eq!(
            std::fs::read_dir(dir.path("moved-cancel")).unwrap().count(),
            0
        );
    }

    #[test]
    fn directory_moved_after_commit_retains_publication_fact_and_verified_file() {
        let dir = TestDir::new();
        let parent = dir.path("approved");
        let moved = dir.path("moved");
        std::fs::create_dir(&parent).unwrap();
        let (destination, mut file) = Destination::prepare(parent.join("received")).unwrap();
        file.write_all(b"verified").unwrap();
        file.sync_all().unwrap();
        let mut published = false;
        // 在真实 RENAME_EXCL 成功之后确定性移动目录，不模拟发布系统调用。
        let result = destination.publish_tracked_inner(&file, &mut published, || {
            std::fs::rename(&parent, &moved).unwrap();
            std::fs::create_dir(&parent).unwrap();
            std::fs::write(parent.join("received"), b"unrelated").unwrap();
        });
        assert!(result.unwrap_err().contains("may remain"));
        assert!(published, "取消不能把已保存文件报告为未发布");
        assert_eq!(std::fs::read(moved.join("received")).unwrap(), b"verified");
        assert_eq!(
            std::fs::read(parent.join("received")).unwrap(),
            b"unrelated"
        );
        assert_eq!(
            std::fs::read_dir(moved.join(".surreal-ck-receive"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn parent_replacement_fails_without_touching_replacement() {
        let dir = TestDir::new();
        let parent = dir.path("approved");
        std::fs::create_dir(&parent).unwrap();
        let (destination, file) = Destination::prepare(parent.join("received")).unwrap();
        std::fs::rename(&parent, dir.path("moved")).unwrap();
        std::fs::create_dir(&parent).unwrap();
        std::fs::write(parent.join("received"), b"unrelated").unwrap();
        assert!(destination.publish(&file).is_err());
        assert_eq!(
            std::fs::read(parent.join("received")).unwrap(),
            b"unrelated"
        );
        assert!(!dir.path("moved/received").exists());
    }

    #[test]
    fn symlink_or_nonprivate_staging_is_rejected_before_payload_creation() {
        let dir = TestDir::new();
        let root = dir.path(".surreal-ck-receive");
        symlink(&dir.0, &root).unwrap();
        assert!(Destination::prepare(dir.path("received")).is_err());
        std::fs::remove_file(&root).unwrap();
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(Destination::prepare(dir.path("received")).is_err());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    }

    #[test]
    fn inherited_acl_is_rejected_even_when_mode_is_0700() {
        let dir = TestDir::new();
        let status = std::process::Command::new("/bin/chmod").args(["+a", "everyone allow list,add_file,search,add_subdirectory,file_inherit,directory_inherit"]).arg(&dir.0).status().unwrap();
        assert!(status.success(), "native ACL fixture setup must succeed");
        assert!(Destination::prepare(dir.path("received")).is_err());
        assert!(!dir.path("received").exists());
        let root = dir.path(".surreal-ck-receive");
        assert_eq!(std::fs::metadata(&root).unwrap().mode() & 0o777, 0o700);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    }

    #[test]
    fn extra_source_hard_link_is_rejected_without_deleting_unrelated_link() {
        let dir = TestDir::new();
        let (destination, mut file) = Destination::prepare(dir.path("received")).unwrap();
        file.write_all(b"verified").unwrap();
        let child = destination.child_name.to_str().unwrap();
        let source = dir.path(".surreal-ck-receive").join(child).join("payload");
        let extra = dir.path("extra-link");
        std::fs::hard_link(&source, &extra).unwrap();
        assert!(destination.publish(&file).is_err());
        assert!(!dir.path("received").exists());
        assert_eq!(std::fs::read(&extra).unwrap(), b"verified");
        assert!(!source.exists());
    }

    #[test]
    fn permissions_changed_after_prepare_fail_closed_and_leave_staging() {
        let dir = TestDir::new();
        let (destination, mut file) = Destination::prepare(dir.path("received")).unwrap();
        file.write_all(b"verified").unwrap();
        let child = destination.child_name.to_str().unwrap();
        let staging = dir.path(".surreal-ck-receive").join(child);
        std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(destination.publish(&file).is_err());
        assert!(!dir.path("received").exists());
        // 无法证明私有权限后，不按可能已被替换的名称回收。
        assert_eq!(std::fs::read(staging.join("payload")).unwrap(), b"verified");
    }

    #[test]
    fn incorrect_file_and_symlinked_parent_are_rejected() {
        let dir = TestDir::new();
        let (destination, _file) = Destination::prepare(dir.path("received")).unwrap();
        let unrelated = dir.path("unrelated");
        std::fs::write(&unrelated, b"unrelated").unwrap();
        let other_file = File::open(&unrelated).unwrap();
        assert!(destination.publish(&other_file).is_err());
        assert_eq!(std::fs::read(&unrelated).unwrap(), b"unrelated");
        let linked = dir.path("linked");
        symlink(&dir.0, &linked).unwrap();
        assert!(Destination::prepare(linked.join("received")).is_err());
        assert!(Destination::prepare(dir.path("missing/../received")).is_err());
        assert!(!dir.path("received").exists());
    }
}
