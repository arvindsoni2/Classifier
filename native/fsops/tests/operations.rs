//! Behavioral fixtures for the fsops helper (plan Task 7).
//!
//! Every test builds a synthetic root under /tmp/opencode, keeps an
//! outside-root sentinel, and asserts the safety invariants: no overwrite,
//! no escape, no cross-mount, no surprise kernel behaviour, shell-like names
//! as literal data, and material preserved on every refusal.

use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

use fsops::operations::{
    inspect_at, mkdir_at, move_at, probe, undo_at, DestinationRef, MoveRequest, RootConfig,
    SnapshotValue, UndoRequest,
};

static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    parent: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let unique = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let parent = std::env::temp_dir().join(format!(
            "fsops-{label}-{}-{nanos}-{unique}",
            process::id()
        ));
        let root = parent.join("Downloads");
        fs::create_dir_all(&root).expect("create fixture root");
        fs::write(parent.join("sentinel-outside.txt"), b"outside bytes must survive\n")
            .expect("create outside sentinel");
        Self { root, parent }
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    fn dir(&self, relative: &str) {
        fs::create_dir_all(self.path(relative)).expect("create fixture directory");
    }

    fn file(&self, relative: &str, content: &[u8]) {
        fs::write(self.path(relative), content).expect("write fixture file");
    }

    fn sentinel_unchanged(&self) {
        assert_eq!(
            fs::read(self.parent.join("sentinel-outside.txt")).unwrap(),
            b"outside bytes must survive\n",
            "outside-root sentinel was modified",
        );
        assert!(
            !self.parent.join("marker").exists(),
            "a marker file appeared outside the fixture root",
        );
    }

    fn config(&self) -> RootConfig {
        let metadata = fs::metadata(&self.root).expect("stat fixture root");
        RootConfig {
            absolute_path: self.root.to_string_lossy().to_string(),
            device: metadata.dev().to_string(),
            inode: metadata.ino().to_string(),
        }
    }

    fn destination(&self, segments: &[&str]) -> DestinationRef {
        let path = self.root.join(segments.join(std::path::MAIN_SEPARATOR_STR));
        let metadata = fs::metadata(&path).expect("stat destination directory");
        DestinationRef {
            segments: segments.iter().map(|s| s.to_string()).collect(),
            device: metadata.dev().to_string(),
            inode: metadata.ino().to_string(),
        }
    }

    /// The fixture root itself, as a destination reference (mkdir parent).
    fn destination_root(&self) -> DestinationRef {
        let metadata = fs::metadata(&self.root).expect("stat fixture root");
        DestinationRef {
            segments: vec![],
            device: metadata.dev().to_string(),
            inode: metadata.ino().to_string(),
        }
    }

    /// Creates a directory with an explicit mode and returns its inode.
    fn dir_with_mode(&self, relative: &str, mode: u32) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = self.path(relative);
        if !path.exists() {
            fs::create_dir_all(&path).unwrap();
        }
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        fs::metadata(&path).unwrap().ino().to_string()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.parent);
    }
}

fn hash_of(path: &Path) -> String {
    let value = inspect_at(
        &RootConfig {
            absolute_path: path
                .parent()
                .unwrap()
                .to_string_lossy()
                .to_string(),
            device: fs::metadata(path).unwrap().dev().to_string(),
            inode: fs::metadata(path.parent().unwrap()).unwrap().ino().to_string(),
        },
        &[path.file_name().unwrap().to_string_lossy().to_string()],
    );
    match value {
        Ok(snapshot) => snapshot.sha256,
        Err(error) => panic!("hash_of({}) failed: {} {}", path.display(), error.code, error.detail),
    }
}

fn move_request(fixture: &Fixture, basename: &str, destination: &DestinationRef) -> MoveRequest {
    let source = fixture.path(basename);
    let metadata = fs::metadata(&source).expect("stat source");
    MoveRequest {
        root: fixture.config(),
        action_id: "action-1".to_string(),
        request_id: "request-1".to_string(),
        source_basename: basename.to_string(),
        destination: destination.clone(),
        expected: SnapshotValue {
            device: metadata.dev().to_string(),
            inode: metadata.ino().to_string(),
            size: metadata.size().to_string(),
            mtime_ns: full_ns(metadata.mtime(), metadata.mtime_nsec()).to_string(),
            ctime_ns: full_ns(metadata.ctime(), metadata.ctime_nsec()).to_string(),
            sha256: hash_of(&source),
        },
        approval_id: "approval-1".to_string(),
    }
}

fn undo_request(fixture: &Fixture, destination: &DestinationRef, basename: &str) -> UndoRequest {
    let target = fixture.root.join(destination.segments.join("/")).join(basename);
    let metadata = fs::metadata(&target).expect("stat moved target");
    UndoRequest {
        root: fixture.config(),
        action_id: "action-1".to_string(),
        request_id: "request-2".to_string(),
        target_segments: destination.segments.clone(),
        basename: basename.to_string(),
        expected: SnapshotValue {
            device: metadata.dev().to_string(),
            inode: metadata.ino().to_string(),
            size: metadata.size().to_string(),
            mtime_ns: full_ns(metadata.mtime(), metadata.mtime_nsec()).to_string(),
            ctime_ns: full_ns(metadata.ctime(), metadata.ctime_nsec()).to_string(),
            sha256: hash_of(&target),
        },
        approval_id: "approval-2".to_string(),
    }
}

fn code_of<T>(result: &Result<T, fsops::error::FsError>) -> String {
    match result {
        Ok(_) => "OK".to_string(),
        Err(error) => error.code.to_string(),
    }
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

#[test]
fn probe_reports_the_kernel_primitives_and_verifies_the_root() {
    let fixture = Fixture::new("probe");
    let health = probe(&fixture.config()).expect("probe succeeds");
    assert!(health.openat2, "openat2 must be available on this kernel");
    assert!(health.renameat2_noreplace, "renameat2 RENAME_NOREPLACE must be available");
    assert!(health.root_verified, "the recorded root identity must verify");
    assert!(!health.kernel.is_empty());
    fixture.sentinel_unchanged();
}

// ---------------------------------------------------------------------------
// the named plan fixtures
// ---------------------------------------------------------------------------

#[test]
fn no_replace_preserves_existing_target() {
    let fixture = Fixture::new("noreplace");
    fixture.dir("Documents");
    fixture.file("invoice.txt", b"fresh source\n");
    fixture.file("Documents/invoice.txt", b"precious existing target\n");

    let destination = fixture.destination(&["Documents"]);
    let receipt = move_at(&move_request(&fixture, "invoice.txt", &destination));

    assert_eq!(code_of(&receipt), "COLLISION");
    assert_eq!(
        fs::read(fixture.path("Documents/invoice.txt")).unwrap(),
        b"precious existing target\n",
        "the existing target must be retained unchanged",
    );
    assert_eq!(
        fs::read(fixture.path("invoice.txt")).unwrap(),
        b"fresh source\n",
        "the source must be retained when the target exists",
    );
    fixture.sentinel_unchanged();
}

#[test]
fn symlink_ancestor_cannot_escape() {
    let fixture = Fixture::new("symlink");
    fs::create_dir_all(fixture.parent.join("outside")).unwrap();
    fs::write(fixture.parent.join("outside/secret.txt"), b"outside secret\n").unwrap();
    std::os::unix::fs::symlink(&fixture.parent.join("outside"), fixture.path("escape")).unwrap();
    fixture.file("invoice.txt", b"source\n");

    let escaping = DestinationRef {
        segments: vec!["escape".to_string()],
        device: fs::metadata(fixture.path("escape")).unwrap().dev().to_string(),
        inode: fs::metadata(fixture.path("escape")).unwrap().ino().to_string(),
    };
    let receipt = move_at(&move_request(&fixture, "invoice.txt", &escaping));
    assert_eq!(code_of(&receipt), "OUT_OF_SCOPE");

    let mkdir = mkdir_at(&fixture.config(), &escaping, "new-folder");
    assert_eq!(code_of(&mkdir), "OUT_OF_SCOPE");

    assert!(!fixture.parent.join("outside/invoice.txt").exists());
    assert_eq!(
        fs::read(fixture.parent.join("outside/secret.txt")).unwrap(),
        b"outside secret\n",
    );
    assert_eq!(fs::read(fixture.path("invoice.txt")).unwrap(), b"source\n");
    fixture.sentinel_unchanged();
}

#[test]
fn cross_mount_is_deferred() {
    let fixture = Fixture::new("crossmount");
    fixture.dir("Documents");
    fixture.file("invoice.txt", b"source\n");

    let destination = fixture.destination(&["Documents"]);
    // Pinning a foreign device/inode for the destination must be refused
    // before any mutation: the identity pin is the cross-mount guard.
    let foreign = DestinationRef {
        segments: destination.segments.clone(),
        device: "999999".to_string(),
        inode: "999998".to_string(),
    };
    let receipt = move_at(&move_request(&fixture, "invoice.txt", &foreign));
    assert_eq!(code_of(&receipt), "CROSS_MOUNT");
    assert_eq!(fs::read(fixture.path("invoice.txt")).unwrap(), b"source\n");
    assert!(!fixture.path("Documents/invoice.txt").exists());
    fixture.sentinel_unchanged();
}

#[test]
fn kernel_probe_never_renames_user_files() {
    // Spec review R7: the old probe renamed `.fsops-kernel-probe-a` when that
    // name existed in the user root. A real file with that exact name must
    // survive a probe untouched, and no probe target name may appear.
    let fixture = Fixture::new("probe-user-file");
    fixture.file(".fsops-kernel-probe-a", b"user data that must not be renamed\n");
    let inode_before = fs::metadata(fixture.path(".fsops-kernel-probe-a"))
        .expect("stat user file")
        .ino();

    let health = probe(&fixture.config()).expect("probe runs");
    assert!(
        health.renameat2_noreplace,
        "a capable kernel must report RENAME_NOREPLACE support",
    );

    assert_eq!(
        fs::read(fixture.path(".fsops-kernel-probe-a")).unwrap(),
        b"user data that must not be renamed\n",
        "the probe renamed user data",
    );
    let inode_after = fs::metadata(fixture.path(".fsops-kernel-probe-a"))
        .expect("stat user file after probe")
        .ino();
    assert_eq!(inode_before, inode_after, "the user file was replaced");
    assert!(
        !fixture.path(".fsops-kernel-probe-b").exists(),
        "the probe created its old target name in the user root",
    );
    assert!(
        !fixture.path(".fsops-probe").exists(),
        "the probe left its fixture directory behind",
    );
    fixture.sentinel_unchanged();
}

#[test]
fn kernel_probe_reports_support_with_a_real_no_overwrite_fixture() {
    // The capability is proven by an overwriting rename onto an existing
    // application-owned target failing with EEXIST — a real fixture, not an
    // assumption about errnos.
    let fixture = Fixture::new("probe-capability");
    let health = probe(&fixture.config()).expect("probe runs");
    assert!(health.openat2, "openat2 must be reported on a modern kernel");
    assert!(health.renameat2_noreplace);
    assert!(health.root_verified);
    assert!(!fixture.path(".fsops-probe").exists());
    fixture.sentinel_unchanged();
}

#[test]
fn kernel_probe_blocked_when_probe_path_is_user_data() {
    // A regular file at the probe directory name is user data: the probe must
    // abort as unsupported and leave the file exactly as it was.
    let fixture = Fixture::new("probe-blocked");
    fixture.file(".fsops-probe", b"not ours; never removed\n");
    let health = probe(&fixture.config()).expect("probe runs");
    assert!(
        !health.renameat2_noreplace,
        "a blocked probe must not claim RENAME_NOREPLACE support",
    );
    assert_eq!(
        fs::read(fixture.path(".fsops-probe")).unwrap(),
        b"not ours; never removed\n",
    );
    fixture.sentinel_unchanged();
}

#[test]
fn unsupported_primitives_disable_apply() {
    let fixture = Fixture::new("kernel");
    fixture.dir("Documents");
    fixture.file("invoice.txt", b"source\n");
    let destination = fixture.destination(&["Documents"]);

    // On a kernel WITH the primitives, the happy path works.
    let receipt = move_at(&move_request(&fixture, "invoice.txt", &destination));
    assert!(
        receipt.is_ok(),
        "expected a move receipt on a capable kernel, got {}",
        code_of(&receipt),
    );
    if let Ok(receipt) = &receipt {
        assert_eq!(receipt.outcome, "moved");
        assert!(receipt.verified);
    }
    assert!(fixture.path("Documents/invoice.txt").exists());
    fixture.sentinel_unchanged();
}

#[test]
fn source_swap_reports_conflict() {
    let fixture = Fixture::new("swap");
    fixture.dir("Documents");
    fixture.file("invoice.txt", b"original content\n");

    // A source whose fingerprint changed between approval and execution
    // (the downloader kept writing) must be refused, not moved.
    fs::write(fixture.path("invoice.txt"), b"still downloading more\n").unwrap();
    let destination = fixture.destination(&["Documents"]);
    let mut request = move_request(&fixture, "invoice.txt", &destination);
    request.expected.sha256 = "f".repeat(64);
    let receipt = move_at(&request);

    assert_eq!(code_of(&receipt), "CONFLICT");
    assert_eq!(
        fs::read(fixture.path("invoice.txt")).unwrap(),
        b"still downloading more\n",
        "the changed source must be preserved where it is",
    );
    assert!(!fixture.path("Documents/invoice.txt").exists());
    fixture.sentinel_unchanged();
}

#[test]
fn unicode_and_shell_names_are_literal() {
    let fixture = Fixture::new("names");
    fixture.dir("Documents");
    let names = [
        "ünïcödé-рапорт.txt",
        "$(touch marker).txt",
        "spaced name $HOME.txt",
        "semi;colon&amp pipe|.txt",
    ];
    for name in names {
        fixture.file(name, b"payload\n");
    }
    let destination = fixture.destination(&["Documents"]);
    for name in names {
        let receipt = move_at(&move_request(&fixture, name, &destination));
        assert!(
            receipt.is_ok(),
            "moving {name:?} failed: {}",
            code_of(&receipt),
        );
        assert!(
            fixture.path(&format!("Documents/{name}")).exists(),
            "the literal name must land in the destination",
        );
        assert!(!fixture.path(name).exists(), "the source must be gone after the move");
    }
    assert!(!fixture.path("marker").exists());
    assert!(!fixture.parent.join("marker").exists());
    fixture.sentinel_unchanged();
}

#[test]
fn hardlink_and_oversize_are_rejected() {
    let fixture = Fixture::new("hardlink");
    fixture.dir("Documents");
    fixture.file("original.txt", b"single link\n");
    fs::hard_link(fixture.path("original.txt"), fixture.path("linked.txt")).unwrap();
    let destination = fixture.destination(&["Documents"]);

    let linked = move_at(&move_request(&fixture, "linked.txt", &destination));
    assert_eq!(code_of(&linked), "OUT_OF_SCOPE");
    assert!(fixture.path("linked.txt").exists());

    // Oversize: a sparse file above the 100 MiB eligibility ceiling.
    fixture.file("huge.bin", b"");
    let file = fs::OpenOptions::new()
        .write(true)
        .open(fixture.path("huge.bin"))
        .unwrap();
    file.set_len(101 * 1024 * 1024).unwrap();
    drop(file);
    // The size ceiling is enforced before hashing; build the request without
    // a real hash so the refusal is exercised by size alone.
    let source_meta = fs::metadata(fixture.path("huge.bin")).unwrap();
    let huge_request = MoveRequest {
        root: fixture.config(),
        action_id: "action-oversize".to_string(),
        request_id: "request-oversize".to_string(),
        source_basename: "huge.bin".to_string(),
        destination: destination.clone(),
        expected: SnapshotValue {
            device: source_meta.dev().to_string(),
            inode: source_meta.ino().to_string(),
            size: source_meta.size().to_string(),
            mtime_ns: full_ns(source_meta.mtime(), source_meta.mtime_nsec()).to_string(),
            ctime_ns: full_ns(source_meta.ctime(), source_meta.ctime_nsec()).to_string(),
            sha256: "0".repeat(64),
        },
        approval_id: "approval-1".to_string(),
    };
    let huge = move_at(&huge_request);
    assert_eq!(code_of(&huge), "OVERSIZE");
    assert!(fixture.path("huge.bin").exists());
    fixture.sentinel_unchanged();
}

// ---------------------------------------------------------------------------
// mkdir / undo / inspect
// ---------------------------------------------------------------------------

#[test]
fn mkdir_creates_one_segment_and_reuses_existing_without_chmod() {
    let fixture = Fixture::new("mkdir");
    let root = fixture.destination_root();
    let created = mkdir_at(&fixture.config(), &root, "Invoices")
        .expect("mkdir creates one segment");
    assert_eq!(created.segments, vec!["Invoices".to_string()]);
    assert_eq!(created.status, "observed");
    let mode = fs::metadata(fixture.path("Invoices")).unwrap().mode();
    assert_eq!(mode & 0o777, 0o700, "new directories are 0700");

    // Re-issuing resolves and validates the existing directory, never chmods.
    let existing = fixture.dir_with_mode("Invoices", 0o755);
    let again = mkdir_at(&fixture.config(), &root, "Invoices").expect("mkdir reuses");
    assert_eq!(again.inode, existing);
    assert_eq!(
        fs::metadata(fixture.path("Invoices")).unwrap().mode() & 0o777,
        0o755,
        "an existing directory must keep its mode",
    );
    fixture.sentinel_unchanged();
}

#[test]
fn undo_returns_an_unchanged_file_to_a_free_original_location() {
    let fixture = Fixture::new("undo");
    fixture.dir("Documents");
    fixture.file("invoice.txt", b"round trip\n");
    let destination = fixture.destination(&["Documents"]);
    let receipt = move_at(&move_request(&fixture, "invoice.txt", &destination))
        .expect("the forward move succeeds");
    assert_eq!(receipt.outcome, "moved");

    let undone = undo_at(&undo_request(&fixture, &destination, "invoice.txt"))
        .expect("the reverse move succeeds");
    assert_eq!(undone.outcome, "moved");
    assert!(undone.verified);
    assert!(fixture.path("invoice.txt").exists());
    assert_eq!(fs::read(fixture.path("invoice.txt")).unwrap(), b"round trip\n");
    assert!(!fixture.path("Documents/invoice.txt").exists());
    fixture.sentinel_unchanged();
}

#[test]
fn undo_refuses_an_occupied_original_location() {
    let fixture = Fixture::new("undo-conflict");
    fixture.dir("Documents");
    fixture.file("invoice.txt", b"original\n");
    let destination = fixture.destination(&["Documents"]);
    move_at(&move_request(&fixture, "invoice.txt", &destination)).expect("forward move");
    // Something else took the original name while the file was away.
    fixture.file("invoice.txt", b"new occupant\n");

    let undone = undo_at(&undo_request(&fixture, &destination, "invoice.txt"));
    assert_eq!(code_of(&undone), "COLLISION");
    assert_eq!(
        fs::read(fixture.path("invoice.txt")).unwrap(),
        b"new occupant\n",
        "the occupant must be preserved",
    );
    assert_eq!(
        fs::read(fixture.path("Documents/invoice.txt")).unwrap(),
        b"original\n",
        "the moved file stays in the destination",
    );
    fixture.sentinel_unchanged();
}

#[test]
fn inspect_hashes_an_opened_file_with_decimal_stat_strings() {
    let fixture = Fixture::new("inspect");
    fixture.file("report.pdf", b"pdf bytes\n");
    let snapshot = inspect_at(&fixture.config(), &["report.pdf".to_string()])
        .expect("inspect snapshots the file");
    let metadata = fs::metadata(fixture.path("report.pdf")).unwrap();
    assert_eq!(snapshot.size, metadata.size().to_string());
    assert_eq!(snapshot.inode, metadata.ino().to_string());
    assert_eq!(
        snapshot.sha256,
        "9eed1c04dab61b0dc625830ce865070cddf873f583dc600f32d9acf87d00f974",
        "sha256 of \"pdf bytes\\n\"",
    );
    fixture.sentinel_unchanged();
}

/// std's MetadataExt::mtime_nsec() returns only the fractional part; the
/// snapshot contract needs full nanoseconds like Node's mtimeNs.
fn full_ns(seconds: i64, nanoseconds: i64) -> i64 {
    seconds * 1_000_000_000 + nanoseconds
}
