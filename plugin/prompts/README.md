# Plugin prompts (not in git)

The files here are deliberately ignored by git and shared privately. This folder must contain:

| File | Used for |
|---|---|
| `blue_task.md` | Blue: task and output table |
| `blue_rules.md` | Blue: our rules |
| `blue_md_note.md` | Blue on a Markdown paper: what changes compared with a PDF |
| `red_md.md` | Red on a Markdown paper: wrapper around the team's `docs/prompts/red_제출.md` |
| `red.md` | Red on a PDF paper (older pipeline) |

The team's own prompts are public in the repo at `docs/prompts/`. Red on Markdown reads
`docs/prompts/red_제출.md` from there at run time, so a change the team makes applies on the next run.

Every run records the exact prompt text and a hash per source file in its `meta.json`.
