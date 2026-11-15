# BLUE Evidence v0.4.0 (IMRaD internal consistency + code/quote gate)

Extends `v0.3.9` and delegates inner model stages to `v0.3.5` without modifying `v0.3.1`–`v0.3.9`.

## What v0.4.0 Adds
- **IMRaD internal consistency.** `paper_internal_consistency.audit_internal_consistency(main_segs)` runs inside `_collect_deterministic_triage`. The full report is stored on `deterministicTriage.internalConsistency`.
- Deterministic signals are cross-section contradictions only: cohort-size drift (`abstract_results_sample_size_mismatch`), same-metric value or p drift (`abstract_results_effect_or_p_mismatch`), and methods/results protocol drift (`methods_results_protocol_drift`). Screened-versus-randomized, ITT-versus-per-protocol, adjusted-versus-crude estimates, labeled SD/SE, and labeled train/test or timepoint splits stay silent.
- Advisory hints (`primary_endpoint_emphasis_shift`, `declared_exclusion_or_covariate_check`) stay in `triageHints` with `advisoryOnly: true`. They are not added to `signals` or `totalSignals`.
- The bounded digest copies `internalConsistencySignals` and `internalConsistencyHints`. Hint entries are marked `advisoryOnly: true`. Shrink steps keep the block inside `MAX_DIGEST_BLOCK_CHARS`; the inherited prompt append keeps `MAX_PROMPT_CHARS`.
- **Optional workbook/notebook decode.** When `paper_tabular_notebook_loader` is importable and a supplement carries `.xlsx` or `.ipynb` bytes, the runner decodes those bytes before `audit_raw_datasets` and `audit_code_supplements`. The loader is not a tracked source, so this bundle runs before and after that module lands. Macros and notebook cells are never executed.
- Inherited raw-dataset recomputation, static code audit, optional flow/spin triage, typographic quote folding, one-turn quote repair, Zero-Drop ledger recovery, and the `[인용 미검증 자동 강등] ` downgrade stay in place.

## Local Profile Build & Offline Testing
```powershell
python app/examples/evidence_blue_v040/build_profile.py
python -m unittest discover -s app/examples/evidence_blue_v040 -p "test_*.py" -v
```
`test_offline.py` uses standard-library `unittest` only. Transports stay injected; tests do not open the network.
