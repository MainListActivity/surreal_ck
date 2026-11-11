//! 原生Windows安装交接。调用者必须先通过核心签名策略，再把同一bytes送入prepare。
//! helper是经Authenticode验证的当前exe副本；main必须在初始化NSH前调用dispatch_helper。
use crate::windows_protocol::{self as protocol, Manifest};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle, process::CommandExt},
    path::{Component, Path, PathBuf, Prefix},
    process::{Child, ChildStdout, Command, Stdio},
    ptr,
    sync::mpsc,
    time::Duration,
};
use windows_sys::Win32::System::SystemServices::ACCESS_ALLOWED_ACE_TYPE;
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, Cryptography::*, WinTrust::*, *},
    Storage::FileSystem::*,
    System::{Com::CoTaskMemFree, Threading::*},
    UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath},
};

static HOST_DISPATCHED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn failure(message: &str) -> io::Error {
    io::Error::other(message)
}
fn wide(path: &OsStr) -> io::Result<Vec<u16>> {
    let mut result: Vec<u16> = path.encode_wide().collect();
    if result.contains(&0) {
        return Err(failure("NUL in path"));
    }
    result.push(0);
    Ok(result)
}
struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
struct Local(*mut core::ffi::c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
fn local_app_data() -> io::Result<PathBuf> {
    let mut value = ptr::null_mut();
    if unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, ptr::null_mut(), &mut value) } < 0 {
        return Err(failure("KnownFolder unavailable"));
    }
    let mut len = 0;
    while unsafe { *value.add(len) } != 0 {
        len += 1;
    }
    use std::os::windows::ffi::OsStringExt;
    let result = PathBuf::from(std::ffi::OsString::from_wide(unsafe {
        std::slice::from_raw_parts(value, len)
    }));
    unsafe {
        CoTaskMemFree(value.cast());
    }
    Ok(result)
}
fn sid_text() -> io::Result<String> {
    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = Handle(token);
    let mut size = 0;
    unsafe {
        GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut size);
    }
    let mut buffer = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    let mut text = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _free = Local(text.cast());
    let mut len = 0;
    while unsafe { *text.add(len) } != 0 {
        len += 1;
    }
    String::from_utf16(unsafe { std::slice::from_raw_parts(text, len) })
        .map_err(|_| failure("Invalid SID"))
}
fn descriptor(sid: &str) -> io::Result<Local> {
    // 仅新建私有目录的ACL；不修改已有目录/系统权限，不为管理员或Everyone授权。
    let sddl = wide(OsStr::new(&format!(
        "O:{sid}D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)"
    )))?;
    let mut descriptor = ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(Local(descriptor))
}
fn pin_directory(path: &Path) -> io::Result<Handle> {
    let value = wide(path.as_os_str())?;
    let handle = unsafe {
        CreateFileW(
            value.as_ptr(),
            READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let handle = Handle(handle);
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
    {
        return Err(failure("Reparse/non-directory rejected"));
    }
    Ok(handle)
}
fn pin_tree(path: &Path) -> io::Result<Vec<Handle>> {
    if !path.is_absolute()
        || !matches!(path.components().next(),Some(Component::Prefix(p)) if matches!(p.kind(),Prefix::Disk(_)|Prefix::VerbatimDisk(_)))
    {
        return Err(failure("Only absolute local disk paths are supported"));
    }
    if path
        .components()
        .any(|p| matches!(p, Component::ParentDir | Component::CurDir))
    {
        return Err(failure("Relative path component"));
    }
    let mut directories: Vec<_> = path.ancestors().collect();
    directories.reverse();
    directories.into_iter().map(pin_directory).collect()
}
fn check_private_acl(handle: &Handle, sid: &str) -> io::Result<()> {
    let mut owner = ptr::null_mut();
    let mut acl = ptr::null_mut();
    let mut sd = ptr::null_mut();
    let result = unsafe {
        GetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut acl,
            ptr::null_mut(),
            &mut sd,
        )
    };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result as i32));
    }
    let _sd = Local(sd);
    let mut control = 0;
    let mut revision = 0;
    if unsafe { GetSecurityDescriptorControl(sd, &mut control, &mut revision) } == 0
        || control & SE_DACL_PROTECTED == 0
        || acl.is_null()
    {
        return Err(failure("Unprotected/NULL DACL"));
    }
    let mut owner_text = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(owner, &mut owner_text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _owner = Local(owner_text.cast());
    let mut len = 0;
    while unsafe { *owner_text.add(len) } != 0 {
        len += 1;
    }
    if String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(owner_text, len) }) != sid {
        return Err(failure("Stage owner differs from current user"));
    }
    let mut allowed_user = false;
    let mut allowed_system = false;
    for index in 0..unsafe { (*acl).AceCount } as u32 {
        let mut ace = ptr::null_mut();
        if unsafe { GetAce(acl, index, &mut ace) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        if header.AceType != ACCESS_ALLOWED_ACE_TYPE as u8 {
            return Err(failure("Unexpected stage ACE"));
        }
        let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        if allowed.Mask != FILE_ALL_ACCESS {
            return Err(failure("Unexpected stage access mask"));
        }
        let mut text = ptr::null_mut();
        if unsafe {
            ConvertSidToStringSidW(
                (&allowed.SidStart as *const u32).cast_mut().cast(),
                &mut text,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let _text = Local(text.cast());
        let mut len = 0;
        while unsafe { *text.add(len) } != 0 {
            len += 1;
        }
        let text = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
        if text == sid {
            allowed_user = true;
        } else if text == "S-1-5-18" {
            allowed_system = true;
        } else {
            return Err(failure("Unexpected principal in stage ACL"));
        }
    }
    if !allowed_user || !allowed_system {
        return Err(failure("Incomplete private ACL"));
    }
    Ok(())
}
fn random_id() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    if unsafe {
        BCryptGenRandom(
            ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    } < 0
    {
        return Err(failure("System RNG failed"));
    }
    Ok(bytes.iter().map(|v| format!("{v:02x}")).collect())
}
fn locked_file(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0 {
        return Err(failure("Unsafe file type"));
    }
    Ok(file)
}
fn hash_reader(file: &mut File) -> io::Result<String> {
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    file.seek(SeekFrom::Start(0))?;
    Ok(format!("{:x}", hash.finalize()))
}
fn verify_publisher(path: &Path, file: &File, publisher: &str) -> io::Result<()> {
    let name = wide(path.as_os_str())?;
    let mut info = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: name.as_ptr(),
        hFile: file.as_raw_handle().cast(),
        pgKnownSubject: ptr::null_mut(),
    };
    let mut data = WINTRUST_DATA {
        cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_WHOLECHAIN,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 { pFile: &mut info },
        dwStateAction: WTD_STATEACTION_VERIFY,
        dwProvFlags: WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT,
        ..Default::default()
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let result = unsafe {
        WinVerifyTrust(
            INVALID_HANDLE_VALUE,
            &mut action,
            (&mut data as *mut WINTRUST_DATA).cast(),
        )
    };
    let verified = (|| {
        if result != 0 {
            return Err(failure("Authenticode validation failed"));
        }
        let provider = unsafe { WTHelperProvDataFromStateData(data.hWVTStateData) };
        if provider.is_null() {
            return Err(failure("Missing signature provider"));
        }
        let signer = unsafe { WTHelperGetProvSignerFromChain(provider, 0, 0, 0) };
        if signer.is_null()
            || unsafe { (*signer).csCertChain } == 0
            || unsafe { (*signer).pasCertChain }.is_null()
        {
            return Err(failure("Missing verified signer"));
        }
        let certificate = unsafe { (*(*signer).pasCertChain).pCert };
        if certificate.is_null() {
            return Err(failure("Missing verified certificate"));
        }
        let certificate = unsafe { &*certificate };
        let der = unsafe {
            std::slice::from_raw_parts(
                certificate.pbCertEncoded,
                certificate.cbCertEncoded as usize,
            )
        };
        if format!("{:x}", Sha256::digest(der)) != publisher.to_ascii_lowercase() {
            return Err(failure("Publisher certificate mismatch"));
        }
        Ok(())
    })();
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    unsafe {
        WinVerifyTrust(
            INVALID_HANDLE_VALUE,
            &mut action,
            (&mut data as *mut WINTRUST_DATA).cast(),
        );
    }
    verified
}
fn created(handle: HANDLE) -> io::Result<u64> {
    let (mut creation, mut exit, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((creation.dwHighDateTime as u64) << 32 | creation.dwLowDateTime as u64)
}
fn same_path(left: &Path, right: &Path) -> bool {
    match (left.to_str(), right.to_str()) {
        (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
        _ => false,
    }
}
fn target_dir() -> io::Result<PathBuf> {
    Ok(local_app_data()?.join("Programs").join("SurrealCK"))
}
fn receive_line(
    mut reader: BufReader<ChildStdout>,
) -> io::Result<(String, BufReader<ChildStdout>)> {
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("update-handshake".into())
        .spawn(move || {
            let mut line = String::new();
            let result = reader
                .by_ref()
                .take(256)
                .read_line(&mut line)
                .map(|_| (line, reader));
            let _ = tx.send(result);
        })?;
    rx.recv_timeout(Duration::from_secs(60))
        .map_err(|_| failure("Update helper handshake timed out"))?
}
struct Stage {
    path: PathBuf,
    pins: Vec<Handle>,
    files: Vec<File>,
    transferred: bool,
}
impl Drop for Stage {
    fn drop(&mut self) {
        self.files.clear();
        self.pins.clear();
        if !self.transferred {
            for name in ["setup.exe", "helper.exe", "request.json"] {
                let _ = fs::remove_file(self.path.join(name));
            }
            let _ = fs::remove_dir(&self.path);
        }
    }
}
/// 只能在arm_for_exit成功后请求旧进程退出。Drop未交接对象会取消自己的helper。
pub struct Handoff {
    child: Child,
    reader: Option<BufReader<ChildStdout>>,
    stage: Stage,
    nonce: String,
    armed: bool,
    attempt: protocol::Attempt,
    control: PathBuf,
    _reservation: File,
}
impl Drop for Handoff {
    fn drop(&mut self) {
        if !self.armed {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}
impl Handoff {
    /// 返回不表示安装完成；宿主必须优雅退出，helper等待120秒且绝不强杀旧进程。
    pub fn arm_for_exit(mut self) -> io::Result<()> {
        persist_attempt(&self.control, &self.attempt)?;
        let input = self
            .child
            .stdin
            .as_mut()
            .ok_or_else(|| failure("Missing helper stdin"))?;
        writeln!(input, "COMMIT {}", self.nonce)?;
        input.flush()?;
        let (line, _) = receive_line(
            self.reader
                .take()
                .ok_or_else(|| failure("Missing helper stdout"))?,
        )?;
        if !protocol::handshake_matches(&line, "COMMITTED", &self.nonce) {
            return Err(failure("Helper commit rejected"));
        }
        self.armed = true;
        self.stage.transferred = true;
        Ok(())
    }
}
/// 公开字段不是信任能力：只能由run_startup_with_installer成功验证后的closure构造。
pub struct VerifiedUpdate<'a> {
    pub old_version: &'a str,
    pub target_version: &'a str,
    pub bytes: &'a [u8],
    pub sha256: &'a str,
    pub publisher: &'a str,
}
pub fn prepare(update: VerifiedUpdate<'_>) -> io::Result<Handoff> {
    if !HOST_DISPATCHED.load(std::sync::atomic::Ordering::Acquire) {
        return Err(failure("Windows host did not register early helper dispatch; generated NSH runner is unsupported"));
    }
    let root = local_app_data()?;
    let mut pins = pin_tree(&root)?;
    let target = target_dir()?;
    pins.extend(pin_tree(&target)?);
    let current = std::env::current_exe()?;
    if !same_path(
        current
            .parent()
            .ok_or_else(|| failure("No executable parent"))?,
        &target,
    ) {
        return Err(failure(
            "Client is not installed in supported per-user Inno directory",
        ));
    }
    let mut source = locked_file(&current)?;
    verify_publisher(&current, &source, update.publisher)?;
    let nonce = random_id()?;
    let manifest = Manifest {
        old_version: update.old_version.into(),
        target_version: update.target_version.into(),
        parent_pid: std::process::id(),
        parent_created: created(unsafe { GetCurrentProcess() })?,
        restart_exe: current
            .to_str()
            .ok_or_else(|| failure("Non-Unicode executable path"))?
            .into(),
        size: update.bytes.len() as u64,
        sha256: update.sha256.into(),
        publisher: update.publisher.into(),
        nonce: nonce.clone(),
    };
    if !manifest.validate()
        || format!("{:x}", Sha256::digest(update.bytes)) != manifest.sha256.to_ascii_lowercase()
        || !update.bytes.starts_with(b"MZ")
    {
        return Err(failure("Unverified Windows update bytes"));
    }
    let (control, control_pin) = control_directory(&root)?;
    pins.push(control_pin);
    let reservation = reserve_staging(&control)?;
    if !protocol::may_attempt(
        control
            .join(format!("{}.json", manifest.sha256.to_ascii_lowercase()))
            .try_exists()?,
    ) {
        return Err(failure("This release already has a committed or uncertain update attempt; installed version did not satisfy the gate. Automatic retry is blocked; inspect update result."));
    }
    check_stage_capacity(
        &root,
        manifest
            .size
            .checked_add(source.metadata()?.len())
            .ok_or_else(|| failure("Stage size overflow"))?,
    )?;
    let path = root.join(format!("{}{}", protocol::STAGE_PREFIX, random_id()?));
    let sid = sid_text()?;
    let sd = descriptor(&sid)?;
    let security = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    };
    if unsafe { CreateDirectoryW(wide(path.as_os_str())?.as_ptr(), &security) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut stage = Stage {
        path,
        pins,
        files: vec![],
        transferred: false,
    };
    let directory = pin_directory(&stage.path)?;
    check_private_acl(&directory, &sid)?;
    stage.pins.push(directory);
    for (name, bytes) in [
        ("setup.exe", update.bytes),
        ("request.json", serde_json::to_vec(&manifest)?.as_slice()),
    ] {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(0)
            .open(stage.path.join(name))?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    let helper = stage.path.join("helper.exe");
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(0)
            .open(&helper)?;
        io::copy(&mut source, &mut file)?;
        file.sync_all()?;
    }
    let installer = locked_file(&stage.path.join("setup.exe"))?;
    verify_publisher(&stage.path.join("setup.exe"), &installer, update.publisher)?;
    stage.files.push(installer);
    let helper_lock = locked_file(&helper)?;
    verify_publisher(&helper, &helper_lock, update.publisher)?;
    stage.files.push(helper_lock);
    stage
        .files
        .push(locked_file(&stage.path.join("request.json"))?);
    let mut child = Command::new(&helper)
        .arg(protocol::HELPER_ARG)
        .arg(&stage.path)
        .current_dir(&stage.path)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let reader = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| failure("Missing helper output"))?,
    );
    let mut handoff = Handoff {
        child,
        reader: None,
        stage,
        nonce,
        armed: false,
        attempt: protocol::Attempt::committed(&manifest),
        control,
        _reservation: reservation,
    };
    let (line, reader) = receive_line(reader)?;
    if !protocol::handshake_matches(&line, "READY", &handoff.nonce) {
        return Err(failure("Helper readiness rejected"));
    }
    handoff.reader = Some(reader);
    Ok(handoff)
}
/// Windows main第一行调用；Some结果必须直接退出，不能回落到普通业务/登录界面。
pub fn dispatch_helper() -> Option<io::Result<()>> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(OsStr::new(protocol::HELPER_ARG)) {
        HOST_DISPATCHED.store(true, std::sync::atomic::Ordering::Release);
        return None;
    }
    Some((|| {
        let stage = PathBuf::from(args.next().ok_or_else(|| failure("Missing stage"))?);
        if args.next().is_some() {
            return Err(failure("Unexpected helper argument"));
        }
        run_helper(&stage)
    })())
}
fn run_helper(stage: &Path) -> io::Result<()> {
    let root = local_app_data()?;
    if !same_path(
        stage
            .parent()
            .ok_or_else(|| failure("Missing stage parent"))?,
        &root,
    ) || !stage
        .file_name()
        .and_then(OsStr::to_str)
        .is_some_and(protocol::is_stage_name)
    {
        return Err(failure("Invalid stage location"));
    }
    let pins = pin_tree(stage)?;
    check_private_acl(
        pins.last().ok_or_else(|| failure("Missing stage handle"))?,
        &sid_text()?,
    )?;
    if !same_path(&std::env::current_exe()?, &stage.join("helper.exe")) {
        return Err(failure("Helper must run from its own private stage"));
    }
    let mut request = locked_file(&stage.join("request.json"))?;
    if request.metadata()?.len() > 16384 {
        return Err(failure("Manifest too large"));
    }
    let manifest: Manifest = serde_json::from_reader(&mut request)?;
    if !manifest.validate() {
        return Err(failure("Invalid manifest"));
    }
    let exe = PathBuf::from(&manifest.restart_exe);
    let target = target_dir()?;
    let _target_pins = pin_tree(&target)?;
    if !same_path(
        exe.parent().ok_or_else(|| failure("Invalid executable"))?,
        &target,
    ) {
        return Err(failure("Unsupported restart target"));
    }
    let parent = unsafe {
        OpenProcess(
            PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            manifest.parent_pid,
        )
    };
    if parent.is_null() {
        return Err(io::Error::last_os_error());
    }
    let parent = Handle(parent);
    if created(parent.0)? != manifest.parent_created {
        return Err(failure("Parent PID was reused"));
    }
    let mut image = [0u16; 32768];
    let mut length = image.len() as u32;
    if unsafe { QueryFullProcessImageNameW(parent.0, 0, image.as_mut_ptr(), &mut length) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if !same_path(
        &PathBuf::from(String::from_utf16_lossy(&image[..length as usize])),
        &exe,
    ) {
        return Err(failure("Parent executable differs from restart target"));
    }
    let helper = locked_file(&stage.join("helper.exe"))?;
    verify_publisher(&stage.join("helper.exe"), &helper, &manifest.publisher)?;
    let mut installer = locked_file(&stage.join("setup.exe"))?;
    if installer.metadata()?.len() != manifest.size
        || hash_reader(&mut installer)? != manifest.sha256.to_ascii_lowercase()
    {
        return Err(failure("Installer changed"));
    }
    verify_publisher(&stage.join("setup.exe"), &installer, &manifest.publisher)?;
    let (control, _control_pin) = control_directory(&root)?;
    println!("READY {}", manifest.nonce);
    io::stdout().flush()?;
    let mut commit = String::new();
    io::stdin().lock().take(256).read_line(&mut commit)?;
    if !protocol::commit_matches(&commit, &manifest.nonce) {
        return Err(failure("Parent did not commit"));
    }
    let mut terminal = TerminalCleanup {
        stage: stage.to_path_buf(),
        control,
        hash: manifest.sha256.to_ascii_lowercase(),
        result: "commit-record-validation-failed",
        installer: Some(installer),
    };
    let mut attempt_file = locked_file(
        &terminal
            .control
            .join(format!("{}.json", manifest.sha256.to_ascii_lowercase())),
    )?;
    if attempt_file.metadata()?.len() > 4096 {
        return Err(failure("Oversized attempt record"));
    }
    let attempt: protocol::Attempt = serde_json::from_reader(&mut attempt_file)?;
    if !attempt.matches(&manifest) {
        return Err(failure("Update attempt does not match committed manifest"));
    }
    terminal.result = "commit-ack-failed";
    println!("COMMITTED {}", manifest.nonce);
    io::stdout().flush()?;
    terminal.result = "parent-exit-timeout-or-wait-failed";
    if unsafe { WaitForSingleObject(parent.0, 120000) } != WAIT_OBJECT_0 {
        return Err(failure("Parent did not exit; installer was not run"));
    }
    terminal.result = "installer-launch-or-exit-failed";
    let status = Command::new(stage.join("setup.exe"))
        .args([
            "/VERYSILENT",
            "/SUPPRESSMSGBOXES",
            "/NORESTART",
            "/SP-",
            "/NOCLOSEAPPLICATIONS",
            "/NORESTARTAPPLICATIONS",
        ])
        .arg(format!("/DIR={}", target.display()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if !status.success() {
        return Err(failure("Installer failed; no restart or Ready"));
    }
    terminal.result = "installed-executable-signature-failed";
    let installed = locked_file(&exe)?;
    verify_publisher(&exe, &installed, &manifest.publisher)?;
    terminal.result = "installed-executable-restart-failed";
    Command::new(&exe)
        .current_dir(&target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    // 新进程必须再次完整验策略。仅删除自己的大归档，保留helper/manifest供后续受控清理。
    terminal.result = "installer-exit0-restarted-gate-pending";
    Ok(())
}

// The control directory has the same protected ACL as an update stage. No pre-existing ACL is changed.
fn control_directory(root: &Path) -> io::Result<(PathBuf, Handle)> {
    let path = root.join(".SurrealCK-update-attempts");
    let sid = sid_text()?;
    let sd = descriptor(&sid)?;
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    };
    if unsafe { CreateDirectoryW(wide(path.as_os_str())?.as_ptr(), &sa) } == 0
        && io::Error::last_os_error().raw_os_error() != Some(ERROR_ALREADY_EXISTS as i32)
    {
        return Err(io::Error::last_os_error());
    }
    let handle = pin_directory(&path)?;
    check_private_acl(&handle, &sid)?;
    Ok((path, handle))
}
fn persist_attempt(control: &Path, attempt: &protocol::Attempt) -> io::Result<()> {
    // A partial write is intentionally retained: an uncertain commit must never automatically repeat.
    let entries = fs::read_dir(control)?
        .take(256)
        .collect::<io::Result<Vec<_>>>()?;
    let records = entries
        .iter()
        .filter(|entry| entry.path().extension() == Some(OsStr::new("json")))
        .count();
    // Reserve one result file per attempt, including results from helpers still running.
    if entries.len() >= 255 || records >= 127 {
        return Err(failure(
            "Update attempt history full; automatic installation blocked",
        ));
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .share_mode(0)
        .open(control.join(format!("{}.json", attempt.sha256)))?;
    file.write_all(&serde_json::to_vec(attempt)?)?;
    file.sync_all()
}
fn check_stage_capacity(root: &Path, incoming: u64) -> io::Result<()> {
    let mut count = 0usize;
    let mut bytes = 0u64;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !entry
            .file_name()
            .to_str()
            .is_some_and(protocol::is_stage_name)
        {
            continue;
        }
        count += 1;
        let _pin = pin_directory(&entry.path())?;
        // Never recurse or follow a user-controlled link. Unexpected stage contents block new work.
        for file in fs::read_dir(entry.path())? {
            let file = file?;
            if !matches!(
                file.file_name().to_str(),
                Some("setup.exe" | "helper.exe" | "request.json")
            ) {
                return Err(failure("Unexpected stage content"));
            }
            let locked = locked_file(&file.path())?;
            bytes = bytes
                .checked_add(locked.metadata()?.len())
                .ok_or_else(|| failure("Stage capacity overflow"))?;
        }
    }
    if !protocol::capacity_allows(count, bytes, incoming.saturating_add(16384)) {
        return Err(failure(
            "Update stage capacity exceeded; retained attempts need inspection",
        ));
    }
    Ok(())
}
struct TerminalCleanup {
    stage: PathBuf,
    control: PathBuf,
    hash: String,
    result: &'static str,
    installer: Option<File>,
}
impl Drop for TerminalCleanup {
    fn drop(&mut self) {
        self.installer.take(); // Release the no-delete-share handle before removing the archive.
        let cleanup = match fs::remove_file(self.stage.join("setup.exe")) {
            Ok(()) => "removed",
            Err(_) => "retained-cleanup-failed",
        };
        if let Ok(mut file) = OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(0)
            .open(self.control.join(format!("{}.result", self.hash)))
        {
            let _ = writeln!(file, "{}; archive={}", self.result, cleanup);
            let _ = file.sync_all();
        }
    }
}

// Serialize reservations across application processes, without modifying any existing ACL.
fn reserve_staging(control: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(control.join("reservation.lock"))?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0 {
        return Err(failure("Invalid staging reservation file"));
    }
    Ok(file)
}
