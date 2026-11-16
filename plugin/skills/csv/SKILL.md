---
name: csv
description: "Falsify: export a finished Blue run as the team's CSV. Example: /falsify:csv runs/PMC12215570/blue-run1 --team blue-a"
argument-hint: "<blue run folder> --team <team name> [--out <file.csv>]"
disable-model-invocation: true
allowed-tools:
  - Bash(python "${CLAUDE_PLUGIN_ROOT}/tools/main_blue_csv.py" *)
---

Run `python "${CLAUDE_PLUGIN_ROOT}/tools/main_blue_csv.py" $ARGUMENTS` and show its output as is. Do nothing else.
