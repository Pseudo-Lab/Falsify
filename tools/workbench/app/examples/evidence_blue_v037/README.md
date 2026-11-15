# BLUE Evidence v0.3.7 (Deterministic Layer 0 Triage + Retraction/Registry/Supplement Grounding)

Extends `v0.3.6` (and delegates inner model stages to `v0.3.5` with 120s document-stage timeout,
150s total adapter budget, and exit `124` on `model_timeout`) without modifying `v0.3.1`–`v0.3.6`
or any shared `app/local/` files.

## What v0.3.7 Adds
- **Layer 0 Deterministic Triage Digest (Zero Model Cost)**:
  - Partitions payload segments into main segments and `supp-*` supplement segments (from
    `blue-supplement-bundle` or CLI).
  - Runs text-level checks from `app/local/paper_stat_audit.py` (`_scan_stat_pvalues`,
    `_scan_count_percentages`, `_scan_grim`, `_scan_ci_expressions`, `_scan_sprite`,
    `_scan_two_by_two`, `_scan_km_at_risk`) across segments while preserving `segmentId` and
    anti-FP guards (`aOR`/`aRR` multivariable adjustment, multiple-testing `p_adj`/`FDR` cues).
  - Runs `app/local/paper_registry_identifiers.py` `audit_identifiers_offline` (`PROSPERO`
    year-prefix validation and placeholder `OSF`/`GEO`/`NCT` detection).
  - Runs `app/local/paper_supplement_audit.py` `audit_paper_with_supplements` whenever `supp-*`
    segments are present, surfacing `missing_supplementary_item`,
    `cross_file_sample_size_mismatch`, and `cross_file_metric_mismatch`.
- **Extended P2 External Oracle Pack**:
  - Reuses `paper_clinical_trials.py` (`NCT` outcomes & enrollment comparison) and
    `paper_external_grounding.py` (`verify_bibliography` + `ground_cited_claims`), explicitly
    elevating `retracted: true` (`retraction` / `expression_of_concern`) references into
    `retractedReferences`.
  - Runs `paper_registry_identifiers.verify_identifiers_online` for `OSF`, `NCBI GEO`, `RCSB PDB`,
    and `PROSPERO`, preserving `TRUTHFULNESS_NOTE` and `PROSPERO_NOTE` (embargoed/private
    registrations or 404s are verification signals, never proof of fabrication by themselves).
- **Priority-Ranked Bounded Digest (`<= 18,000` chars, `<= 100,000` char prompt ceiling)**:
  - Injects a compact `UNTRUSTED DETERMINISTIC TRIAGE & EXTERNAL ORACLE DIGEST` into
    `document-stage`, `statistics`, `methods`, and `challenge` prompts and records full structured
    provenance under `audit['deterministicTriage']` and `audit['externalGrounding']`.

## Local Profile Build & Offline Testing
```powershell
python app/examples/evidence_blue_v037/build_profile.py
python -m unittest discover -s app/examples/evidence_blue_v037 -p "test_*.py" -v
```
All tests in `test_offline.py` use standard-library `unittest.TestCase` (no `pytest`) with
injected mock transports/fetchers and a `socket.create_connection` guard ensuring zero live
network calls.
