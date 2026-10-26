---
name: Falsify Paper Workbench
description: Airport-terminal wayfinding for an independent RED / BLUE paper-experiment workbench.
colors:
  yellow: "#ffcc00"
  ink: "#111315"
  charcoal: "#202326"
  muted: "#5a626a"
  line: "#d9dde0"
  surface: "#f3f4f4"
  paper: "#fff"
  red-ink: "#8e302b"
  focus: "#246388"
  primary-hover: "#363c40"
  secondary-hover: "#e5e8e9"
  border-strong: "#aeb6bc"
  field-stroke: "#8c949b"
  rail-text: "#d7dde1"
  rail-hover: "#33383d"
  table-head: "#e8ebed"
typography:
  gate:
    fontFamily: "Segoe UI, Apple SD Gothic Neo, Malgun Gothic, Arial, sans-serif"
    fontSize: "44px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.04em"
    fontFeature: "tnum"
  headline:
    fontFamily: "Segoe UI, Apple SD Gothic Neo, Malgun Gothic, Arial, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.35
  title:
    fontFamily: "Segoe UI, Apple SD Gothic Neo, Malgun Gothic, Arial, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "-0.02em"
  subtitle:
    fontFamily: "Segoe UI, Apple SD Gothic Neo, Malgun Gothic, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.5
  body:
    fontFamily: "Segoe UI, Apple SD Gothic Neo, Malgun Gothic, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  support:
    fontFamily: "Segoe UI, Apple SD Gothic Neo, Malgun Gothic, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Segoe UI, Apple SD Gothic Neo, Malgun Gothic, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 600
  caption:
    fontFamily: "Segoe UI, Apple SD Gothic Neo, Malgun Gothic, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 400
  footer:
    fontFamily: "Segoe UI, Apple SD Gothic Neo, Malgun Gothic, Arial, sans-serif"
    fontSize: "10px"
    fontWeight: 400
  code:
    fontFamily: "Consolas, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  badge: "3px"
  icon: "4px"
  control: "6px"
  panel: "12px"
spacing:
  compact: "8px"
  control-gap: "10px"
  label-gap: "12px"
  mobile-gutter: "16px"
  field-gap: "18px"
  panel: "20px"
  section: "22px"
  tablet-gutter: "24px"
  surface: "28px"
  desktop-gutter: "32px"
  wide-gutter: "40px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "9px 15px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "9px 15px"
    height: "40px"
  button-secondary-hover:
    backgroundColor: "{colors.secondary-hover}"
  text-button:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    padding: "3px 0"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.icon}"
    padding: "10px"
    width: "100%"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.rail-text}"
    rounded: "{rounded.control}"
    padding: "13px 12px"
  nav-item-hover:
    backgroundColor: "{colors.rail-hover}"
  nav-item-current:
    backgroundColor: "{colors.yellow}"
    textColor: "{colors.ink}"
  status-chip:
    textColor: "{colors.muted}"
    typography: "{typography.caption}"
    rounded: "{rounded.badge}"
    padding: "3px 8px"
  wayfinding-sign:
    backgroundColor: "{colors.yellow}"
    textColor: "{colors.ink}"
    padding: "14px 32px"
  sign-icon-square:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.icon}"
    size: "44px"
  step-code:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.icon}"
    size: "30px"
  work-surface:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "28px"
  support-panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
    padding: "20px"
---

# Design System: Falsify Paper Workbench

## Overview

**Creative North Star: "Airport Terminal Wayfinding"**

The workbench reads like a terminal concourse: a charcoal rail of destinations, one yellow sign that names where you are and the next decision, and quiet white work surfaces where papers, candidates and records are read. The sign is the only loud object on screen; everything below it is calm, flat and legible. Gate-style codes (R1, B1, H1, A1, C1, and step numbers) give each destination and step a short, scannable identifier.

Density is that of an operating tool, not a marketing page. Each RED and BLUE destination is a vertical stack of three numbered work surfaces (input, execute, result) on a cool gray workspace. Human review, results and harness management are separate destinations, never a wizard that forces one case through every step. Supporting detail (help, manual JSON exchange, advanced budgets, engine limits) sits in native disclosures or muted supporting text so the primary path stays short.

Type is a single system sans stack chosen for Korean and Latin UI; no web font ships. Icons are rounded-stroke inline SVG pictograms; directional ones sit white-on-ink inside small square plates, like airport pictograms.

**Key Characteristics:**

- One yellow wayfinding sign per view, bounded by heavy ink rules.
- Charcoal destination rail with a yellow current-destination plate.
- Flat white work surfaces with thin dividers on a cool gray workspace.
- System sans everywhere; gate codes in tabular bold.
- Square ink plates for pictograms and step codes.
- Split-flap sign change, removed entirely under reduced motion.

## Colors

Terminal yellow and sign ink carry direction; cool neutrals carry everything else; one restrained red marks errors and deleted review text.

### Primary

- **Terminal Yellow** (yellow): the wayfinding sign, the current rail destination, the brand mark, step numerals on ink in the connection steps, and text selection. It locates position and the next decision.
- **Sign Ink** (ink): principal text, primary buttons, the sign's top and bottom rules, pictogram plates and step codes. Hover on ink actions lifts to **Ink Hover** (primary-hover).

### Neutral

- **Concourse Charcoal** (charcoal): the persistent destination rail only. Rail labels use **Rail Text** (rail-text); hovered rail items use **Rail Hover** (rail-hover).
- **Muted Slate** (muted): supporting explanations, status chips, pending and empty states.
- **Divider Gray** (line): work-surface borders, section dividers, table rules.
- **Workspace Mist** (surface): the page background, and fills for quoted passages, code, mode notes and support panels inside work surfaces.
- **Reading White** (paper): work surfaces, fields, the top bar, and text on ink.
- **Steel Border** (border-strong): secondary-button stroke and the border of a step that contains focus.
- **Field Stroke** (field-stroke): visible 1px stroke on fields inside work surfaces.
- **Table Head Gray** (table-head): table header fill.
- **Light Hover** (secondary-hover): secondary-button hover fill.

### Semantic

- **Error Red** (red-ink): error feedback text (import, record, export and CLI errors) and struck-through deletions in human review. Never a fill.
- **Focus Blue** (focus): the global 3px keyboard focus outline.

**The Directional Yellow Rule.** Yellow marks where you are, where to go next, or what is selected. It is never decoration, never a status color, never body text.

**The One Sign Rule.** Only the wayfinding band carries a yellow field. Below it, yellow appears only as small plates (the current rail item, the brand mark, connection-step numerals) and selection.

## Typography

**Display Font:** Segoe UI (with Apple SD Gothic Neo, Malgun Gothic, Arial, sans-serif)
**Body Font:** the same system sans stack
**Label/Mono Font:** Consolas, monospace, for the harness JSON editor; inline code uses the browser monospace on a mist fill

**Character:** One practical humanist system sans for both Korean and Latin. Hierarchy comes from size, weight and the gate code, not from a second face.

### Hierarchy

- **Gate** (700, 44px, 1, -0.04em, tabular numerals): the sign's location code. Steps down to 40px below 1120px, 38px below 820px, 36px below 540px.
- **Headline** (700, 22px, 1.35): the sign's next-decision message. 21px below 1120px, 20px below 820px, 18px below 540px. Korean words do not break mid-word.
- **Title** (700, 22px, 1.4, -0.02em): work-surface headings. 21px below 820px, 20px below 540px.
- **Subtitle** (700, 16px, 1.5): subsection headings inside a work surface.
- **Body** (400, 14px, 1.6): default UI text, the export outcome line, mode notes, connection step titles. Prose is capped near 75ch.
- **Support** (400, 13px, 1.6): muted explanations under headings, check-row hints, storage notes.
- **Label** (600, 12px): button text; text links and tables also use 12px.
- **Caption** (400, 11px): status chips and the rail's gate codes.
- **Footer** (400, 10px): the inherited desktop page-foot line (11px below 540px). The source link in that footer is 12px with a 24px target.

**The One Face Rule.** Controls, explanations and document excerpts use the system sans; hierarchy is size and weight.

**The Tabular Code Rule.** Gate codes, step codes, tables and record metadata use tabular numerals.

## Layout

Desktop is a fixed 224px charcoal rail on the left and an app shell beside it: a 68px white top bar (location breadcrumb and a reset icon), the full-width wayfinding sign, then a content column capped at 1496px with 32px gutters (40px at 1600px and above). Work surfaces stack vertically with 24px between them.

At 1120px the rail narrows to 188px and gutters tighten to 24px. At 820px the rail becomes a wrapping header: the RED/BLUE pair spans the row as two equal buttons under its group label, and review, results and harness sit below as three equal 52px tiles with icon over label; the top bar drops to 52px. At 700px paired columns (Before/After, settings, ledger fields) collapse to one column, work-surface padding drops to 18px and buttons in work surfaces go full width. At 540px the sign becomes a two-column grid (gate code, then message with the action beneath it) and gutters are 16px.

The native human-review board keeps RED changes on the left and BLUE findings on the right, separated by a thin divider with a 28px gap. At 960px and below it stacks RED above BLUE with a 24px gap and a horizontal divider. The companion connection panel is hidden only while the review destination is visible. Other destinations retain their existing layout.

Spacing uses the frontmatter steps: 8px compact gaps, 10px between controls, 12px label gaps, 18px between paired fields, 20-22px section gaps, 28px work-surface padding. Wide tables scroll inside their own region instead of hiding columns.

**The Independent Destinations Rule.** RED, BLUE, review, results and harness are sibling destinations, each with its own content. No layout implies one case must pass through them in sequence.

## Elevation & Depth

The system is flat. Hierarchy comes from the mist workspace against white surfaces, 1px dividers, and the sign's 5px ink rules. The only cast shadow belongs to the modal dialog, over a translucent ink backdrop.

### Shadow Vocabulary

- **Overlay** (`box-shadow: 0 12px 50px #0004`): the reset confirmation dialog only.

**The Flat Work Surface Rule.** Work surfaces, panels and cards never cast shadows; depth is tone and rule weight.

## Shapes

Corners are small and functional. Status chips use 3px; pictogram plates, step codes and in-surface fields use 4px; buttons, rail items and work surfaces use 6px; support panels (extraction preview, harness path plan) and the dialog use 12px. The sign is a hard rectangle bounded by 5px ink rules top and bottom. Pictograms are 20px rounded-stroke SVGs (1.8 stroke); inside the sign's ink plate they grow to 26px at a 2px stroke.

## Components

### Buttons

Compact and explicit.

- **Shape:** control radius (6px), 40px minimum height, 1px border.
- **Primary:** ink fill, white label (12px/600), 9px 15px padding. Hover lifts to Ink Hover.
- **Secondary:** transparent fill, Steel Border stroke, ink label; hover fills Light Hover and darkens the stroke to ink.
- **Text button:** underlined 12px ink text with no fill, for low-weight actions (clear input, move to review, harness management).
- **States:** focus uses the global 3px Focus Blue outline at a 4px offset; disabled is 50% opacity with a not-allowed cursor. Background and color transitions run 160ms on `cubic-bezier(.16,1,.3,1)`.

### Chips

- **Style:** status chips are 11px muted text in a 1px gray stroke with a 3px radius. They state facts (for example the engine self-check label in the export result); they are not filters or buttons.

### Cards / Containers

- **Work surface:** white, 1px Divider Gray border, 6px radius, 28px padding (18px below 700px), headed by a step code and title.
- **Support panel:** Workspace Mist fill, 12px radius, 20px padding; used for the extraction preview and the harness path plan.
- **Inline fills:** quoted passages, mode notes and code use a mist fill with no border or radius.
- **Shadow Strategy:** none (see Elevation & Depth).

### Inputs / Fields

- **Style:** white fill, 1px Field Stroke, 4px radius, 10px padding, full width; textareas resize vertically at 1.65-1.7 leading. Ledger fields keep a 44px minimum height.
- **Focus:** the global Focus Blue outline; a step containing focus shifts its border to Steel Border.
- **Choices:** native checkboxes with ink accent color, label beside a 13px muted hint.
- **Error:** Error Red feedback text below the control with a plain explanation; no red fills or borders.

### Navigation

- **Rail:** charcoal, 224px, brand block (yellow plate with an ink "F", name, 11px subtitle) above the destinations.
- **Items:** 13px 12px padding, 6px radius, 600 weight, Rail Text color, pictogram left and the gate code right-aligned at 11px. Hover fills Rail Hover; the current destination is a yellow plate with ink text and carries `aria-current="page"`.
- **Group:** the paper-experiment group is a non-interactive label over RED and BLUE (minimum 44px targets).
- **Mobile:** see Layout; every destination keeps a visible text label and gate codes hide.
- **Top bar:** location breadcrumb (bold current paper, slash, muted location) and a 32px icon button.

### Wayfinding Sign (signature)

A yellow band with 5px ink rules: the gate code, the next-decision headline with a 13px detail line, and an action pairing a bold 14px label with a 44px ink pictogram plate (arrow). Hover lightens the plate. When the message changes it split-flaps: the upper old leaf folds away and the lower new leaf folds in, two 120ms phases hinged at the midpoint with a thin seam, leaves hidden from assistive technology and removed after 300ms. Reduced motion swaps the text immediately.

### Step Head

Each work surface opens with a 30px ink square holding the step code (1, 2, 3, or L for the local connection) in bold tabular numerals, beside the title and a 13px muted description. Connection steps use a 24px ink square with a yellow numeral.

### Export Status

The RED export result is a hierarchy, not a paragraph: a 14px ink outcome line first, then the self-check line led by a status chip, then a bulleted list of engine notes in the inherited muted feedback text, with the single attention-level note set in ink at 600. When the export reports verification limits, they follow as a separate trailing line. Errors switch the whole block to Error Red.

Engine metadata lives in the mist-filled mode note above the export actions, not in the result: engine name and version, an underlined source link when one is reported, then the capability limits appended inline at the end of the same note.

### Native Human Review

The review destination extends the same flat white work surface. A compact saved-run selector precedes the comparison; execution state, raw response, extracted text and hashes remain in native disclosures.

- **RED changes:** before/after quotations mark the changed span with semantic `del` and `ins`. Deletions use Error Red and strikethrough; insertions use bold ink and underline. Recorded RED rationale supplies intent; an absent rationale is stated explicitly, and a user-edited final sentence retains the original proposal’s intent label.
- **BLUE findings:** findings whose quotations overlap RED changes appear first; every remaining finding stays visible. Quote overlap is a navigation aid, never an automatic correctness judgment or detection score. Full explanation, evidence and uncertainty sit in a disclosure beneath each quotation.
- **Human judgments:** each linked RED change has detected, missed, uncertain or pending choices; every BLUE finding has supported, unsupported, mixed, uncertain or pending choices. Each non-pending item requires its own reason. Native selects and textareas use the existing field style with a 44px minimum height; the overall judgment and optional quality score remain separate.
- **Exposure:** showing RED changes marks the run as `red-assisted` for the current page session. Saved BLUE reviews carry `reviewContext.mode` and a visible note prefix identifying RED disclosure as non-blind; `blue-only` states that prior exposure elsewhere is unknown. RED comparison and human judgments remain outside model input.
- **Records:** saving appends a local review without overwriting earlier judgments. Full ledger JSON backup and validated merge preserve item judgments and exposure metadata; older backups may omit those optional fields. Shared review conversion carries the overall summary and prefixed note, not the structured comparison, item judgments or exposure object; it does not replace the full local backup. Shared scores remain subjective human observations, not detection rates or verified execution claims.

## Do's and Don'ts

### Do:

- **Do** keep exactly one yellow sign per view and use yellow only for position, next decision and selection.
- **Do** pair every directional pictogram with a text label, and set directional pictograms white on a square ink plate.
- **Do** give each destination and step a short gate code in tabular bold.
- **Do** keep work surfaces flat: white, 1px Divider Gray, 6px corners.
- **Do** keep keyboard focus visible with the 3px Focus Blue outline, and keep the reduced-motion path that removes the split-flap.
- **Do** put secondary detail (help, manual exchange, budgets, limits) in native disclosures or muted 13px text.
- **Do** state result provenance plainly in the status hierarchy: an engine self-check is labeled as a self-check with independent checks pending, not as verification.

### Don't:

- **Don't** spread yellow to fills, chips, cards or status; it loses its wayfinding meaning.
- **Don't** add drop shadows to surfaces or cards; the dialog is the only shadowed object.
- **Don't** introduce a step-by-step case wizard or progress bar that chains RED, BLUE and review.
- **Don't** use color alone for state; status always has text.
- **Don't** ship a web font or a second display face.

## Visual workflow components (alpha.9)

Preserve the airport world. Large paper-object intake uses GoogleChromeLabs file-drop with an actual PDF thumbnail when available. Collapsed future steps preserve the independent role workflow. A selected tool opens a local shelf, while adapter/model/code settings stay in disclosures. The Harness library precedes authoring; per-item team save prepares an exact content hash without modifying execution selection. Team folder and users/upload symbols distinguish browsing from explicit publication. Native human-verdict controls delegate to the existing select and reason validators. Lucide supplies consistent SVGs; no new raster assets or frontend framework.
