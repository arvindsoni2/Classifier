//! Anchored resolution: openat2 with RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
//! RESOLVE_NO_XDEV, RENAME_NOREPLACE via renameat2, and the error vocabulary.
//!
//! Every path operation is anchored to a verified root descriptor: absolute
//! paths, empty components, dot/dot-dot and NUL are rejected; ordinary
//! Unicode and shell-like characters are data, never syntax. If either
//! mandatory primitive is missing the helper refuses (UNSUPPORTED_KERNEL).

use std::ffi::CString;
use std::fs::File;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::io::{AsRawFd, FromRawFd, RawFd};
use std::path::Path;

use serde::Deserialize;

use crate::error::{map_errno, FsError};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootConfigJson {
    pub absolute_path: String,
    pub device: String,
    pub inode: String,
}

/// An owned descriptor for the verified organisation root.
pub struct RootHandle {
    fd: File,
    pub device: u64,
    pub inode: u64,
}

impl RootHandle {
    pub fn fd(&self) -> RawFd {
        self.fd.as_raw_fd()
    }
}

impl Drop for RootHandle {
    fn drop(&mut self) {
        // File closes the descriptor.
    }
}

/// An owned descriptor for a resolved directory beneath the root.
pub struct DirHandle {
    fd: File,
    pub device: u64,
    pub inode: u64,
}

impl DirHandle {
    pub fn fd(&self) -> RawFd {
        self.fd.as_raw_fd()
    }
}

/// An owned descriptor for a resolved regular file beneath the root.
pub struct FileHandle {
    file: File,
    pub device: u64,
    pub inode: u64,
    pub size: u64,
}

impl FileHandle {
    pub fn file(&self) -> &File {
        &self.file
    }
}

pub struct KernelCaps {
    pub openat2: bool,
    pub renameat2_noreplace: bool,
}

// open(2) flags.
const O_RDONLY: i32 = 0;
const O_WRONLY: i32 = 1;
const O_CREAT: i32 = 0o100;
const O_EXCL: i32 = 0o200;
const O_DIRECTORY: i32 = 0o200000;
const O_NOFOLLOW: i32 = 0o400000;
const O_CLOEXEC: i32 = 0o2000000;

// openat2 resolve flags (linux/openat2.h).
pub const RESOLVE_NO_XDEV: u64 = 0x01;
pub const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
pub const RESOLVE_NO_SYMLINKS: u64 = 0x04;
pub const RESOLVE_BENEATH: u64 = 0x08;

const RESOLVE_FLAGS: u64 = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV | RESOLVE_NO_MAGICLINKS;

const RENAME_NOREPLACE: u32 = 1 << 0;

#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

fn fstat_of(fd: RawFd) -> Result<libc::stat, FsError> {
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::fstat(fd, &mut stat) };
    if rc == -1 {
        return Err(map_errno("fstat", unsafe { *libc::__errno_location() }));
    }
    Ok(stat)
}

/// Validates a path component: ordinary names only; no separators, dots,
/// empty components or NUL. Shell-like characters are data.
pub fn validate_component(component: &str) -> Result<(), FsError> {
    if component.is_empty() {
        return Err(FsError::new("INVALID_DECISION", "empty path component"));
    }
    if component.contains('/') {
        return Err(FsError::new(
            "INVALID_DECISION",
            "path component contains '/'",
        ));
    }
    if component == "." || component == ".." {
        return Err(FsError::new(
            "INVALID_DECISION",
            "dot and dot-dot components are refused",
        ));
    }
    if component.contains('\0') {
        return Err(FsError::new("INVALID_DECISION", "path component contains NUL"));
    }
    Ok(())
}

fn openat2_errno(dirfd: RawFd, component: &str, oflags: i32) -> Result<File, i32> {
    let path = CString::new(component).map_err(|_| -1i32)?;
    let how = OpenHow {
        flags: oflags as u64,
        mode: 0,
        resolve: RESOLVE_FLAGS,
    };
    let rc = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            dirfd,
            path.as_ptr(),
            &how as *const OpenHow,
            std::mem::size_of::<OpenHow>(),
        )
    };
    if rc == -1 {
        return Err(unsafe { *libc::__errno_location() });
    }
    Ok(unsafe { File::from_raw_fd(rc as RawFd) })
}

fn openat2_raw(dirfd: RawFd, component: &str, oflags: i32) -> Result<File, FsError> {
    openat2_errno(dirfd, component, oflags).map_err(|errno| map_errno("openat2", errno))
}

fn renameat2_noreplace(
    old_dirfd: RawFd,
    old_name: &str,
    new_dirfd: RawFd,
    new_name: &str,
) -> Result<(), FsError> {
    let old_path = CString::new(old_name)
        .map_err(|_| FsError::new("INVALID_DECISION", "source name contains NUL"))?;
    let new_path = CString::new(new_name)
        .map_err(|_| FsError::new("INVALID_DECISION", "target name contains NUL"))?;
    let rc = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            old_dirfd,
            old_path.as_ptr(),
            new_dirfd,
            new_path.as_ptr(),
            RENAME_NOREPLACE,
        )
    };
    if rc == -1 {
        return Err(map_errno("renameat2", unsafe { *libc::__errno_location() }));
    }
    Ok(())
}

/// Opens the configured root once, refusing symlinks and verifying the
/// recorded device/inode identity.
pub fn open_root(config: &RootConfigJson) -> Result<RootHandle, FsError> {
    let path = Path::new(&config.absolute_path);
    let bytes = path.as_os_str().as_bytes();
    let cstring = CString::new(bytes)
        .map_err(|_| FsError::new("INVALID_DECISION", "root path contains NUL"))?;
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    // O_NOFOLLOW: a symlinked root is a replaced root, never followed.
    let rc = unsafe {
        libc::open(
            cstring.as_ptr(),
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
        )
    };
    if rc == -1 {
        return Err(map_errno("open root", unsafe { *libc::__errno_location() }));
    }
    let file = unsafe { File::from_raw_fd(rc as RawFd) };
    let fd = file.as_raw_fd();
    let rc = unsafe { libc::fstat(fd, &mut stat) };
    if rc == -1 {
        return Err(map_errno("fstat root", unsafe { *libc::__errno_location() }));
    }
    if !is_directory(&stat) {
        return Err(FsError::new(
            "OUT_OF_SCOPE",
            "the resolved root is not a directory",
        ));
    }
    if stat.st_dev.to_string() != config.device || stat.st_ino.to_string() != config.inode {
        return Err(FsError::new(
            "OUT_OF_SCOPE",
            &format!(
                "root identity mismatch at {}: recorded {}:{}, found {}:{}; refusing to touch a replaced root",
                config.absolute_path, config.device, config.inode, stat.st_dev, stat.st_ino,
            ),
        ));
    }
    Ok(RootHandle {
        fd: file,
        device: stat.st_dev as u64,
        inode: stat.st_ino as u64,
    })
}

fn is_directory(stat: &libc::stat) -> bool {
    (stat.st_mode & libc::S_IFMT) == libc::S_IFDIR
}

fn is_regular(stat: &libc::stat) -> bool {
    (stat.st_mode & libc::S_IFMT) == libc::S_IFREG
}

/// Resolves a directory chain beneath the root. Symlinks are never followed
/// (openat2 RESOLVE_NO_SYMLINKS), nothing may escape the root
/// (RESOLVE_BENEATH), and mount crossings are refused (RESOLVE_NO_XDEV plus
/// an explicit device pin against the root device).
pub fn resolve_dir(root: &RootHandle, segments: &[String]) -> Result<DirHandle, FsError> {
    let duplicated = unsafe { libc::dup(root.fd()) };
    if duplicated == -1 {
        return Err(map_errno("dup root", unsafe { *libc::__errno_location() }));
    }
    let mut current_fd = unsafe { File::from_raw_fd(duplicated) };
    let mut device = root.device;
    let mut inode = root.inode;
    for segment in segments {
        validate_component(segment)?;
        let opened = openat2_raw(current_fd.as_raw_fd(), segment, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)?;
        let stat = fstat_of(opened.as_raw_fd())?;
        if !is_directory(&stat) {
            return Err(FsError::new(
                "OUT_OF_SCOPE",
                &format!("{segment} is not a directory"),
            ));
        }
        if (stat.st_dev as u64) != root.device {
            return Err(FsError::new(
                "CROSS_MOUNT",
                &format!("{segment} is on another device; deferred, no fallback"),
            ));
        }
        device = stat.st_dev as u64;
        inode = stat.st_ino as u64;
        current_fd = opened;
    }
    Ok(DirHandle {
        fd: current_fd,
        device,
        inode,
    })
}

/// Resolves a regular file beneath the root (last segment opened without
/// O_DIRECTORY, still anchored).
pub fn resolve_file(root: &RootHandle, segments: &[String]) -> Result<FileHandle, FsError> {
    if segments.is_empty() {
        return Err(FsError::new("INVALID_DECISION", "empty file path"));
    }
    let (parent, name) = segments.split_at(segments.len() - 1);
    let dir = resolve_dir(root, parent)?;
    validate_component(&name[0])?;
    let opened = openat2_raw(dir.fd(), &name[0], O_RDONLY | O_NOFOLLOW | O_CLOEXEC)?;
    let stat = fstat_of(opened.as_raw_fd())?;
    if !is_regular(&stat) {
        return Err(FsError::new(
            "OUT_OF_SCOPE",
            &format!("{} is not a regular file", name[0]),
        ));
    }
    Ok(FileHandle {
        file: opened,
        device: stat.st_dev as u64,
        inode: stat.st_ino as u64,
        size: stat.st_size as u64,
    })
}

/// fsyncs a directory descriptor (metadata durability after a rename).
pub fn fsync_dir(dir: &DirHandle) -> Result<(), FsError> {
    dir.fd
        .sync_all()
        .map_err(|error| FsError::new("UNSUPPORTED", &format!("directory fsync failed: {error}")))
}

/// Renames one basename within a directory pair without overwriting.
pub fn rename_noreplace(
    old_dir: &DirHandle,
    old_name: &str,
    new_dir: &DirHandle,
    new_name: &str,
) -> Result<(), FsError> {
    renameat2_noreplace(old_dir.fd(), old_name, new_dir.fd(), new_name)
}

/// Creates one directory segment beneath a parent descriptor with mode 0700.
/// An existing directory is resolved and validated, never chmodded.
pub fn mkdirat_exclusive(
    parent: &DirHandle,
    segment: &str,
) -> Result<DirHandle, FsError> {
    validate_component(segment)?;
    let cstring = CString::new(segment)
        .map_err(|_| FsError::new("INVALID_DECISION", "segment contains NUL"))?;
    let rc = unsafe { libc::mkdirat(parent.fd(), cstring.as_ptr(), 0o700) };
    if rc == -1 {
        let errno = unsafe { *libc::__errno_location() };
        if errno == libc::EEXIST {
            // Reuse: resolve and validate what is already there.
            let opened = openat2_raw(parent.fd(), segment, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)?;
            let stat = fstat_of(opened.as_raw_fd())?;
            if !is_directory(&stat) {
                return Err(FsError::new(
                    "COLLISION",
                    &format!("{segment} exists but is not a directory"),
                ));
            }
            return Ok(DirHandle {
                fd: opened,
                device: stat.st_dev as u64,
                inode: stat.st_ino as u64,
            });
        }
        return Err(map_errno("mkdirat", errno));
    }
    // The new directory entry must be durable before anything is journalled
    // inside it (spec review R10): a crash may not lose the creation.
    let fsync_rc = unsafe { libc::fsync(parent.fd()) };
    if fsync_rc == -1 {
        let errno = unsafe { *libc::__errno_location() };
        return Err(map_errno("fsync", errno));
    }
    let opened = openat2_raw(parent.fd(), segment, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)?;
    let stat = fstat_of(opened.as_raw_fd())?;
    Ok(DirHandle {
        fd: opened,
        device: stat.st_dev as u64,
        inode: stat.st_ino as u64,
    })
}

/// Name of the application-owned probe directory inside the root. The probe
/// only ever creates, inspects and removes names inside this directory; a
/// collision with user data aborts the probe instead of touching the data.
const PROBE_DIR: &str = ".fsops-probe";
const PROBE_SRC: &str = "probe-src";
const PROBE_DST: &str = "probe-dst";

/// Verifies the mandatory primitives. `renameat2_noreplace` is proven with a
/// real no-overwrite fixture inside an application-owned directory, never by
/// renaming a name the application does not own.
pub fn probe_kernel(root: &RootHandle) -> KernelCaps {
    let openat2 = match openat2_errno(root.fd(), ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) {
        Ok(_) => true,
        Err(errno) => errno != libc::ENOSYS,
    };
    KernelCaps {
        openat2,
        renameat2_noreplace: probe_rename_noreplace(root),
    }
}

enum ProbeOutcome {
    /// The flag blocked an overwriting rename of an existing target.
    Enforced,
    /// The primitive ran but did not enforce no-overwrite: apply stays off.
    NotEnforced,
    /// The probe could not run (blocked, unsupported syscall/filesystem).
    Unavailable,
}

/// Creates two probe files the application owns and requires an overwriting
/// rename of one onto the other to fail with EEXIST. rc == 0 would mean an
/// overwrite succeeded, so the flag is not enforced and apply must be
/// disabled — there is deliberately no fallback to an ordinary rename.
fn probe_rename_noreplace(root: &RootHandle) -> bool {
    match probe_fixture(root) {
        ProbeOutcome::Enforced => true,
        ProbeOutcome::NotEnforced | ProbeOutcome::Unavailable => false,
    }
}

fn probe_fixture(root: &RootHandle) -> ProbeOutcome {
    let probe_dir = match open_probe_dir(root) {
        Some(dir) => dir,
        None => return ProbeOutcome::Unavailable,
    };
    if !create_probe_file(&probe_dir, PROBE_SRC) || !create_probe_file(&probe_dir, PROBE_DST) {
        remove_probe_fixture(root, &probe_dir);
        return ProbeOutcome::Unavailable;
    }

    let outcome = {
        let src = CString::new(PROBE_SRC).unwrap();
        let dst = CString::new(PROBE_DST).unwrap();
        let rc = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                probe_dir.as_raw_fd(),
                src.as_ptr(),
                probe_dir.as_raw_fd(),
                dst.as_ptr(),
                RENAME_NOREPLACE,
            )
        };
        if rc == -1 {
            let errno = unsafe { *libc::__errno_location() };
            match errno {
                libc::EEXIST => ProbeOutcome::Enforced,
                libc::ENOSYS | libc::EINVAL | libc::EOPNOTSUPP => {
                    ProbeOutcome::NotEnforced
                }
                _ => ProbeOutcome::Unavailable,
            }
        } else {
            // An overwriting rename succeeded: the flag is not enforced.
            ProbeOutcome::NotEnforced
        }
    };
    remove_probe_fixture(root, &probe_dir);
    outcome
}

/// Opens (creating when absent) the application-owned probe directory. A
/// non-directory at that name is user data: never replaced, never removed.
fn open_probe_dir(root: &RootHandle) -> Option<File> {
    match openat2_errno(root.fd(), PROBE_DIR, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) {
        Ok(dir) => return Some(dir),
        Err(libc::ENOENT) => {}
        Err(_) => return None,
    }
    let name = CString::new(PROBE_DIR).unwrap();
    let rc = unsafe { libc::mkdirat(root.fd(), name.as_ptr(), 0o700) };
    if rc == -1 {
        let errno = unsafe { *libc::__errno_location() };
        if errno != libc::EEXIST {
            return None;
        }
    }
    openat2_errno(root.fd(), PROBE_DIR, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC).ok()
}

/// Creates an exclusively-owned probe file; an existing regular file from a
/// crashed earlier probe is reused, anything else aborts the probe.
fn create_probe_file(dir: &File, name: &str) -> bool {
    match openat2_errno(
        dir.as_raw_fd(),
        name,
        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
    ) {
        Ok(_) => true,
        Err(libc::EEXIST) => match openat2_errno(dir.as_raw_fd(), name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC) {
            Ok(existing) => match fstat_of(existing.as_raw_fd()) {
                Ok(stat) => is_regular(&stat),
                Err(_) => false,
            },
            Err(_) => false,
        },
        Err(_) => false,
    }
}

/// Removes only the probe files this function created and the probe directory
/// when it is empty. Unknown names are never deleted; failures are ignored
/// because a leftover probe directory is harmless and blocks no operation.
fn remove_probe_fixture(root: &RootHandle, dir: &File) {
    for name in [PROBE_SRC, PROBE_DST] {
        let c_name = CString::new(name).unwrap();
        unsafe { libc::unlinkat(dir.as_raw_fd(), c_name.as_ptr(), 0) };
    }
    let c_dir = CString::new(PROBE_DIR).unwrap();
    unsafe { libc::unlinkat(root.fd(), c_dir.as_ptr(), libc::AT_REMOVEDIR) };
}

/// Kernel release string for health reports.
pub fn kernel_release() -> String {
    let mut uts: libc::utsname = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::uname(&mut uts) };
    if rc == -1 {
        return "unknown".to_string();
    }
    let release = unsafe { std::ffi::CStr::from_ptr(uts.release.as_ptr()) };
    release.to_string_lossy().to_string()
}
