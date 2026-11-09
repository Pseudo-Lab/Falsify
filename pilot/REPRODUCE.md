# Reproducing and checking the synthetic study

**Educational fiction.** All subjects, specimens, features and outcomes are synthetic. No blood was collected and no clinical diagnostic validity is established.

## Environment

Use Python and the package versions recorded in environment.lock. The commands assume this environment is already provisioned. Initial package acquisition is separate from offline inspection of the archived data. No credentials or network access are required for the stored-artifact checks below.

## Stored artifacts (read only)

From the provided repository root:

```bash
python -m tools.verify_contracts --all-runs
python -m tools.recompute_metrics --run run_52xe
python -m tools.build_release
python -m pytest
```

recompute_metrics reads archived predictions and the original labels/masks, recomputes subject-level metrics and bootstrap intervals, and compares them with the named capsule. It does not retrain the model. Use the other run IDs from schedule/cases.jsonl to inspect other executions. Do not overwrite archived capsules. File checksums establish byte identity; they do not establish scientific validity. Test results are audit evidence and must be interpreted together with the relevant source and artifacts.

## Replaying model execution

For a complete training replay, use a separate clean checkout of the captured execution source, before archived run directories were added. The recorded source commit is ff77e8b4b58ad90eede0e5d1eec18342cdc8fb51. In a history-equipped package, create a separate worktree at that commit, provision the recorded environment there, and run:

```bash
python -m tools.run_case --case run_xapp
```

The launcher requires clean tracked source and refuses to overwrite an existing run directory. New replay provenance must describe the replay honestly; do not replace the original launch record. Snapshot-only material still supports the stored-prediction audit and includes each run's source.tar and source_index.json for source inspection. Access to Git history is a separate review condition.

## Manuscript and layout

paper/manuscript_en.md is the canonical editable text. paper/paper.pdf is its two-column anonymous educational AMF rendering; tables may be split into aligned inclusion/configuration and metric panels. The selected rules are fixed in venue/target_manifest.json and venue/profiles.json, with no waivers in venue/waivers.json. The loss formula uses an equivalent plain-text notation in the PDF. paper/build_pdf.py can regenerate the layout in an environment with ReportLab, pypdf and the named fonts; layout generation does not execute training. PDF byte identity can change with renderer/font versions and creation metadata.

## Release inventory

release/manifest.json inventories regular participant files, excluding itself and release/checksums.sha256. checksums.sha256 includes the manifest and excludes itself. The release commit identity is supplied separately; neither file guesses its own future Git SHA.
