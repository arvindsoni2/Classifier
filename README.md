# Fedora organiser

> **Pivot in progress (branch `pivot/catalogue-first`).** The project is moving from a Downloads-only pilot to a catalogue-first organiser for files, bookmarks and Google Drive. Start with `docs/10-Catalogue-First-Spec.md`, then `docs/11-Phase-1-Plan.md`. `AGENTS.md` is for the implementing agent; `CLAUDE.md` is for the reviewer. The description below is the earlier pilot.

A local-first Downloads organiser for Fedora: read-only discovery, typed model
decisions, reviewed placements, and overwrite-safe moves behind explicit
approval. Nothing moves without your confirmation inside the app.

The tool never deletes, never overwrites, never follows symlinks out of the
selected root, and never sends your files anywhere. Model output can only
select a category — it has no path, shell, or write authority.

## What it does

- **Scans** the resolved Downloads root read-only (inbox depth zero,
  destination discovery depth three) and lists candidates, deferrals and
  exclusions with reasons.
- **Classifies** with interchangeable providers through one validated
  contract: `rules` (deterministic baseline), `laya` (local ONNX), `clef`
  (local SystemOne server), `jev` (deferred — no verified API contract).
- **Reviews** every placement before anything moves: exact source and target
  paths, evidence provenance, conflicts, and an approval that is created only
  when you confirm.
- **Applies** moves through a Linux helper using `openat2` containment and
  `renameat2(RENAME_NOREPLACE)`: basenames and bytes are preserved, an
  occupied target aborts that action, and every step is journalled with an
  immutable action snapshot for recovery.
- **Undoes** conditionally under a separately approved undo approval.

## Quick start

```sh
pnpm install
pnpm build            # application + UI
pnpm run doctor       # provider health with real manifests
```

> **Scope of this release.** Moves target only folders that already exist and
> are mapped in the reviewed taxonomy. Reviewed *new*-folder creation (FR-06:
> accept a candidate, create it under approval, move into it) is NOT
> implemented; folder proposals are recorded for review and never touch the
> filesystem. See `docs/Correction-Plan-2026-10-12.md` (pending section).

```sh
export ORGANISER_ROOT="$HOME/Downloads"
node dist/cli/main.js scan           # read-only discovery
node dist/cli/main.js taxonomy       # curation status + discovered catalogue
node dist/cli/main.js taxonomy --review
node dist/cli/main.js classify --provider rules
node dist/cli/main.js review --list  # proposals and deferrals
```

The review UI (curation, exact summaries, conditional undo):

```sh
node dist/cli/main.js review         # loopback only; prints a one-time token
```

Then open <http://127.0.0.1:4317/> and enter the token in the login form.
Classification requires a reviewed taxonomy; the UI's Taxonomy tab curates
categories and maps them to real discovered folders.

## Data and privacy

- Storage lives outside the organised root at
  `~/.local/share/fedora-organiser/organiser.sqlite` (mode 0600) by default;
  set `ORGANISER_DB` to choose another location.
- `ORGANISER_ROOT` must be set explicitly — there is no implicit fallback to
  your real `~/Downloads` during automated runs or tests.
- Provider configuration is local (`config/local/providers.json`, gitignored).
  `ORGANISER_PROVIDER_CONFIG` overrides the path so `doctor` and tests can
  probe a known endpoint instead of whatever is running locally.
- Running the Clef SystemOne server requires `-b 4096 -ub 4096`. Decision
  prompts cannot be split across micro-batches, so llama-server rejects any
  prompt larger than the physical batch size (default `-ub 512`) with HTTP
  500 — which silently caps usable evidence at ~512 tokens. `--ctx-size`
  alone does not help. Verified command in `docs/runtime-manifest.json`.

## Development

```sh
pnpm build            # required first: spawn-based tests run the compiled dist
pnpm test             # vitest (unit + integration + provider adapters)
pnpm test:native      # cargo tests for the filesystem helper
pnpm test:e2e         # Playwright review flow (real helper, synthetic root)
pnpm typecheck        # application + UI
pnpm lint
pnpm eval:fixture     # frozen synthetic evaluation
```

Automated checks only ever use synthetic fixture roots. See
`docs/06-Implementation-Plan.md` for the milestone plan,
`docs/Classifier_Spec_Review_2026-10-11.md` for the spec review and
`docs/Correction-Plan-2026-10-11.md` for the correction status, and
`docs/release-evidence.md` for what has been measured on real hardware
versus what remains pending (labelled data, the supervised real-file batch).

## Requirements

- Node.js 22.x (the supported runtime), pnpm, Rust toolchain (for the native
  helper), and Chromium (for e2e).
- Linux with kernel ≥ 5.12 for `openat2`/`renameat2(RENAME_NOREPLACE)`;
  missing primitives disable apply instead of falling back.
