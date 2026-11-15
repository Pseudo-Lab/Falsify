# BLUE Evidence v0.3.8 (Raw-data recomputation + quote/Zero-Drop gate)

Extends `v0.3.7` and delegates inner model stages to `v0.3.5` without modifying `v0.3.1`–`v0.3.7`.

## What v0.3.8 Adds
- **Row-level raw dataset audit** when `supp-*` segments are present. `paper_raw_dataset_audit.audit_raw_datasets` recomputes N (including an explicit included/excluded/eligible flag), mean/SD, median/IQR, and unadjusted two-group Welch/Student or Fisher/chi-square p-values from `.csv`, `.tsv`, and row-level `.json` supplements. Signals are stored on `deterministicTriage.rawDatasetAudit` and copied into the bounded digest as `rawDatasetSignals`.
- Adjusted, multivariable, and multiplicity-corrected p-values (`aOR`, `FDR`, `p_adj`, and the same family) are not flagged.
- **Post-model quote and Zero-Drop gate** (`audit['reportValidation']`). Dropped stage-1 `candidateLedger` rows are restored as `verdictLabel=확인필요` with `zeroDropRecovered=true`. A non-abstained defect (`아님` / `defect`) whose quote is absent from the supplied segments gets at most one quote-repair model call. A quote that still does not match is downgraded to `확인필요` and its rationale is prefixed with `[인용 미검증 자동 강등] `.

## Local Profile Build & Offline Testing
```powershell
python app/examples/evidence_blue_v038/build_profile.py
python -m unittest discover -s app/examples/evidence_blue_v038 -p "test_*.py" -v
```
`test_offline.py` uses standard-library `unittest` only. Transports stay injected; tests do not open the network.
