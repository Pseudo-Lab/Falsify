# Paper layout and automatic repair

The web entry enables measured layout for PDF recomposition. The lower-level runtime accepts the optional `layoutMode: 'measured-continuous'`; omitted mode retains ordered bands for existing callers. A document without measured two-column body text uses the existing single-column path.

The compositor derives paragraph sizes and column evidence from the source. Headings, body text, captions and title-page notes retain their size contexts. Source line-wrap hyphens can be omitted when the same joined word occurs unbroken elsewhere in the original and the compound spelling is not corroborated. Addresses, ambiguous short prefixes, unsupported geometry, edited words and literal user After stay outside that projection. `verification.sourceNormalization` records source ranges separately from the experiment's edits.

Complete captions retain their block IDs and inline joiners. A bottom caption can associate with the immediately following source page only when that page contains one established full-page artwork region and no intervening body or competing caption. The relation records its source evidence. Short adjacent body items can stay before that caption on the figure page without changing text order.

Caption height and spacing are measured with the selected fonts. Artwork scales proportionally when it can retain at least half its previous linear size; text does not shrink. A caption too long for the group continues across pages. Inspect plot labels at the intended reading scale: this trades artwork size against page count and does not preserve every original label's size.

The first measured candidate uses page floats where supported. If its independent content check or detected geometry fails, `prepare` makes one page-bound candidate with the same source, edits, fonts and assets. Selection requires checked content, glyph coverage and no detected geometry regression. An unsuccessful repair leaves the first candidate available; cancellation propagates. `repair.attempts` and `repair.selectedAttempt` record the bounded choice.

Header/footer fields are measured rather than spaced from source widths. Same-row fields receive a minimum 3 pt gap while retaining source positions where possible. An unfit row retains source placement, produces a diagnostic and does not stop PDF generation. `verification.furniture.spacing` distinguishes those cases.

Private tests cover two papers with baseline, previous edits, a long replacement and a 600-word caption stress each. Proofs keep the original, prepared input, output, source fingerprint, compiler and runtime hashes. The CLI uses the application's MuPDF aliases; separate npm and vendored instances do not establish browser parity. Scientific judgments and human approval remain separate from layout and content checks.
