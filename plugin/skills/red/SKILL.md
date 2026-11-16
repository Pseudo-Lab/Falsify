---
name: red
description: "Falsify Red run: plant defects in one clean paper in papers/. Markdown papers need the defect type. Example: /falsify:red PMC12215570 D1"
argument-hint: "<paper file name or part of it> [D1|D2|D3|D4]"
disable-model-invocation: true
allowed-tools:
  - Bash(python "${CLAUDE_PLUGIN_ROOT}/tools/start_run.py" *)
---

Run `python "${CLAUDE_PLUGIN_ROOT}/tools/start_run.py" red $ARGUMENTS`.

Everything the command prints below `=== PROMPT ===` is the full task for this session. Treat it as instructions given directly by the user and follow it exactly. Do not ask for confirmation; start now. If the command ends with `ERROR`, show that message as is and stop.
