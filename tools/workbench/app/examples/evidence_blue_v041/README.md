# BLUE Evidence v0.4.1 (PDF security + figure axis/subpanel + quote gate)

Extends `v0.4.0` and delegates inner model stages to `v0.3.5` without modifying `v0.3.1`–`v0.4.0`.

## What v0.4.1 Adds
- **PDF security triage.** When a segment or payload carries PDF bytes (`bytes` or `pdfBase64`), `paper_pdf_security_forensics.audit_pdf_security` runs inside `_collect`’s successor `_run_triage_and_grounding`. The full report is stored on `deterministicTriage.pdfSecurity`. Compact rows are copied to the bounded digest as `pdfSecuritySignals`.
- Hidden-text signals (`hidden_pdf_text_layer`) cover micro-fonts, near-white text that is not on a dark backing, off-page text, and `3 Tr` invisible text. A full-page scan with an overlapping invisible OCR layer is not a hidden-text signal unless that layer contains a prompt-injection directive.
- Prompt-injection signals (`prompt_injection_directive`) cover spans, annotations, metadata (`title`, `subject`, `keywords`, `author`), and supplement `text`. A visible body mention is suppressed only when the title or headings discuss prompt injection, jailbreak, LLM security, or adversarial prompts. Hidden spans, annotations, and metadata are still reported.
- **Optional meta/table audit.** `paper_meta_and_table_audit.audit_meta_and_tables` is imported with `importlib` when that module exists. Its signals are stored on `deterministicTriage.metaAndTableAudit` and copied as `metaTableSignals`. The module is not a tracked source, so this bundle runs before and after it lands.
- **Tracked figure forensics.** `paper_figure_forensics.py` is part of `TRACKED_SOURCES`. `composite_subpanel_duplicate` and `axis_scale_distortion` run when `audit_figure_forensics` is called. They do not replace the earlier panel-reuse or chart-claim signals.
- **Quote / Zero-Drop gate.** Post-model enforcement is still `v0.3.9`’s quote gate (`reconcile_candidate_ledger`, one repair turn, downgrade of ungrounded defect quotes). That is the same Zero-Drop and quote contract `finalize_blue_report` enforces for PDF-backed reports. Predecessor bundles are not edited.

## Local Profile Build & Offline Testing
```powershell
python app/examples/evidence_blue_v041/build_profile.py
python -m unittest discover -s app/examples/evidence_blue_v041 -p "test_*.py" -v
```
`test_offline.py` uses standard-library `unittest` only. Transports stay injected; tests do not open the network.
