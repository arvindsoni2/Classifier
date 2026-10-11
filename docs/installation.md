# Installation and setup

Status: verified on this machine 2026-10-09. Versions below are actual, not
recommended.

## Prerequisites (verified present)

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | v22.23.2 | 22.x line, satisfies the ≥22.18 requirement |
| pnpm | 11.22.0 | repository uses a pinned `pnpm-lock.yaml` |
| Rust (rustc/cargo) | 1.99.0 (b940084d7 2026-09-28) | installed via rustup, stable, x86_64-unknown-linux-gnu |
| pdftotext (poppler) | 26.01.0 | pinned worker for text PDFs |
| /usr/bin/prlimit | util-linux | enforces the 512 MiB extraction worker ceiling |
| C++ toolchain | g++ 16.2.1 | required by better-sqlite3 native builds |

## Install

```sh
pnpm install
pnpm build
```

## Native helper build (required before any move capability)

```sh
pnpm test:native               # builds and runs the Rust test suite
cargo build --release --manifest-path native/fsops/Cargo.toml
```

The helper resolves paths with openat2 (RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
RESOLVE_NO_XDEV) and renames with renameat2 RENAME_NOREPLACE. On kernels
without these primitives the helper answers UNSUPPORTED_KERNEL and apply stays
disabled.

## Clef SystemOne server (optional, enables the typed provider)

The provider requires a loopback server that speaks the dedicated SystemOne
API — an Ollama-style chat endpoint is not a substitute and is recorded as
blocked when it answers. Build from ggml-org/llama.cpp master (2c564f4,
release-mode) and run it with the Clef-flash GGUF:

```sh
./build/bin/llama-server --host 127.0.0.1 --port 11435 -m /path/to/Clef-Flash-Q4_K_M.gguf --ctx-size 4096 --threads 8 --log-disable
```

Then record the endpoint in the gitignored local configuration:

```json
{ "clef": { "endpoint": "http://127.0.0.1:11435" } }
```

(create `config/local/providers.json` with the above content)

## Local verification

```sh
pnpm test
pnpm test:native
pnpm test:e2e
pnpm typecheck
pnpm lint
pnpm build
pnpm eval:fixture     # deterministic synthetic report
pnpm run doctor       # per-provider health
```

## First setup

The CLI takes the scan path as its first argument (or `ORGANISER_ROOT`); it
has no `--root` flag, and `tsx` is not a dependency:

```sh
pnpm build
ORGANISER_ROOT="$HOME/Downloads" node dist/cli/main.js scan   # read-only
ORGANISER_ROOT="$HOME/Downloads" node dist/cli/main.js taxonomy --review
ORGANISER_ROOT="$HOME/Downloads" node dist/cli/main.js classify --provider rules
ORGANISER_ROOT="$HOME/Downloads" node dist/cli/main.js review --list
```

Classification requires a reviewed taxonomy (`taxonomy --review`, or the
Taxonomy tab in the UI). `pnpm typecheck` covers the application and the UI,
`pnpm test` the unit/integration suites, `pnpm test:native` the helper, and
`pnpm test:e2e` the review flow.

Run `organiser review` and use the one-time bootstrap token printed on the
terminal in the login form. Approval of a concrete batch happens inside the
application; nothing in this repository grants it.
