# Review experience and motion specification

Version 1.0 · 2026-10-06 · See the [offline interactive mockup](../mockups/review.html).

## 1. Design intent

Help Arvind make a clear placement decision with minimal repeated reading. Show filenames, existing destinations and evidence before statistical detail. Keep a visible separation between simulated classification, user approval and verified filesystem outcomes.

The mockup uses synthetic data and performs no filesystem or network operation. Its selections, filters, evidence panel and simulated summary illustrate the interaction, not a working organiser.

## 2. Information architecture

| Screen | Primary action | Required information |
| --- | --- | --- |
| Setup and scan | Scan read-only | Resolved root, inbox depth, destination scope, exclusions and provider health |
| Folder review | Approve taxonomy revision | Existing labels/descriptions, virtual groups, candidate folder examples and actual destinations |
| Placement review | Approve selected moves | Source name, relative target, evidence status, suggestion, uncertainty, selection and overrides |
| Execution summary | Apply exact approved action set | Count, every source/target, new directories, conflicts, approval expiry and root |
| Run history | Inspect results / request undo | Verified status, attempt time, source/target, receipt and recovery availability |
| Model evaluation | Compare results | Dataset treatment, support, accuracy, uncertainty, latency/memory and failed runs |

An execution summary is mandatory even when every suggestion is selected. Entering the review screen does not create an approval. Approving a new category does not approve its file moves.

## 3. Placement table

Columns: selection, filename/type, current location, proposed destination, evidence status, review status, details. On small screens use stacked row cards with the same information. Keep source and target available without horizontal scrolling. A distinct status word accompanies every colour.

States: Suggested, Uncertain, Unknown, Needs folder review, Extraction failed, Changed since scan, Collision, Approved, Moving, Verified, Conflict, Undone. A model's top probability is labelled `Model probability` and shown with an optional competing-category distribution. No badge says `Safe` on the basis of confidence.

Unknown and stale rows cannot be selected for execution. Manual mapping is allowed, increments proposal version and needs fresh approval. Manual assignment does not erase extraction warnings or overwrite failure evidence.

Details contain bounded source excerpts and deterministic metadata signals, alternate labels and model/runtime revision. Do not display an invented rationale as if the decision model supplied it. Selecting a row opens a side panel on desktop or full-screen panel on mobile. Escape closes it and restores focus.

## 4. New-folder review

Show proposed label, parent path, representative filenames, number of items and whether an existing folder is similar. Actions: accept, edit label/description, map to existing folder, reject. A controlled vocabulary suggestion shows that origin. The user can explicitly request a new category for fewer than three items.

Show virtual taxonomy groups separately from physical destinations. Accepting a virtual group must not imply a directory will be created. Updating the taxonomy announces that affected placements will be regenerated.

## 5. Execution and undo

Show progress as verified outcomes/attempted actions, with conflicts separately. A cancellation request stops between actions, lets an in-flight helper finish or reconcile, and preserves receipts. Never remove a row optimistically when applying a real move. Show `Moving` until verification finishes.

Undo opens an exact reverse-move summary. Explain why a modified target or occupied original path needs review. Undo is user-selected per action; batch undo executes reverse application order and stops/defer conflicts individually. Created directories remain in v1.

## 6. Visual and motion guidance

Dark graphite background, warm off-white text, teal selection/verified accent, amber uncertainty and coral conflicts. Use system sans-serif fonts with tabular numeric metrics. Spacious typography for evidence and compact rows for scanning. Avoid decorative animations during execution.

| Interaction | Motion |
| --- | --- |
| Details panel | 160 ms opacity/translate; focus moves into panel |
| Row selected | 100 ms background transition |
| Status change | 120 ms crossfade; aria-live polite announcement |
| Screen transition | 180 ms opacity; no exaggerated spring |
| Progress | Actual completed counts; no simulated time-based percentage |

Implement with CSS transitions initially. A motion library can be introduced when interactions justify it; animation is not a dependency for correctness. Honour `prefers-reduced-motion` by removing transform/animation and keeping state changes immediate.

## 7. Accessibility and browser requirements

Target WCAG 2.2 AA: labels and meaningful buttons, table headers, visible focus, keyboard-selectable rows, sufficient contrast, 44 px primary touch targets and status text independent of colour. Dialog traps focus and restores it; toast announcements never replace persistent error text. Long and shell-like filenames render as escaped text and wrap safely.

Support current Chromium and Firefox on Fedora; localhost server supplies all assets. Model/file contents are never treated as HTML. External navigation is explicit; no external font, analytics or CDN dependency. Use responsive behaviour at 360, 768 and 1440 px, plus keyboard-only and reduced-motion verification.

## 8. UI acceptance scenarios

Select two eligible rows, filter by status, open/close details with keyboard, change a destination, review exact summary, obtain approval, observe verified/conflict results and request conditional undo. Verify disabled unknown/stale rows and stale-approval response. A forged cross-site POST must fail even when the user has an active session. Performance and metrics screens label synthetic/failed/missing data honestly.

