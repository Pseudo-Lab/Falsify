# Falsify Workbench agent instructions

## Orchestrator reference only

The [external AI RED BLUE North Star](docs/NORTH_STAR_EXTERNAL_AI.md) is a planning reference only for the agent designated by the user as the Falsify project orchestrator. That orchestrator reads it when starting or resuming its work and reconciles later user decisions into it. Other Codex agents, delegated workers and reviewers have no requirement to read or follow it. They work from their explicit assignments; the document does not grant them additional scope or impose its model selection or ownership plan on them.

The active source repository is this checkout of `Shinick-Han/falsify-workbench`. `C:/Users/user/source/falsify-public` is the installed runtime, not the development source. Verify current HEAD and working-tree changes before starting work.

## Orchestrator responsibilities

The Falsify orchestrator supplies each worker with the relevant specification, exact base SHA, assigned files and acceptance checks. It does not delegate reading the whole North Star. Worker configuration and ownership are stated in the individual assignment. A plan is not authorization to start every task or publish a release.

The Falsify orchestrator records implementation facts, tests and remaining defects in WorkBite T-0152 under the verified workspace binding and maintains the North Star. Workers return evidence to their report-to unless separately assigned recordkeeping. Preserve independent RED, BLUE and human-review routes and the current airport design.

## Repository work

Use CodeGraph first when `.codegraph/` exists; do not create an index automatically. Use the search-first skill for new functionality and reuse the existing parser, edit, PDF and record APIs. Use Aside for browser work. Check `ARCHIVED.json` and applicable StorageGuardian registration before edits, builds or worker launch. Preserve private papers, original PDFs, user records, settings and credentials; do not include them in commits.
