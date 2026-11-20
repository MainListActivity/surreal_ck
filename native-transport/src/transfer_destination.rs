//! Linux/Android接收目标：固定父目录、匿名inode、从同一FD原子无覆盖发布。
//! 不信任可被另一个有目录写权限的本地进程替换的临时文件路径。
use std::{
    ffi::CString,
    fs::File,
    io,
    mem::MaybeUninit,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::ffi::OsStrExt,
    },
    path::{Component, Path, PathBuf},
};

pub(super) struct Destination {
    directory: OwnedFd,
    name: CString,
    path: PathBuf,
}

fn owned(fd: RawFd) -> Result<OwnedFd, String> {
    if fd < 0 {
        Err(io::Error::last_os_error().to_string())
    } else {
        // SAFETY: 成功的open/openat返回一个新FD，只接管一次所有权。
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}
fn c_name(name: &std::ffi::OsStr) -> Result<CString, String> {
    CString::new(name.as_bytes()).map_err(|_| "invalid local destination name".into())
}
fn directory(path: &Path) -> Result<OwnedFd, String> {
    if !path.is_absolute() {
        return Err("destination directory must be absolute".into());
    }
    let flags = libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: 静态NUL结尾路径；不创建文件，不需要mode参数。
    let mut parent = owned(unsafe { libc::open(c"/".as_ptr(), flags) })?;
    for component in path.components() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(name) => {
                let name = c_name(name)?;
                // SAFETY: 父FD存活，name为单个路径分量。每层拒绝符号链接。
                parent = owned(unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) })?;
            }
            _ => return Err("choose a destination without parent traversal or symlinks".into()),
        }
    }
    Ok(parent)
}
fn identity(fd: RawFd) -> Result<(libc::dev_t, libc::ino_t), String> {
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    // SAFETY: 调用方持有FD；成功时fstat完整初始化stat。
    if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error().to_string());
    }
    // SAFETY: 已检查fstat成功。
    let stat = unsafe { stat.assume_init() };
    Ok((stat.st_dev, stat.st_ino))
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
        let name = c_name(path.file_name().ok_or("choose a destination file")?)?;
        let directory = directory(path.parent().ok_or("choose a destination directory")?)?;
        let mut stat = MaybeUninit::<libc::stat>::uninit();
        // SAFETY: FD与名称有效；只检查目标目录项，不跟随符号链接。
        let exists = unsafe {
            libc::fstatat(
                directory.as_raw_fd(),
                name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if exists == 0 {
            return Err("destination already exists; choose another name".into());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ENOENT) {
            return Err(error.to_string());
        }
        // SAFETY: 固定目录中创建无目录项的0600普通文件，不使用可替换的.part名称。
        // 不支持O_TMPFILE时明确失败，不降级为命名临时文件或可覆盖的rename。
        let file = owned(unsafe {
            libc::openat(
                directory.as_raw_fd(),
                c".".as_ptr(),
                libc::O_TMPFILE | libc::O_RDWR | libc::O_CLOEXEC,
                0o600 as libc::mode_t,
            )
        })
        .map_err(|e| {
            format!("secure receiving is unavailable on this filesystem (O_TMPFILE): {e}")
        })?;
        Ok((
            Self {
                directory,
                name,
                path,
            },
            File::from(file),
        ))
    }

    fn check_directory(&self) -> Result<(), String> {
        let current = directory(self.path.parent().expect("prepared absolute destination"))
            .map_err(|_| "approved destination directory changed; select it again")?;
        if identity(current.as_raw_fd())? != identity(self.directory.as_raw_fd())? {
            return Err("approved destination directory changed; select it again".into());
        }
        Ok(())
    }

    fn publish_via_proc(&self, file: &File) -> Result<(), String> {
        // 仅使用固定的内核本进程FD目录；不接受调用者提供proc路径。
        // SAFETY: 静态NUL结尾路径；O_PATH不要求目录读取权限。
        let proc_fd = owned(unsafe {
            libc::open(
                c"/proc/self/fd".as_ptr(),
                libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        })?;
        let mut stat = MaybeUninit::<libc::statfs>::uninit();
        // SAFETY: proc_fd存活，成功时初始化stat。
        if unsafe { libc::fstatfs(proc_fd.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        // SAFETY: 已检查fstatfs成功；只允许真正procfs的FD目录。
        if i128::from(unsafe { stat.assume_init() }.f_type) != i128::from(libc::PROC_SUPER_MAGIC) {
            return Err("secure file publication requires a trusted procfs FD directory".into());
        }
        let fd_name = CString::new(file.as_raw_fd().to_string()).expect("decimal fd");
        // SAFETY: file保持打开，内核数字入口始终指向该FD，不是命名.part。
        // linkat不覆盖目标；FOLLOW仅跟随内核FD入口，不跟随目标符号链接。
        if unsafe {
            libc::linkat(
                proc_fd.as_raw_fd(),
                fd_name.as_ptr(),
                self.directory.as_raw_fd(),
                self.name.as_ptr(),
                libc::AT_SYMLINK_FOLLOW,
            )
        } != 0
        {
            return Err(io::Error::last_os_error().to_string());
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn publish(self, file: &File) -> Result<PathBuf, String> {
        self.publish_tracked(file, &mut false)
    }
    pub(super) fn publish_tracked(
        self,
        file: &File,
        published: &mut bool,
    ) -> Result<PathBuf, String> {
        self.check_directory()?;
        // SAFETY: 直接从仍持有的已校验FD链接到固定目录，无临时路径替换窗口。
        let linked = unsafe {
            libc::linkat(
                file.as_raw_fd(),
                c"".as_ptr(),
                self.directory.as_raw_fd(),
                self.name.as_ptr(),
                libc::AT_EMPTY_PATH,
            )
        };
        if linked != 0 {
            let error = io::Error::last_os_error();
            // 无CAP_DAC_READ_SEARCH时Linux可返回ENOENT/EPERM。标准procfs同FD链接
            // 不需要扩权；其他错误（含目标已存在）直接失败，不做可覆盖的降级。
            if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::EPERM)) {
                self.publish_via_proc(file)?;
            } else {
                return Err(error.to_string());
            }
        }
        // link已成功；其后的路径核验失败也不能声称文件没有发布。
        *published = true;
        // 目录移动不会重定向到替换目录；但不能把漂移的原路径报告为完成。
        // 文件可能仍在原目录，不按可替换的目标名称做清理，避免误删其它本地文件。
        self.check_directory().map_err(|_| {
            "destination directory moved during publication; the verified file may remain in the originally approved directory".to_owned()
        })?;
        Ok(self.path)
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
            let path = std::env::temp_dir().join(format!(
                "surreal-ck-destination-test-{}",
                super::super::id_string(super::super::new_id())
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
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
    fn staging_is_anonymous_and_publishes_the_same_private_inode() {
        let dir = TestDir::new();
        let path = dir.path("received.bin");
        let (destination, mut file) = Destination::prepare(path.clone()).unwrap();
        assert_eq!(file.metadata().unwrap().nlink(), 0);
        assert_eq!(file.metadata().unwrap().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 0);
        file.write_all(b"verified bytes").unwrap();
        file.sync_all().unwrap();
        let inode = file.metadata().unwrap().ino();
        assert_eq!(destination.publish(&file).unwrap(), path);
        assert_eq!(std::fs::metadata(&path).unwrap().ino(), inode);
        assert_eq!(std::fs::read(&path).unwrap(), b"verified bytes");
        assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 1);
        // 丢弃未完成接收只关闭匿名FD，不留下或删除任何有名称的本地文件。
        let pending = Destination::prepare(dir.path("cancelled.bin")).unwrap();
        drop(pending);
        assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn existing_and_late_destination_symlinks_are_not_followed_or_deleted() {
        let dir = TestDir::new();
        let victim = dir.path("unrelated.bin");
        let path = dir.path("received.bin");
        std::fs::write(&victim, b"local file").unwrap();
        symlink(&victim, &path).unwrap();
        assert!(Destination::prepare(path.clone()).is_err());
        std::fs::remove_file(&path).unwrap();
        let (destination, mut file) = Destination::prepare(path.clone()).unwrap();
        file.write_all(b"received bytes").unwrap();
        symlink(&victim, &path).unwrap();
        assert!(destination.publish(&file).is_err());
        assert!(std::fs::symlink_metadata(&path).unwrap().is_symlink());
        assert_eq!(std::fs::read(victim).unwrap(), b"local file");
    }

    #[test]
    fn replaced_parent_never_redirects_publication_or_cleanup() {
        for replacement_is_symlink in [true, false] {
            let dir = TestDir::new();
            let approved = dir.path("approved");
            let moved = dir.path("moved");
            let elsewhere = dir.path("elsewhere");
            std::fs::create_dir(&approved).unwrap();
            std::fs::create_dir(&elsewhere).unwrap();
            let (destination, mut file) =
                Destination::prepare(approved.join("received.bin")).unwrap();
            file.write_all(b"received bytes").unwrap();
            std::fs::rename(&approved, &moved).unwrap();
            if replacement_is_symlink {
                symlink(&elsewhere, &approved).unwrap();
            } else {
                std::fs::create_dir(&approved).unwrap();
            }
            let sentinel = approved.join(".surreal-ck-unrelated.part");
            std::fs::write(&sentinel, b"not our temporary file").unwrap();
            assert!(destination.publish(&file).is_err());
            drop(file);
            assert!(!approved.join("received.bin").exists());
            assert_eq!(std::fs::read_dir(moved).unwrap().count(), 0);
            assert_eq!(std::fs::read(sentinel).unwrap(), b"not our temporary file");
            if replacement_is_symlink {
                assert!(Destination::prepare(approved.join("another.bin")).is_err());
            }
        }
    }

    #[test]
    fn trusted_proc_fd_fallback_is_same_inode_and_noreplace() {
        let dir = TestDir::new();
        let path = dir.path("received.bin");
        let (destination, mut file) = Destination::prepare(path.clone()).unwrap();
        file.write_all(b"proc fd bytes").unwrap();
        // 强制实际procfs/linkat分支，不用mock冒充内核支持。
        destination.publish_via_proc(&file).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().ino(),
            file.metadata().unwrap().ino()
        );
        assert!(destination.publish_via_proc(&file).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"proc fd bytes");
    }

    #[test]
    fn directory_handle_does_not_require_directory_read_permission() {
        let dir = TestDir::new();
        let approved = dir.path("write-and-execute-only");
        std::fs::create_dir(&approved).unwrap();
        std::fs::set_permissions(&approved, std::fs::Permissions::from_mode(0o300)).unwrap();
        let result = Destination::prepare(approved.join("received.bin"))
            .and_then(|(destination, file)| destination.publish(&file));
        std::fs::set_permissions(&approved, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_ok(), "{result:?}");
    }
}
