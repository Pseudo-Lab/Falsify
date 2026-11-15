# BLUE Evidence v0.3.9 (Static code audit + quote/Zero-Drop gate)

Extends `v0.3.8` and delegates inner model stages to `v0.3.5` without modifying `v0.3.1`–`v0.3.8`.

## What v0.3.9 Adds
- **Static code-supplement audit** when `supp-*` segments are present. `paper_code_audit.audit_code_supplements` compares manuscript sentences with `.py` (AST), `.R`, and `.sql` supplements. It never executes, imports, or evals supplement code. Signals are stored on `deterministicTriage.codeAudit` and copied into the bounded digest as `codeAuditSignals`.
- Checks are family `D6`: tail direction (`code_tailness_mismatch`), preprocessor fit before `train_test_split` (`code_preprocessing_leakage`), undisclosed row filters (`code_undisclosed_row_filter`), and a single-script method contradiction (`code_test_method_mismatch`). Each signal's `excerpt` and `pageIndex` come from the matched manuscript sentence.
- **Optional flow/spin triage.** If `paper_flow_and_spin_triage` is importable, `audit_flow_and_spin_triage(main_segs)` is attached as `deterministicTriage.flowAndSpinTriage` (`flowSignals`, `spinTriageHints`). That module is not part of this bundle's tracked sources, so v0.3.9 runs before and after it lands.
- **`triage_workspace`** is the on-disk audit directory `.local/blue-evidence-v039-audits`. `execute(..., audit_dir=)` overrides it. The saved audit's `deterministicTriage` is the workspace record.
- Inherited raw-dataset recomputation and the post-model quote plus Zero-Drop gate stay in place. The quote check folds PDF ligatures (`ﬁ ﬂ ﬀ ﬃ ﬄ`), dashes, curly quotes, `µ`→`μ`, and line-wrap hyphens, so typographic quotes pass as `normalized`. A still-missing defect quote gets one repair turn, then downgrades to `확인필요`.

## Local Profile Build & Offline Testing
```powershell
python app/examples/evidence_blue_v039/build_profile.py
python -m unittest discover -s app/examples/evidence_blue_v039 -p "test_*.py" -v
```
`test_offline.py` uses standard-library `unittest` only. Transports stay injected; tests do not open the network.
