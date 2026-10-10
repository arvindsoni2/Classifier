# Model evaluation report

Status: synthetic evaluation only. No fitted thresholds, no held-out user
labels. This file separates what is measured from what is still unmeasured.

## 1. What ran

- Deterministic synthetic fixture (8 items, 6 families) through the rules
  provider: `pnpm eval:fixture`. Results are reproducible and synthetic by
  construction.
- Golden fixtures in the test suite prove the metric semantics:
  completion-adjusted accuracy 0.75, conditional accuracy 1.0, completion
  0.75, per-node one-hot Brier 0.
- Real-machine timings on the clef SystemOne server (see
  release-evidence.md §3).

## 2. Measured (synthetic fixture)

| Metric | Rules result | Note |
| --- | --- | --- |
| Completion-adjusted accuracy | 0.375 | keyword baseline; failures are not excluded |
| Conditional accuracy | 1.0 | conditional on completed items only |
| Completed / deferred | 3 / 5 | deferral is explicit |
| Macro-F1 | 0.3333 | with the prediction-counting correction |
| Deferral recall / precision | 1.0 / 0.2 | one insufficient item correctly deferred |
| Accuracy Wilson 95% | [0.137, 0.694] | tiny support; exploratory |

Averaged full-route destination accuracy uses each provider's own route. Node
calibration uses teacher-forced evaluation. Per-node probabilities are never
multiplied into a "global confidence".

## 3. Unmeasured (blocked or pending)

- **Laya vs Clef matched-input comparison**: blocked on this machine (no Laya
  checkpoint). Clef is live and healthy; the matched treatment needs Laya.
- **Held-out user labels**: not collected. Approving labels with the user
  starts a new development cycle per docs/05.
- **Thresholds and cascades**: not fitted; every node runs review_all by
  default. Nodes with < 20 calibration observations keep review_all.
- **Workflow time savings**: the manual baseline has not been run.
- **Confidence calibration on real Downloads data**: not measured.

## 4. Next evaluation step (not authorised yet)

1. Obtain Arvind's labels for development/calibration/test splits.
2. Unblock Laya (checkpoint install) or record a permanently blocked comparison.
3. Run matched treatments (rules, Laya, Clef at metadata and compact-text
   profiles) with the frozen dataset; record per-provider timings on the same
   machine.
4. Fit per-node thresholds on calibration data only; re-run held-out test.
5. Run one manual and one agent-assisted batch on a matched disjoint set and
   time them; report learning effects honestly.
