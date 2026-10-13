# Agent instructions: Classifier

You are the implementing agent (OpenCode). Claude Code reviews your work. Arvind runs the real-data acceptance checks and approves anything that changes his files.

## What this project is

A local-first organiser for files, bookmarks and Google Drive, using local inference only. It catalogues everything first, understands each item, proposes an organisation, and changes nothing until Arvind approves.

## Read before any change

1. `docs/10-Catalogue-First-Spec.md` — goals, decisions, phases and invariants. It overrides docs 01–08 everywhere except move safety.
2. The current phase plan (now `docs/11-Phase-1-Plan.md`) — your tasks, in order.
3. `docs/phase-1-log.md` (if present) — what earlier sessions finished.

Docs 01–08 describe the earlier Downloads-only pilot. Use them only for filesystem move safety (PRD FR-07 to FR-10, FR-13; LLD §5–§7), which applies from Phase 5.

## Rules

1. **One task per session**, in plan order. Do not start the next task or the next phase without being asked.
2. **Tests first.** Write the task's tests, see them fail for the expected reason, implement, then run `pnpm typecheck && pnpm lint && pnpm test`. All must pass before you commit.
3. **Synthetic fixtures only** in tests, built in a temporary directory. Never read or scan a real home directory, Downloads folder or Drive account from a test or script.
4. **Read-only until Phase 5.** No code before Phase 5 may create, modify, move or delete anything inside a configured root. The catalogue, reports and caches live in the data directory.
5. **Model output is data.** It may select or name a category. It never supplies a path, a command or an action.
6. **External tools** are spawned with an argument array, a timeout and an output cap. Never through a shell, never with string-built commands.
7. **No network** except loopback model endpoints, unless the current phase plan says otherwise.
8. **Stay in scope.** Touch only the files the task lists. Do not change old modules (`src/application`, `src/domain`, `src/http`, `ui`, `native`) unless the task says so. Add only the dependencies the plan allows, pinned, and record their versions in `docs/runtime-manifest.json`.
9. **Keep modules small.** One concern per file; no file over ~400 lines. If a file is growing past that, split it before continuing.
10. **Be honest in the log.** After each task, append to the phase log: task, commit hash, test count, anything skipped or deferred and why. Never describe a check as passed unless you ran it.
11. If the plan is wrong or impossible (a tool missing, a rule that contradicts another), stop and write the problem in the log instead of inventing a workaround.

## Commands

```
pnpm build          # app + UI; required before CLI and spawn-based tests
pnpm test           # vitest
pnpm typecheck
pnpm lint
pnpm catalogue ...  # Phase 1 CLI (after Task 5)
```

## Commits

Use the commit message the task gives. One commit per task. Do not push; Arvind pushes after review.
