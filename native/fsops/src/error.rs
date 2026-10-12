//! Error vocabulary for the helper.

#[derive(Debug, Clone)]
pub struct FsError {
    pub code: &'static str,
    pub detail: String,
}

impl FsError {
    pub fn new(code: &'static str, detail: &str) -> Self {
        Self {
            code,
            detail: detail.to_string(),
        }
    }
}

/// Maps a raw errno to the helper's error vocabulary. ENOSYS on either
/// mandatory primitive disables apply (UNSUPPORTED_KERNEL); EXDEV is a
/// deferred cross-mount, never a fallback; EEXIST is a collision that
/// retains the existing target.
pub fn map_errno(operation: &str, errno: i32) -> FsError {
    let detail = format!("{operation} failed (errno {errno})");
    match errno {
        libc::ENOSYS => FsError::new(
            "UNSUPPORTED_KERNEL",
            &format!("{operation} is not supported by this kernel; apply stays disabled"),
        ),
        libc::EPERM | libc::EACCES => FsError::new("UNAUTHORISED", &detail),
        libc::EINVAL => FsError::new("INVALID_DECISION", &detail),
        libc::ENOENT => FsError::new("NOT_FOUND", &format!("{operation}: no such file or directory")),
        libc::ELOOP | libc::ENOTDIR => FsError::new(
            "OUT_OF_SCOPE",
            &format!("{operation} refused: the path is not a plain file inside the root (symlink or type error)"),
        ),
        libc::EXDEV => FsError::new(
            "CROSS_MOUNT",
            &format!("{operation} would cross a mount boundary; deferred, no fallback"),
        ),
        libc::EEXIST => FsError::new(
            "COLLISION",
            &format!("{operation} target already exists; retained unchanged"),
        ),
        _ => FsError::new("UNSUPPORTED", &detail),
    }
}

/// Last errno when a syscall returned -1.
pub fn last_errno() -> i32 {
    unsafe { *libc::__errno_location() }
}
