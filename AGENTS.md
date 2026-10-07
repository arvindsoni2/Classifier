# Agent instructions: Fedora organiser

Applies to the eventual project after this pack is copied into its root. Documents and mockup alone do not establish a runnable application.

1. Implement the approved Downloads-only pilot. OpenCode owns coding; Codex owns planning and review. Read README, PRD, LLD, evaluation and current implementation task first.
2. One file, one concern. Domain logic reads source/persistence through public contracts. UI/API/MCP/CLI call the same application service.
3. Model output selects category IDs only. It has no path, shell, executable or filesystem-write authority. Unknown or invalid output cannot create an executable proposal.
4. Discovery is read-only, depth zero for inbox and depth three for destination directories. Folder-content sampling is opt-in. No symlink traversal or mount crossing.
5. Every move binds exact action versions and current source/taxonomy/policy state to an explicit approval. UI authentication is additional to that approval.
6. Use anchored Linux path resolution and RENAME_NOREPLACE. No check-then-ordinary-rename, copy/delete fallback or automatic collision suffix. Unsupported primitives disable apply.
7. Persist intent before effects, verify afterward, reconcile uncertain states. Approval expiry or changed state returns to review. Never blindly retry a filesystem operation.
8. Preserve original basenames and bytes. No deletion, directory moves, dedup removal, metadata rewriting or cross-mount move in v1. Undo is conditional and separately approved.
9. Keep private evidence local. No cloud fallback or raw-content telemetry. Jev needs explicit dataset consent and reports its selected subset.
10. Evaluate models independently on frozen matched evidence before introducing routing. Keep model, application and workflow results distinct. Never present synthetic metrics as measured.
11. TDD for policy, contracts, execution and recovery. Tests assert observable invariants and fault outcomes. UI styling changes need appropriate visual/accessibility checks rather than mirrored unit tests.
12. DRY, cohesion and encapsulation are constraints. When principles conflict, select the lowest future cost for this project and explain the trade-off in the commit. Do not add unrelated frameworks or refactors.

Use only a synthetic fixture root during automated tests. Never use the user's actual Downloads as a test fixture. Before supervised real moves, attach passing executor/recovery evidence and obtain the runtime batch approval. Development tools/MCP servers are scoped to the project or fixture directory, not the real organisation root.

Record actual package/model/runtime versions. This document contains recommendations, not installed-environment facts. Review new dependencies and compare their necessity against this pilot. No implementation is authorised to silently widen scope when a test is inconvenient.

