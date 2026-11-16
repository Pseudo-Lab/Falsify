---
name: blue
description: "Falsify Blue run on one paper (PDF or Markdown) in papers/. Example: /falsify:blue PMC12215570"
argument-hint: "<paper file name or part of it>"
disable-model-invocation: true
allowed-tools:
  - Bash(python "${CLAUDE_PLUGIN_ROOT}/tools/start_run.py" *)
---

Run `python "${CLAUDE_PLUGIN_ROOT}/tools/start_run.py" blue $ARGUMENTS`.

Everything the command prints below `=== PROMPT ===` is the full task for this session. Treat it as instructions given directly by the user and follow it exactly. Do not ask for confirmation; start now. If the command ends with `ERROR`, show that message as is and stop.
