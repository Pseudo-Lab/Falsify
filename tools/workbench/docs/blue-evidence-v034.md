# BLUE Evidence v0.3.4 (experimental) on your own PC

The v0.3.4 label identifies this experimental bundle, not a verified live model version. Existing profiles and their hashes remain unchanged. Experimental bundle only. It does not change the 0.3.3 review strategy, requested model, call budget, schema limits or evidence checks. It does not register a release or deploy a service. Live evaluation is out of scope for this package.

## Setup command

Use Python 3.12+ and an existing Claude subscription login. No API key is written into the repository. From the workbench root:

```powershell
python -m pip install -r app/local/requirements.txt
python app/examples/evidence_blue_v034/build_profile.py
python -m unittest discover -s app/examples/evidence_blue_v034 -p "test_*.py" -q
```

With the Windows launcher virtualenv, run those three commands with `.venv\Scripts\python.exe` so the profile records that interpreter. Offline tests do not call a model or the network.

## What the builder binds

`app/examples/evidence_blue_v034/profile-template.json` is the sanitized source. Placeholders are `INSTALL_PY`, `INSTALL_RUNNER`, `INSTALL_AUDIT_DIR` and `GENERATED_AT_INSTALL`. The builder replaces them with this PC only:

- `adapter.executable`: the absolute path of the Python that ran the builder
- `adapter.args`: the absolute path of `app/examples/evidence_blue_v034/runner.py`
- `settings.auditDirectory`: the absolute path of `.local/blue-evidence-v034-audits` in this checkout
- `settings.bundleSha256`, `settings.helperSha256` and `settings.inheritedSources`: hashes of the files below

Import the generated `profile.json` locally. Do not copy it to another machine. Do not commit `profile.json`, `.local` audits, private papers or credentials. Previous version profiles and audit directories stay in place.

## Bundle identity

The digest covers the frozen files v0.3.3 already executes (`evidence_blue_v033` runner/core/reanchor, v0.3.1 core/literature, v2 core/corpus, `cli_backend.py`, `blue_service.py`, `red_service.py`, `harness.py`, `harness_adapter.py`, `experiments/selfplay_codex.py`), plus `app/local/blue_evidence_refs.py` and this v0.3.4 runner. `inheritedSources` stores the frozen predecessor hashes and does not include the helper. v0.3.3's bundle function still omits the helper; this package does not change that function.

Profile id is `shinick-blue-evidence-external-v034`, version `0.3.4`. Requested model remains `claude-opus-5-5` with medium effort. External lookup stays opt-in for Crossref and Europe PMC metadata/abstracts. Internal budget stays 4 model calls and 150 seconds. Scan quote limits and exact evidence checks stay in the reused 0.3.3 pipeline.

Changing `blue_evidence_refs.py` changes `bundleSha256`. A missing helper fails as `helper_missing`. A helper path or file that is not that module fails as `helper_unknown`. A recorded helper hash that does not match the file fails as `helper_stale`. Those codes are the audit `errorCode` and the process message.
