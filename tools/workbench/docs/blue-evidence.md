# BLUE Evidence v0.3.3 on your own PC

## Quick start

Use your own Python 3.12+ and Claude Code subscription login. No API registration or shared credentials are required. Download the Workbench source release, preserve its directory structure, and open a terminal in its root.

```powershell
python -m pip install -r app/local/requirements.txt
python app/examples/evidence_blue_v033/build_profile.py
python -m unittest discover -s app/examples/evidence_blue_v033 -p "test_*.py" -q
```

Import the generated `app/examples/evidence_blue_v033/profile.json` in Workbench's Harness area, select it in BLUE, connect your companion, import a paper, and explicitly start BLUE. With the Windows launcher's `.venv`, use `.venv/Scripts/python.exe` for profile generation so the selected runner interpreter has the same dependencies. Registration and offline tests do not execute a model.

## What is installed

The source includes the v033 runner, its v031/v2 supporting modules, and the attributed CC BY methodology corpus. `profile-template.json` contains install-time placeholders. The generator writes the current Python, runner and audit paths. Generated profiles are ignored by Git. Another person generates their own profile after installing the same source.

The runner requests `claude-opus-5-5` with medium effort through an existing Claude subscription login. App metadata remains `custom-stdio-model-unverified`; a requested model is not a certified execution identity. Model/API accounts are not included.

Final review may perform a lookup-plan call, two parallel specialist calls and a challenge call, bounded to four internal calls per adapter invocation and 150 seconds. Scan/selection invocations can each call a model too; the app-call budget is not the total internal-call budget. Crossref/Europe PMC receive bounded model-generated queries (metadata/abstract lookup, up to four GETs per final review, no automatic retry). No full PDF is sent to those lookup APIs. The selected CLI provider receives the supplied paper text.

## Records and limits

Raw responses and derived quote-binding observations stay in `.local/blue-evidence-v033-audits` on that PC. Paper evidence must bind exactly to supplied text; only unique whitespace-equivalent scan quotes may be reanchored. Final expert/challenge quotations are not rewritten. Refusal, abstention and zero findings are valid. Offline tests do not establish live compatibility or scientific accuracy.

Team members may share the definition and execution summaries through invited accounts. Sharing is separate from local installation and scientific validation. Different local paths currently produce different full configuration hashes; cross-PC strategy identity is separate work. Record actual profiles, versions and conditions, and distinguish human judgments from model output.

RED and BLUE can be used independently. A blind BLUE input excludes RED plans, answer keys and prior BLUE responses.
