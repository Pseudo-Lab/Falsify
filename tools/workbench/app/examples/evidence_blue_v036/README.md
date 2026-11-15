# BLUE Evidence v0.3.6 (External Grounding & ClinicalTrials.gov Audit)

Extends `v0.3.5` (120s document-stage timeout, 150s total budget, exit `124` on `model_timeout`)
without modifying `v0.3.1`–`v0.3.5` or shared service files.

## What v0.3.6 Adds
- **Full-Bibliography Verification (`D2`)** via `app/local/paper_external_grounding.py`:
  - Extracts DOIs, PMIDs, PMCIDs, years, title candidates, and first-author surnames.
  - Verifies up to 25 references per call against `api.crossref.org` and `www.ebi.ac.uk`
    with global-IP DNS pinning, 7s TLS deadlines, 500 KB response caps, and no redirects/cookies/auth.
  - Flags Crossref 404s (`doi_not_found_in_crossref`) and chimera/hijacked DOIs (`metadata_mismatch`),
    while explicitly preserving `"missing search match is not proof of fabrication"`.
- **In-Text Citation Claim Grounding (`T2`)**:
  - Links bracketed (`[1]`, `[2, 5]`, `[3-5]`) and author-year citations in quantitative/causal
    sentences to bounded (`<= 3500` chars) Europe PMC / Crossref abstracts.
- **ClinicalTrials.gov v2 Registry Audit** via `app/local/paper_clinical_trials.py`:
  - Extracts up to 10 unique `NCT########` IDs, fetches `protocolSection` from `clinicaltrials.gov`
    (`/api/v2/studies/NCT########`), and compares registered primary/secondary outcomes and
    `ACTUAL` enrollment against paper statements (`potential_outcome_switch`,
    `enrollment_discrepancy_candidate`), framed strictly as registry protocol comparison evidence.

## Local Profile Build & Offline Testing
Run `python app/examples/evidence_blue_v036/build_profile.py` to generate the gitignored local
`profile.json`. All unit tests in `test_offline.py` and `app/tests/test_paper_external_grounding.py`
run 100% offline using injected mock transports and a socket network guard.
