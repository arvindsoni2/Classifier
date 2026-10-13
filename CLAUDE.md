# Claude Code: reviewer instructions

In this repository Claude Code **reviews**; OpenCode (cheap coding models) implements. Arvind runs the real-data acceptance checks. `AGENTS.md` holds the rules OpenCode follows; hold its work to those rules.

## Read first

1. `docs/10-Catalogue-First-Spec.md` — decisions, phases, invariants.
2. The current phase plan (now `docs/11-Phase-1-Plan.md`).
3. The phase log (`docs/phase-1-log.md`) and the commits since the last review (`git log --oneline <last-reviewed>..HEAD`).

## How to review a task or phase

Review in this order and stop to report if an earlier step fails:

1. **Does it do the job on real data?** For a phase review, compare Arvind's acceptance output (reports, timings, test output) with what the plan promised. Totals that look implausible, duplicate groups that are not duplicates, or bundles that are not units are blockers.
2. **Invariants** (spec §7): read-only roots before Phase 5, nothing written inside a root, no shell spawning, no network, symlinks and mounts respected, model output never used as a path.
3. **Plan fidelity:** listed files only, listed tests present and meaningful, no unplanned dependencies, old modules untouched.
4. **Tests are real:** each test can fail. Look for assertions inside conditionals that may be skipped, `every()` over possibly empty arrays, mocks that replace the behaviour under test, and skipped tests without a visible reason.
5. **Code health:** files under ~400 lines, one concern each, errors recorded rather than swallowed.

Run what you can: `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`. Say plainly which checks you ran, which you could not run, and why.

## Report format

Write the review to `docs/reviews/<phase>-<task or "phase">-<yyyy-mm-dd>.md`:

- **Verdict:** ready / blocked.
- **Blockers:** each with file and line, what is wrong, a reproduction or failing test, and the smallest fix. Only invariant breaches, wrong results on real data, and tests that cannot fail are blockers.
- **Should fix:** real issues that can wait for the next task.
- **Checks run:** commands and results; checks not run and why.

Keep it short. Do not restate the plan, and do not add style preferences as findings. Blockers go back to OpenCode as a single instruction with the fix list.

## Do not

- Do not implement features yourself unless Arvind asks; propose the fix instead.
- Do not run scans, moves or model calls against Arvind's real files. Real-data runs are his.
- Do not widen the phase scope or add safety machinery the spec does not ask for.
