# OpenCode handoff and Codex review

Version 1.0 · 2026-10-06 · Coding method: OpenCode, as selected by Arvind.

## 1. Copyable implementation instruction

```text
Implement the Fedora Downloads organiser from this pack in a new project workspace.
Read AGENTS.md, docs/01-PRD.md, docs/03-LLD-and-Specification.md,
docs/05-Evaluation.md and docs/06-Implementation-Plan.md before changing code.

Follow the plan task by task. Start with Milestone A (Tasks 1–5): contracts,
read-only discovery, bounded extraction, typed providers and frozen evaluation.
Use synthetic fixtures for all automated checks. The approved scope is direct
files in Downloads, destinations within Downloads, existing folders first,
reviewed additions and explicitly approved moves. Record actual versions.

Use the coding model already configured in OpenCode Go. TDD applies to policy,
contracts and recovery. Preserve public module boundaries. Do not add cloud
fallback, general shell execution, OCR, automatic deletion or recursive moves.

At the end of Milestone A, provide the diff, test outputs, synthetic evaluation
report and real-provider health/blocked results for Codex review. Continue the
next milestone after the review resolves blockers. Classifier success does not
authorise filesystem mutations. Real Downloads apply requires a concrete batch
approval through the completed app after executor verification.

If a platform/dependency mismatch prevents the specified safety properties,
report the evidence and propose a bounded design amendment. Do not silently
replace RENAME_NOREPLACE with an overwrite-capable move or SystemOne with chat.
```

The user reviews the pack before giving this instruction to OpenCode. No repository URL is assumed. Create a new project or explicitly select an existing repository; this pack is not automatically added to Architect or Hatch.

## 2. Skills strategy

Use already installed, inspected skills for structured execution, TDD, debugging, verification and UI accessibility/motion when applicable. Superpowers execution/planning skills are useful, but their review stages should honour the user's chosen OpenCode/Codex split. Skills are development instructions, not runtime enforcement.

OpenCode supports project-local skills in `.opencode/skills/<name>/SKILL.md` and agent-compatible `.agents/skills/<name>/SKILL.md` [S7]. Install only the selected skills into the project and pin their source revision. This pack does not install plugins, write personal skill files or presume available skill names in the user's OpenCode environment.

Use the approved design's invariants over generic skill suggestions. Review dependency and permission changes as code. Record a concise milestone budget: one coding task at a time, relevant checks, one corrective pass before escalating a repeated architectural blocker to Codex. Do not create arbitrary model/agent fleets.

## 3. MCP strategy

| Stage | Suitable capability | Scope |
| --- | --- | --- |
| Development | Git/repository tools | Eventual project repository |
| Development | Filesystem tools, if needed | Project and synthetic fixture root only |
| Development | Documentation lookup | Primary model/runtime/framework sources |
| Product extension | Organiser-owned MCP read tools | `scan`, `list_proposals`, `get_run`, `provider_health` via application service |
| Later reviewed extension | Approval/apply/undo tools | Same session/policy/approval rules; no unrestricted paths or bypass |

Existing public filesystem MCP servers are not the product executor. Development credentials and runtime capabilities stay separate. Do not pass private Downloads evidence to a remote documentation/search server. Start the product MCP interface with read-only tools when there is a concrete consumer. Its writes require an approval identity and capability design for that transport; adding a tool named `approve_batch` is not sufficient authorisation.

Google Drive/X/GitHub account integrations are future adapters. Verify their current API operations, consent scopes, rate/cost constraints and recovery limitations before planning writes. A local collection is an acceptable initial organisation target for bookmarked/starred content when native write integration is unavailable.

## 4. Codex review rubric

| Area | Review question | Required evidence |
| --- | --- | --- |
| Product fidelity | Does it organise only the selected inbox and destinations? | Scope fixtures and actual configuration |
| Encapsulation | Can source/model implementations change independently? | Public contracts and fixture second source |
| Decision integrity | Are malformed, unknown and truncated inputs visible? | Provider/request-budget tests |
| Filesystem safety | Are containment/no-overwrite kernel-enforced? | Helper source, probe and race/collision fixtures |
| Recovery | Can every interrupted effect be reconciled without blind retry? | Fault-injection matrix and receipts |
| Approval | Are exact versions/targets bound across every transport? | Stale/expiry/cross-site tests |
| Evaluation | Are evidence, schemas, splits and failures honestly reported? | Frozen manifests, raw predictions and reports |
| UX | Can the user understand/edit the proposed changes? | Keyboard/responsive checks and review summary |
| Privacy | Does local mode stay local? | Network boundary tests and telemetry inspection |

Prioritise defects by consequence, not stylistic preference. Treat overwrite/escape/approval bypass or loss of recoverability as release blockers. Separate a missing usefulness target from a correctness defect. Request targeted fixes with reproduction evidence; OpenCode performs them and resubmits the affected checks.

## 5. Review report format

Report result (ready/blocked), findings with exact paths and reproduction, passed checks, unavailable checks, unresolved risks and next milestone. Include actual coding/review model identifiers and reasoning settings where exposed. Do not infer them from subscription names.

Recommended review allocation: GPT-6.1 medium for routine contracts/UI; high for native syscall boundary, journal races, approval transport and statistical methodology. Budget-sensitive review should still inspect the safety-critical code directly.
