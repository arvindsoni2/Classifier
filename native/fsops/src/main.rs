//! fsops: one JSON request per invocation (max 64 KiB), one JSON result.
//!
//! Verbs: probe, inspect, mkdir, move, undo. No shell, no arbitrary
//! executable, no delete verb. Kernel anchored resolution (openat2
//! RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV) and
//! RENAME_NOREPLACE are mandatory; when missing the helper answers
//! UNSUPPORTED_KERNEL and apply stays disabled.

mod error;
mod resolve;

use std::io::Read;

use fsops::error::FsError;
use fsops::operations::{
    inspect_at, mkdir_at, move_at, probe, undo_at, DestinationRef, MoveRequest, RootConfig,
    UndoRequest,
};
use fsops::resolve::RootConfigJson;

const MAX_REQUEST_BYTES: usize = 64 * 1024;

fn print_response(value: serde_json::Value) {
    println!("{value}");
}

fn print_error(error: &FsError) {
    print_response(serde_json::json!({
        "ok": false,
        "code": error.code,
        "detail": error.detail,
    }));
}

fn main() {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        print_error(&FsError::new("UNSUPPORTED", "request is not valid UTF-8 JSON"));
        return;
    }
    if input.len() > MAX_REQUEST_BYTES {
        print_error(&FsError::new(
            "UNSUPPORTED",
            "request exceeds the 64 KiB protocol limit",
        ));
        return;
    }
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(&input);
    let value = match parsed {
        Err(error) => {
            print_error(&FsError::new(
                "INVALID_DECISION",
                &format!("request is not valid JSON: {error}"),
            ));
            return;
        }
        Ok(value) => value,
    };

    let verb = match value.get("verb").and_then(|v| v.as_str()) {
        Some(verb) => verb.to_string(),
        None => {
            print_error(&FsError::new("INVALID_DECISION", "request has no verb"));
            return;
        }
    };

    // RootConfigJson keeps the binary's root contract in one place.
    let _root_marker = RootConfigJson {
        absolute_path: String::new(),
        device: String::new(),
        inode: String::new(),
    };

    match verb.as_str() {
        "probe" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct ProbeRequest {
                root: RootConfig,
            }
            match serde_json::from_value::<ProbeRequest>(value) {
                Ok(request) => match probe(&request.root) {
                    Ok(health) => print_response(serde_json::json!({ "ok": true, "health": health })),
                    Err(error) => print_error(&error),
                },
                Err(error) => print_error(&FsError::new(
                    "INVALID_DECISION",
                    &format!("probe request is malformed: {error}"),
                )),
            }
        }
        "inspect" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct InspectRequest {
                root: RootConfig,
                segments: Vec<String>,
            }
            match serde_json::from_value::<InspectRequest>(value) {
                Ok(request) => match inspect_at(&request.root, &request.segments) {
                    Ok(snapshot) => {
                        print_response(serde_json::json!({ "ok": true, "snapshot": snapshot }))
                    }
                    Err(error) => print_error(&error),
                },
                Err(error) => print_error(&FsError::new(
                    "INVALID_DECISION",
                    &format!("inspect request is malformed: {error}"),
                )),
            }
        }
        "mkdir" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct MkdirRequest {
                root: RootConfig,
                parent: DestinationRef,
                segment: String,
            }
            match serde_json::from_value::<MkdirRequest>(value) {
                Ok(request) => match mkdir_at(&request.root, &request.parent, &request.segment) {
                    Ok(destination) => print_response(serde_json::json!({
                        "ok": true,
                        "destination": destination,
                    })),
                    Err(error) => print_error(&error),
                },
                Err(error) => print_error(&FsError::new(
                    "INVALID_DECISION",
                    &format!("mkdir request is malformed: {error}"),
                )),
            }
        }
        "move" => match serde_json::from_value::<MoveRequest>(value) {
            Ok(request) => match move_at(&request) {
                Ok(receipt) => print_response(serde_json::json!({ "ok": true, "receipt": receipt })),
                Err(error) => print_error(&error),
            },
            Err(error) => print_error(&FsError::new(
                "INVALID_DECISION",
                &format!("move request is malformed: {error}"),
            )),
        },
        "undo" => match serde_json::from_value::<UndoRequest>(value) {
            Ok(request) => match undo_at(&request) {
                Ok(receipt) => print_response(serde_json::json!({ "ok": true, "receipt": receipt })),
                Err(error) => print_error(&error),
            },
            Err(error) => print_error(&FsError::new(
                "INVALID_DECISION",
                &format!("undo request is malformed: {error}"),
            )),
        },
        other => print_error(&FsError::new(
            "INVALID_DECISION",
            &format!("unknown verb {other:?}; supported verbs: probe, inspect, mkdir, move, undo"),
        )),
    }
}
