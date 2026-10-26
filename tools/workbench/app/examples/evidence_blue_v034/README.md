# BLUE Evidence 0.3.4 (experimental)

Reuses the frozen 0.3.3 runner, core and reanchor without a new review strategy.
The 0.3.4 bundle hash adds `app/local/blue_evidence_refs.py` to the files 0.3.3
already hashes, including `blue_service.py`. The 0.3.3 bundle function is left
unchanged and still omits that helper. A different helper hash is a different bundle.

Same Claude subscription request (`claude-opus-5-5`, medium effort), opt-in
Crossref/Europe PMC lookup, four internal calls, 150 second adapter budget, and
the existing scan/evidence checks. This is not a release and does not establish accuracy.

```powershell
python -m pip install -r app/local/requirements.txt
python app/examples/evidence_blue_v034/build_profile.py
python -m unittest discover -s app/examples/evidence_blue_v034 -p "test_*.py" -q
```

Setup binds this PC's Python, runner and audit directory. The committed template
keeps `INSTALL_PY`, `INSTALL_RUNNER`, `INSTALL_AUDIT_DIR` and `GENERATED_AT_INSTALL`.
Generated `profile.json` is gitignored. Do not commit profiles, audits or credentials.

Details: [BLUE 0.3.4 setup](../../../docs/blue-evidence-v034.md).
