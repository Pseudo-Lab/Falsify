---
name: setup
description: "Create or refresh a Falsify workspace folder (papers/, runs/, isolation settings). Example: /falsify:setup C:/work/falsify-hw"
argument-hint: "[folder path] [--force]"
disable-model-invocation: true
allowed-tools:
  - Bash(python "${CLAUDE_PLUGIN_ROOT}/tools/init_workspace.py" *)
---

Run `python "${CLAUDE_PLUGIN_ROOT}/tools/init_workspace.py" $ARGUMENTS` and show its output as is. Do nothing else.
