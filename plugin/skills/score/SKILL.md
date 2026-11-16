---
name: score
description: "Falsify: score Blue CSVs against the answer keys with the team's tools/score.py (human only, never in a blind session). Example: /falsify:score results/w3 --keys ../Falsify-keys/w3 --papers corpus/papers.csv"
argument-hint: "<results folder with CSVs> --keys <key folder> [--papers <papers.csv>]"
disable-model-invocation: true
allowed-tools:
  - Bash(python "${CLAUDE_PLUGIN_ROOT}/../tools/score.py" *)
---

Run `python "${CLAUDE_PLUGIN_ROOT}/../tools/score.py" $ARGUMENTS` and show its output as is.

This is the team's scoring script; do not reinterpret or recompute its numbers. Do not open the answer keys yourself, and do not start a Blue run in this session.
