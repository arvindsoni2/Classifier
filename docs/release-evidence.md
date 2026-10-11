# Release evidence

Status: Milestones A–D code complete as of 2026-10-09. This file separates
verified fixture evidence from real-machine measurements and from checks that
are genuinely blocked. Nothing here is a runtime approval to move files.

## 1. Commands and exit status (real, this machine)

```
node --version  → v22.23.2
pnpm --version  → 11.22.0
rustc --version  → 1.99.0 (b940084d7 2026-09-28)
pdftotext -v  → 26.01.0

pnpm test        → exit 0, 153 passed (13 files)
pnpm test:native → exit 0, 12 passed (Rust fsops fixtures)
pnpm test:e2e    → exit 0, 5 passed (Playwright/chromium 156.0.8078.4)
pnpm typecheck   → exit 0
pnpm lint        → exit 0
pnpm build       → exit 0 (app + UI)
pnpm eval:fixture → exit 0 (deterministic synthetic report)
pnpm run doctor  → exit 0
```

## 2. Verified fixtures (synthetic only)

- Discovery: only stable direct regular files inside the selected root enter
  the candidate set; nested files, symlinks, `.part`-style names, hidden files,
  multi-hardlink and oversize files carry explicit exclusion reasons.
- Extraction: text capped at 16 KiB, ≤10 PDF pages, scanned/encrypted PDFs
  metadata-only, malformed DOCX refused, 20 MiB uncompressed budget enforced
  before inflation, 10 s/512 MiB worker limits.
- Providers: answer distributions with missing IDs, sum 0.8, NaN, non-maximal
  selection, unexpected fields, wrong-question answers and non-choice answers
  are all rejected as INVALID_DECISION (deferral).
- Filesystem: no-overwrite, symlink escape, cross-mount (real EXDEV via
  unprivileged userns+tmpfs), source-swap conflict, Unicode/shell literal
  names, hardlink and oversize rejection, post-rename verification.
- Execution: crash at every effect boundary recovers without duplicate moves;
  duplicate apply reuses the verified receipt; cancelled batches stop between
  actions; expired approvals cannot resume; undo preserves an occupied
  original and an unchanged-at-target file reverts.
- Security: loopback-only bind, one-time bootstrap token, HttpOnly
  SameSite=Strict session, Origin check on mutations, Host authority check,
  self-only CSP, no token/cookie logging, cross-site and unauthenticated
  mutations rejected with an active-session evil-origin 403.
- Evaluation: four-item golden report (completion-adjusted 0.75, conditional
  1.0, Brier 0), duplicate families share a split, labels never enter
  inference state, completion-adjusted and conditional accuracy reported
  separately.
- E2E: full review flow on a synthetic root — scan, taxonomy approve,
  classify, select two, edit (version increments), exact summary, confirm,
  apply, verified outcomes, history. Deferred rows are disabled. 360 px
  wrapping and reduced-motion respected.

## 3. Real-machine measurements

- Kernel 7.2.8-200.fc44.x86_64 with openat2 and renameat2 RENAME_NOREPLACE
  available (probe reports both true).
- Clef-flash Q4_K_M (6.1 GB GGUF) served by llama.cpp SystemOne on
  127.0.0.1:11435: health ok with a typed answer; a synthetic invoice
  classified as cat-invoices with p=0.9859, 254 input tokens, ~23 s per
  decision on 8 CPU threads (serial throughput ≈ 2.6 items/min).
- The synthetic evaluation report (build/eval-fixture) is deterministic and
  reproducible; it contains no laptop benchmark claims beyond the timings
  actually measured.

## 4. Blocked or unavailable

- **Laya: live.** @receptron/laya 0.1.2 with the ONNX bundle at
  ~/.cache/receptron-laya/receptron--laya-onnx/main (real limits 512/192 from
  laya_config.json). Synthetic invoice fixture classified cat-invoices at
  p=0.9813 in 419 ms. Both typed providers (Laya local, Clef SystemOne) now
  answer the same question shape, which is the precondition for the matched
  comparison.
- Jev: no cloud consent recorded → disabled; endpoint never guessed.
- Cross-mount as a *destination discovery* case beyond the fixture: the
  kernel-enforced EXDEV path is verified in tests; a real second mount inside
  a live Downloads root was not constructed (privileged setup) — the design
  defers that case.
- Real Downloads classification/moves: none performed. The supervised pilot
  is at the read-only scan stage; development otherwise used synthetic
  fixtures only (AGENTS.md rule 12).

## 5. Known limitations (honest, release-facing)

- Linux has no atomic "rename only if source inode equals my snapshot"
  primitive. A source replaced between verification and rename is detected
  as a conflict; material is preserved, never overwritten, never deleted.
- The rules baseline is keyword matching; its deferral precision on
  metadata-only items (~0.2 on the synthetic set) reflects that.
- The clef GGUF runs CPU-only on this laptop; a full 200-item matched
  treatment is ≈ 75 minutes per provider.
- Cross-site request protection is enforced server-side (Origin/Host); UI
  warnings are not treated as a security control.

## 6. Supervised laptop pilot (read-only scan, 2026-10-11)

Run through the completed app: the CLI `scan` verb and the UI scan verb
(`POST /api/batches`) produced identical results. No filesystem writes were
made to Downloads at any point; storage lives outside the root at
`~/.local/share/fedora-organiser/organiser.sqlite` (mode 0600).

- Resolved root: `/home/asoni/Downloads` (XDG `$HOME/Downloads`, device 50,
  inode 311, policy revision 1). The root was passed explicitly via
  `ORGANISER_ROOT`; the app has no implicit home fallback.
- Scan result: 72 candidates, 37 deferred, 499 destination directories
  (inbox depth zero, destination discovery depth three).
- Exclusions: 21 direct-child directories (depth-zero inbox accepts regular
  files only) and 16 files over the 100 MiB candidate ceiling (largest
  1.66 GB) — all listed, none eligible.
- Taxonomy: revision 1, seed group only. Automatic adoption of the 499
  discovered folders was refused by `MAX_CHILDREN_PER_NODE = 7` — the intended
  curation guard, not a failure. Proposed additions start empty and are
  produced by classification (folder candidates) or user curation in the UI.
- Proposals: 0 — no classification has been run against real files.
- First classification attempt (rules provider, read-only): 72/72 items
  refused with `INVALID_DECISION: no routing answers`. Cause is the taxonomy
  handoff, not extraction or the provider: the seed taxonomy carries the root
  group only, so no category exists to route to and the app will not invent a
  destination (FR-05). Nothing was persisted (0 evidence, 0 decisions,
  0 proposals). Curation of at least one category in the review UI is the
  required next step before classification can produce proposals.
- No runtime approval was created. Matching treatments and the first
  supervised batch remain pending user labels plus an explicit approval
  inside the app.
