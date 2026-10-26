# Workbench 0.2.0-alpha.7

Human review now lives inside the existing Workbench destination with RED and BLUE side by side.
No API/DB or native editor changes are required by this release.

## Use it

1. Open **검수** and select a saved BLUE run.
2. If the input file hash matches a recorded RED final output, read the original, edited text and recorded attack rationale on the left. Otherwise optionally add the export's RED edit-plan JSON. Missing intent is shown as missing, never inferred.
3. On the right, examine every BLUE finding. Quote overlaps appear first as a convenience, not a detection verdict. Mark each finding and each RED attack, giving reasons for judgments; pending items may remain pending.
4. Fill reviewer, overall verdict and overall note, then add the review. The append-only history and full local JSON backup retain individual judgments. Human approval and scientific gold are not generated.

Seeing RED creates a `red-assisted` review context and an explicit note prefix that survives current cloud-summary export. The native cloud review schema is unchanged: detailed finding judgments and RED comparisons remain in local backup, not automatic server sync. BLUE-only review says prior exposure is unknown rather than certifying blindness.

The review module only renders validated stored data and emits form changes. It has no execution, network or storage API; the existing ledger validates and persists optional review fields. Existing backups remain readable. Original model responses are immutable. Raw source text is rendered with textContent, never HTML.

Desktop uses two columns; at 960px and below they stack. No model call or companion connection is needed to review. The normal connection panel remains available in execution destinations.

## Validation boundary

Offline application regression checks cover paired RED/BLUE judgments, reasons required for decided items, old-record loading, exposure persistence and shared-note conversion, response immutability, and BLUE-only review. Responsive captures at 1440px and 390px used an isolated browser context, normal JSON import and genuine private records without saving human judgments. No private records/screenshots are bundled with source, and no new live model evaluation is implied.

Another-PC installation, full shared item-level review/sync, formal accuracy measurements and broader PDF support remain separate work. See the preceding [alpha.6 notes](release-alpha6.md) for unchanged execution/editor boundaries.
