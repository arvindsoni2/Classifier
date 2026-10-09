//! Filesystem verbs: probe, inspect, mkdir, move, undo (plan Task 7).
//!
//! Every verb re-opens the root from its configured path, verifies the
//! recorded identity, resolves beneath it with openat2
//! (RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV) and performs
//! exactly one kernel effect: renameat2 with RENAME_NOREPLACE or mkdirat
//! with mode 0700. No delete, no shell, no copy/delete fallback, no
//! collision suffix. EEXIST/EXDEV are surfaced as COLLISION/CROSS_MOUNT.

use std::io::Read;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::FsError;
use crate::resolve::{
    fsync_dir, kernel_release, mkdirat_exclusive, open_root, probe_kernel, rename_noreplace,
    resolve_dir, resolve_file, validate_component, DirHandle, RootHandle,
};

/// Candidate eligibility ceiling: 100 MiB (PRD §6).
pub const MAX_MOVE_BYTES: u64 = 100 * 1024 * 1024;
const HASH_CHUNK: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotValue {
    pub device: String,
    pub inode: String,
    pub size: String,
    pub mtime_ns: String,
    pub ctime_ns: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootConfig {
    pub absolute_path: String,
    pub device: String,
    pub inode: String,
}

impl From<&RootConfig> for crate::resolve::RootConfigJson {
    fn from(config: &RootConfig) -> Self {
        crate::resolve::RootConfigJson {
            absolute_path: config.absolute_path.clone(),
            device: config.device.clone(),
            inode: config.inode.clone(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationRef {
    pub segments: Vec<String>,
    pub device: String,
    pub inode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationJson {
    pub id: String,
    pub segments: Vec<String>,
    pub device: String,
    pub inode: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveReceiptJson {
    pub kind: String,
    pub action_id: String,
    pub request_id: String,
    pub outcome: String,
    pub before: SnapshotValue,
    pub after: Option<SnapshotValue>,
    pub created_directory_ids: Vec<String>,
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemHealthJson {
    pub kernel: String,
    pub openat2: bool,
    pub renameat2_noreplace: bool,
    pub root_verified: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveRequest {
    pub root: RootConfig,
    pub action_id: String,
    pub request_id: String,
    pub source_basename: String,
    /// Pinned destination identity from discovery; verified before any
    /// mutation (a foreign pin is a deferred cross-mount).
    pub destination: DestinationRef,
    pub expected: SnapshotValue,
    pub approval_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoRequest {
    pub root: RootConfig,
    pub action_id: String,
    pub request_id: String,
    pub target_segments: Vec<String>,
    pub basename: String,
    pub expected: SnapshotValue,
    pub approval_id: String,
}

fn destination_id(segments: &[String]) -> String {
    let joined = format!("{:?}", segments);
    let hash = Sha256::digest(joined.as_bytes());
    format!("dest-{}", hex(&hash[..20]))
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn hash_file(file: &std::fs::File) -> Result<String, FsError> {
    use std::os::unix::fs::FileExt;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; HASH_CHUNK];
    let mut position: u64 = 0;
    loop {
        // Position-based reads: never consume the shared descriptor cursor,
        // so verifications can run repeatedly on the same handle.
        match file.read_at(&mut buffer, position) {
            Ok(0) => break,
            Ok(read) => {
                hasher.update(&buffer[..read]);
                position += read as u64;
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                return Err(FsError::new(
                    "UNSUPPORTED",
                    &format!("read while hashing failed: {error}"),
                ));
            }
        }
    }
    Ok(hex(&hasher.finalize()))
}

/// Verifies an opened file against the expected snapshot: identity
/// (device/inode/size/mtime) first, then content hash. Any mismatch is a
/// CONFLICT and the material is preserved. ctime is compared only when
/// requested: a rename changes ctime, so post-rename verification uses
/// stable identity/content only (LLD §5).
fn verify_against_expected(
    handle: &crate::resolve::FileHandle,
    expected: &SnapshotValue,
    include_ctime: bool,
) -> Result<(), FsError> {
    if handle.device.to_string() != expected.device
        || handle.inode.to_string() != expected.inode
        || handle.size.to_string() != expected.size
    {
        return Err(FsError::new(
            "CONFLICT",
            "source identity changed since the snapshot was taken",
        ));
    }
    let stat = stat_via_fd(handle.file())?;
    if full_ns(stat.st_mtime, stat.st_mtime_nsec) != expected.mtime_ns
        || (include_ctime && full_ns(stat.st_ctime, stat.st_ctime_nsec) != expected.ctime_ns)
    {
        return Err(FsError::new(
            "CONFLICT",
            "source timestamps changed since the snapshot was taken",
        ));
    }
    let digest = hash_file(handle.file())?;
    if digest != expected.sha256 {
        return Err(FsError::new(
            "CONFLICT",
            "source content hash does not match the expected snapshot",
        ));
    }
    Ok(())
}

fn stat_via_fd(file: &std::fs::File) -> Result<libc::stat, FsError> {
    use std::os::unix::io::AsRawFd;
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::fstat(file.as_raw_fd(), &mut stat) };
    if rc == -1 {
        return Err(FsError::new(
            "UNSUPPORTED",
            &format!("fstat failed (errno {})", unsafe {
                *libc::__errno_location()
            }),
        ));
    }
    Ok(stat)
}

fn snapshot_of(handle: &crate::resolve::FileHandle) -> Result<SnapshotValue, FsError> {
    let stat = stat_via_fd(handle.file())?;
    let sha256 = hash_file(handle.file())?;
    Ok(SnapshotValue {
        device: handle.device.to_string(),
        inode: handle.inode.to_string(),
        size: handle.size.to_string(),
        mtime_ns: full_ns(stat.st_mtime, stat.st_mtime_nsec),
        ctime_ns: full_ns(stat.st_ctime, stat.st_ctime_nsec),
        sha256,
    })
}

/// glibc's st_*time_nsec holds only the fractional part; the contract needs
/// full nanoseconds (seconds * 1e9 + fraction), matching std's mtime_nsec().
fn full_ns(seconds: i64, nanoseconds: i64) -> String {
    (seconds * 1_000_000_000 + nanoseconds).to_string()
}

/// Verifies the mandatory primitives and the recorded root identity.
pub fn probe(root: &RootConfig) -> Result<FilesystemHealthJson, FsError> {
    let root_handle = open_root(&root.into())?;
    let caps = probe_kernel(&root_handle);
    Ok(FilesystemHealthJson {
        kernel: kernel_release(),
        openat2: caps.openat2,
        renameat2_noreplace: caps.renameat2_noreplace,
        root_verified: true,
    })
}

/// Inspects one regular file beneath the root into a snapshot.
pub fn inspect_at(root: &RootConfig, segments: &[String]) -> Result<SnapshotValue, FsError> {
    let root_handle = open_root(&root.into())?;
    let handle = resolve_file(&root_handle, segments)?;
    if handle.size > MAX_MOVE_BYTES {
        return Err(FsError::new(
            "OVERSIZE",
            &format!(
                "file is {} bytes, above the {}-byte eligibility ceiling",
                handle.size, MAX_MOVE_BYTES
            ),
        ));
    }
    snapshot_of(&handle)
}

/// Creates one approved segment beneath the pinned parent directory.
pub fn mkdir_at(
    root: &RootConfig,
    parent: &DestinationRef,
    segment: &str,
) -> Result<DestinationJson, FsError> {
    let root_handle = open_root(&root.into())?;
    let parent_dir = resolve_dir(&root_handle, &parent.segments)?;
    if parent_dir.device.to_string() != parent.device || parent_dir.inode.to_string() != parent.inode {
        return Err(FsError::new(
            "CROSS_MOUNT",
            "the pinned parent directory identity does not match the resolved directory; deferred",
        ));
    }
    let created = mkdirat_exclusive(&parent_dir, segment)?;
    let mut segments = parent.segments.clone();
    segments.push(segment.to_string());
    Ok(DestinationJson {
        id: destination_id(&segments),
        segments,
        device: created.device.to_string(),
        inode: created.inode.to_string(),
        status: "observed".to_string(),
    })
}

/// Resolves and validates the destination directory against its pin.
fn resolve_destination(
    root: &RootHandle,
    destination: &DestinationRef,
) -> Result<DirHandle, FsError> {
    validate_component_segments(&destination.segments)?;
    let dir = resolve_dir(root, &destination.segments)?;
    if dir.device.to_string() != destination.device || dir.inode.to_string() != destination.inode {
        return Err(FsError::new(
            "CROSS_MOUNT",
            "the pinned destination identity does not match the resolved directory; deferred, no fallback",
        ));
    }
    Ok(dir)
}

fn validate_component_segments(segments: &[String]) -> Result<(), FsError> {
    if segments.is_empty() {
        return Err(FsError::new(
            "INVALID_DECISION",
            "a destination requires at least one segment beneath the root",
        ));
    }
    for segment in segments {
        validate_component(segment)?;
    }
    Ok(())
}

/// Executes one approved move: basename-preserving rename into the pinned
/// destination, RENAME_NOREPLACE, with post-rename verification.
pub fn move_at(request: &MoveRequest) -> Result<MoveReceiptJson, FsError> {
    validate_component(&request.source_basename)?;
    let root = open_root(&(&request.root).into())?;
    let destination = resolve_destination(&root, &request.destination)?;

    let source = resolve_file(&root, std::slice::from_ref(&request.source_basename))?;
    if link_count(&source) > 1 {
        return Err(FsError::new(
            "OUT_OF_SCOPE",
            "source has multiple hard links; not an eligible single-link file",
        ));
    }
    if source.size > MAX_MOVE_BYTES {
        return Err(FsError::new(
            "OVERSIZE",
            &format!(
                "source is {} bytes, above the {}-byte move ceiling",
                source.size, MAX_MOVE_BYTES
            ),
        ));
    }
    // Pre-rename verification: identity + content must match the approval.
    verify_against_expected(&source, &request.expected, true)?;

    rename_noreplace(
        &directory_of_root(&root)?,
        &request.source_basename,
        &destination,
        &request.source_basename,
    )?;

    fsync_dir(&directory_of_root(&root)?)?;
    fsync_dir(&destination)?;

    // Post-rename verification: reopen the target safely and re-verify
    // identity and content (ctime legitimately changed with the rename).
    let moved = resolve_file(&root, &nested(&request.destination.segments, &request.source_basename))?;
    if verify_against_expected(&moved, &request.expected, false).is_ok() {
        let after = snapshot_of(&moved)?;
        Ok(MoveReceiptJson {
            kind: "move_file".to_string(),
            action_id: request.action_id.clone(),
            request_id: request.request_id.clone(),
            outcome: "moved".to_string(),
            before: request.expected.clone(),
            after: Some(after),
            created_directory_ids: vec![],
            verified: true,
        })
    } else {
        // The rename happened but the target is not what was approved.
        // Never delete, never report success: record the actual state.
        let after = snapshot_of(&moved).ok();
        Ok(MoveReceiptJson {
            kind: "move_file".to_string(),
            action_id: request.action_id.clone(),
            request_id: request.request_id.clone(),
            outcome: "conflict".to_string(),
            before: request.expected.clone(),
            after,
            created_directory_ids: vec![],
            verified: false,
        })
    }
}

/// Executes one approved undo: the inverse move back into the root with the
/// same basename, RENAME_NOREPLACE (an occupied original is a COLLISION).
pub fn undo_at(request: &UndoRequest) -> Result<MoveReceiptJson, FsError> {
    validate_component(&request.basename)?;
    let root = open_root(&(&request.root).into())?;
    validate_component_segments(&request.target_segments)?;
    let target_dir = resolve_dir(&root, &request.target_segments)?;

    let moved = resolve_file(&root, &nested(&request.target_segments, &request.basename))?;
    if link_count(&moved) > 1 {
        return Err(FsError::new(
            "OUT_OF_SCOPE",
            "target has multiple hard links; not an eligible single-link file",
        ));
    }
    if moved.size > MAX_MOVE_BYTES {
        return Err(FsError::new(
            "OVERSIZE",
            &format!(
                "target is {} bytes, above the {}-byte move ceiling",
                moved.size, MAX_MOVE_BYTES
            ),
        ));
    }
    verify_against_expected(&moved, &request.expected, true)?;

    rename_noreplace(
        &target_dir,
        &request.basename,
        &directory_of_root(&root)?,
        &request.basename,
    )?;

    fsync_dir(&target_dir)?;
    fsync_dir(&directory_of_root(&root)?)?;

    let restored = resolve_file(&root, std::slice::from_ref(&request.basename))?;
    if verify_against_expected(&restored, &request.expected, false).is_ok() {
        let after = snapshot_of(&restored)?;
        Ok(MoveReceiptJson {
            kind: "move_file".to_string(),
            action_id: request.action_id.clone(),
            request_id: request.request_id.clone(),
            outcome: "moved".to_string(),
            before: request.expected.clone(),
            after: Some(after),
            created_directory_ids: vec![],
            verified: true,
        })
    } else {
        let after = snapshot_of(&restored).ok();
        Ok(MoveReceiptJson {
            kind: "move_file".to_string(),
            action_id: request.action_id.clone(),
            request_id: request.request_id.clone(),
            outcome: "conflict".to_string(),
            before: request.expected.clone(),
            after,
            created_directory_ids: vec![],
            verified: false,
        })
    }
}

fn nested(segments: &[String], name: &str) -> Vec<String> {
    let mut path = segments.to_vec();
    path.push(name.to_string());
    path
}

/// The root as a DirHandle (rename source/destination anchor).
fn directory_of_root(root: &RootHandle) -> Result<DirHandle, FsError> {
    resolve_dir(root, &[])
}

fn link_count(handle: &crate::resolve::FileHandle) -> u64 {
    stat_via_fd(handle.file()).map(|stat| stat.st_nlink as u64).unwrap_or(0)
}
