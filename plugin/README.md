# Falsify plugin for Claude Code

A local Claude Code plugin that automates the team's Red / Blue / scoring flow
(`docs/prompts/`, `tools/`) and adds run folders with metadata, an isolated workspace, and
support for PDF papers. Not on any marketplace: it is loaded from this folder.

## Commands

| Command | What it does |
|---|---|
| `/falsify:setup <folder> [--force]` | Create or refresh a workspace |
| `/falsify:red <paper> D1` | Red on a Markdown paper, the team's way: one defect, a diff, a key JSON |
| `/falsify:red <paper>` | Red on a PDF paper (older pipeline: proposes a plan, waits for OK) |
| `/falsify:blue <paper>` | Blue on a PDF or Markdown paper, with our rules |
| `/falsify:csv <blue run> --team <name>` | Export a Blue run as the team's CSV |
| `/falsify:compare <blue run> <key file>` | Side-by-side document: each planted defect and the Blue row that found it. No scores |
| `/falsify:score <results folder> --keys <folder> [--papers <csv>]` | Score with the team's `tools/score.py` |

`<paper>` is any unique part of a file name in the workspace's `papers/` folder.

## Install

Clone the repo, check out the branch, install Python packages in a virtual environment
(`pip install -r plugin/requirements.txt` and `pip install -r requirements.txt`), activate it,
then start Claude with `claude --plugin-dir <repo>/plugin`. The plugin must stay inside the
repo: it reads the team's Red prompt from `docs/prompts/` and uses `tools/apply_patch.py`
and `tools/score.py`.

The plugin's own prompt files are not in git. Get them from the team and put them in
`plugin/prompts/` (see `prompts/README.md`).

## Workspace and isolation

Sessions run in a workspace folder outside the repo (`papers/`, `runs/`, `.claude/settings.json`),
never in the repo itself: the repo is where the plugin is installed, the workspace is where
papers, runs and answers live, so nothing private can end up in git and no repo file leaks
into a blind run.

`/falsify:setup` writes the workspace settings. They block web search and every site except
the public APIs used to check that a cited reference or a registered analysis is genuine:
Crossref, DataCite, PubMed, DRKS and ClinicalTrials.gov, through WebFetch only. The Blue rules
say what the lookups are for and forbid looking up the paper itself. After a plugin update,
refresh with `/falsify:setup <folder> --force`. Each run records in `meta.json` (`isolation`)
whether lookups were available. The blocks are permission rules, not a network sandbox
(Claude Code's sandbox does not run on native Windows).

## A full round on a Markdown paper

```
python tools/fetch_paper.py PMC12215570            # repo root; writes corpus/raw/PMC12215570.md
copy corpus\raw\PMC12215570.* <workspace>\papers\
/falsify:red PMC12215570 D1                         # in the workspace
```
Red edits a copy of the paper; `main_make_patch.py` generates the diff, verifies it with the
team's `apply_patch.py`, and writes `handoff/<id>.diff` and `handoff/<id>.tampered.md`. The key
(`keys/<id>.json`, the team's fields) is moved to `../falsify-keys/<id>/<run>/keys/` at the end.

```
copy <red run>\handoff\PMC12215570.tampered.md <workspace>\papers\      # and remove the clean .md
/falsify:blue PMC12215570                           # new session
/falsify:csv runs/PMC12215570/blue-run1 --team blue-a --out results/w3/blue-a.csv
/falsify:score results/w3 --keys <key folder> --papers <papers.csv>
```
The CSV export finds each quote in the paper and writes its line number, counted without the
warning block that `apply_patch.py` puts on top, so it lines up with the key's line numbers.
In the CSV, `맞음` means "flagged as a defect": that is how `tools/score.py` reads it.

## Comparing a Blue run with an answer key

`/falsify:compare runs/<paper>/blue-run1 <key file>` in a separate, non-blind session. The key
can be any text file (a Red report in Markdown, the team's JSON, a CSV). The session reads both
documents and writes a Korean side-by-side document: per planted defect whether Blue flagged it
as a defect, flagged it as 확인필요, or missed it; then the Blue rows that match nothing; then
open decisions for a human. It gives no scores and it is a reading by the model, so check it.
The result is saved outside the workspace at `../falsify-keys/<paper>/<run>/compare.md`.

Keep answer keys in `../falsify-keys/`, never in the repo and never in the workspace.

## Run folders

`runs/<paper-id>/<mode>-runN/` holds the paper, `meta.json`, the result files and `work/`
(scratch; safe to delete). `meta.json` records paper hash, paper kind, isolation level, model,
start/end, minutes, the exact prompt text and a hash per prompt file.

## Prompts

`start_run.py` assembles the prompt when a run starts, so an edit applies on the next run.

| Run | Prompt parts |
|---|---|
| Blue, PDF | `blue_task.md` + `blue_rules.md` |
| Blue, Markdown | `blue_md_note.md` + the two above |
| Red, Markdown | `red_md.md` wrapping the team's `docs/prompts/red_제출.md` |
| Red, PDF | `red.md` |

## PDF papers (human tools, from the workspace; `P` = this plugin folder)

```bash
python $P/tools/preflight.py "papers/<file>.pdf"          # before a Blue run on a new PDF
python $P/tools/blue_report.py runs/<paper>/blue-run1      # html + xlsx report
python $P/tools/check_result.py runs/<paper>/blue-run1/blue_result.md runs/<paper>/blue-run1/work/pages/
```
`blue_report.py` also works on Markdown runs (cards show the lines around each quote instead
of PDF crops). `preflight.py` and `check_result.py` are for PDFs only.

## Language convention

Everything a person on the team reads is Korean: Blue results, reports, `check_report.md`,
Red summaries. Everything the model or a script reads is English: the plugin's prompts, code,
JSON field names, CSV column names, status codes. A new tool that writes a document for people
writes it in Korean from the start. (The team's own prompts in `docs/prompts/` are Korean.)

## Code layout convention

New code follows one job per file: `funct_<topic>.py` holds the functions for one purpose,
`cls_<thing>.py` holds one class, and `main_<verb>.py` is a script entry point whose `main()`
only calls the others. The older tools keep their names; their `main()` functions are split
into named steps.

## Known limitations

- A session started in the workspace could reach other papers or runs through shell commands;
  settings block the Read tool for `papers/` and `.claude/` only.
- `tools/score.py` matches by line number (±2). PDF runs export pages (`p.3`), which only match
  a key written the same way.
- The team's Blue prompt text defines `맞음` as "not a defect", but `tools/score.py` and its
  test data treat `맞음` as "defect flagged". The export follows `score.py`.
- `tests/synthetic/` holds a fake PDF with its answer key. Never use it for a measured run.
