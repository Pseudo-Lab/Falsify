---
name: paper-layout-review
description: >-
  Iterative VLM review of compiled LaTeX PDFs for layout clashes (text vs figures,
  tables, long equations). Use after the first compile or any float/equation edit;
  loop fix-recompile-recheck until no clashes remain.
---

# Paper layout review

First-draft LaTeX often compiles cleanly but looks wrong: figures rammed into body
text, tables wider than the column, display equations spilling into margins, or
floats stranded with huge gaps. This skill runs a **repeat until clean** loop on
the **compiled PDF**, not on source alone.

**Principle:** open the PDF with a vision tool, list every clash, edit manuscript
sources, recompile with the project build command, and inspect again. Do not mark
the paper done after one pass or because `pdflatex` exited 0.

## When to run

- After the **first successful compile** of a new section, figure batch, or table.
- After moving, resizing, or adding floats, wide tables, or long displayed equations.
- Before calling the manuscript "layout-ready" or sending to co-authors.
- When **vlm-figure-audit** flags page-layout `WARN` or `BLOCKING` on problem pages.

## Iteration loop (mandatory)

```
compile → VLM every affected page → log clashes → fix sources → compile → …
```

1. **Compile** using the command in the project's `CLAUDE.md` (e.g. `latexmk`,
   `make paper`, `./build.sh`). Note the output PDF path.
2. **Scan** pages listed in "What to open" below with the **Read** tool. Read at
   full column or spread width; do not skim only the first page.
3. **Record** each issue with page number and type (see checklist). One row per clash.
4. **Fix** by editing `.tex` (and figure assets if the clash is bad scaling). Apply
   the smallest change that removes the clash (see "Fix strategies").
5. **Recompile** and **re-open the same pages** plus neighbours (floats shift pages).
6. **Stop** only when a full pass reports **no** `BLOCKING` or `WARN` layout items.

Cap iterations at a reasonable effort (e.g. 5 rounds); if clashes persist, end with
`BLOCKING: unresolved after N passes` and list remaining pages.

## What to open

| Pass | Pages |
|------|--------|
| First compile | Every page that contains a new or changed float, table, or `equation` / `align` block |
| After each fix | All pages that had a clash, plus ±1 page (float drift) |
| Final pass | Full PDF at low resolution scan, then zoom any page that looked crowded |

For two-column papers, check **both columns** on each spread; clashes often sit in
the bottom of column 1 or the gutter.

## Layout clash checklist (VLM)

For each page, answer explicitly: **none seen** or **clash: \<type\>**. Do not assume
a clean margin means OK without reading the image.

### Text vs floats

- Body text **overlapping** or running through a figure, table, or caption.
- Caption **overlapping** figure content or **cut off** at column or page edge.
- Figure **wider than column** or intruding into the opposite column.
- Table **wider than column**; numbers or headers **crushed** or **stacked illegibly**.
- Float **split awkwardly** across pages (header on one page, body on the next
  without need).

### Equations and inline math

- Display equation **wider than column** or **into the margin**.
- Long inline formula **breaking line spacing** (text lines overlapping vertically).
- Equation number **colliding** with text or float on the same line.
- Multi-line derivations with **ragged breaks** that hide terms or operators.
- **Huge operators** or fractions forcing inconsistent vertical stretch in a paragraph.

### Whitespace and float health

- **Large empty blocks** (> ~1/3 column height) with floats still pending — stuck float.
- Figure/table **far from first `\ref`** with no `[H]`/`placeins` justification in caption.
- **Orphan / widow**: section heading alone at page bottom; last line of paragraph alone at top.
- **Footnote** lines overlapping figure or table material on the same page.

### Typography (layout-related)

- **Hyphenation storms** or overfull boxes visible as tight word spacing (often beside big floats).
- **References / citations** broken across lines in a way that reads as two sentences fused.

Science and wording are out of scope here; use **manuscript-writing-style** and referee
review separately.

## Fix strategies (edit source, then recompile)

Prefer structural fixes over visual hacks in the PDF viewer.

| Clash | Typical source fix (project may document preferred macros) |
|-------|----------------------------------------------------------------|
| Wide figure | Regenerate slimmer aspect ratio; subfigures; `\linewidth` not `\textwidth` error in 2-col |
| Wide table | `tabularx`, split table, rotate, or move to appendix; fewer decimal places |
| Long equation | `split`, `align`, `multline`, break across lines; move derivation to appendix |
| Float collision | Change float specifier; `\FloatBarrier`; reorder text; smaller float; `[t]` vs `[b]` trial |
| Cramped page | Shorten float or text above; move float earlier/later in source |
| Stuck float | `\clearpage` before bibliography only if project allows; reduce float count |

Do not paste long LaTeX templates in chat as the fix — edit the repo `.tex` files.
Do not scale a bad figure in LaTeX instead of regenerating the asset (**scientific-plotting**).

## Per-page and final verdict

**Per page** (during the loop):

- `PAGE OK: <page>` — no clashes on this page this pass.
- `PAGE WARN: <page>; <issue>` — minor issue, fix if time allows before final pass.
- `PAGE BLOCKING: <page>; <issue>` — must fix before exit.

**After a full pass with no BLOCKING:**

- `LAYOUT OK: <N> pages checked; <M> iterations`
- `LAYOUT WARN: <summary>; <optional follow-ups>`
- `LAYOUT BLOCKING: <remaining clashes>; <pages>`

A manuscript is layout-ready only after `LAYOUT OK` on the final iteration.

## Clash log (recommended)

Keep a short table in the PR description or agent notes:

| Iter | Page | Type | Fix applied |
|------|------|------|-------------|
| 1 | 7 | eq overflow | split eq. (3) across two lines |
| 2 | 7 | — | PAGE OK |
| 2 | 8 | fig-text | `[t]` → `[b]`, shortened caption |

## Integration

- **paper-writing-workflow:** compile step; run this skill after each substantive build.
- **vlm-figure-audit:** figure/table **content** and spot layout; this skill owns
  **full-document iterative** clash removal.
- **scientific-plotting** ([plotting/](../plotting/)): figure dimensions before blaming LaTeX.
- **research-figure-manifest** ([plotting/](../plotting/)): optional `layout_validator: LAYOUT OK @ <git hash>`.
