# Changelog

## 0.2.0-alpha.72

- Add PRISMA participant/record flow, forest-plot study weight sum, Cochran's `Q`/`I²` heterogeneity, inverse-variance pooled effect, and cross-table `N` auditor (`app/local/paper_meta_and_table_audit.py`, `falsify.meta-and-table-audit.v1`), wired into `paper_blue_sensor.py`, `paper_mcp.py` (`audit_meta_and_tables`, `run_blue_sensor`), and `falsify_cli.py blue scan --meta-tables`.
- Add offline PDF hidden-text (`Tr=3`, near-white/zero-opacity, micro-font, off-page, with scanned-OCR overlay exemption) and prompt-injection auditor (`app/local/paper_pdf_security_forensics.py`, `falsify.pdf-security-forensics.v1`, exempting visible quotes in AI-security manuscripts), expand `paper_figure_forensics.py` with intra-image `composite_subpanel_duplicate` and `axis_scale_distortion` checks, and add portable `BLUE Evidence v0.4.1` (`app/examples/evidence_blue_v041`) without modifying frozen `v031`–`v040` bundles.
- Add surgical structure-preserving `.xlsx` (`xlsx-cell` with optional `afterFormula` + untouched-workbook byte identity) and `.ipynb` (`ipynb-cell` source/output/execution_count) RED mutator (`app/local/paper_supplement_mutator.py`, `paper_red_mcp.py`, `paper_red_detectability.py`, `falsify red apply --out-supplement-dir`), wire `redBrief` onto `paper_red_mcp.py:plan_coordinated_mutation`, add `L4` semantic `D3`/`S1`/`D5` templates, and add portable autonomous `RED Injector v0.4` (`app/examples/adversarial_red_v04`) without modifying `adversarial_red_v01`–`v03`.
- Add content-addressed, answer-key-free, path-free LRU `EvidenceCache` (`app/local/paper_evidence_cache.py`, `falsify.evidence-cache.v1`, `--cache-dir`), expand `paper_mcp_workspace.py` (`triage_workspace`) with `.xlsx`/`.ipynb` pairing plus `flow_triage` and `internal_consistency` ranking, and add `SARIF 2.1.0` export + 13-schema machine-readable catalog (`app/local/paper_sarif_export.py`, `--sarif`, `falsify schemas`).
- Add multi-contender `N × M` RED-vs-BLUE round-robin tournament with Laplace-smoothed Bradley-Terry MM + batch Elo + Pareto frontier (`tools/evaluation/arena_tournament.py`, `falsify.arena-tournament.v1`, `falsify arena tournament`), heterogeneous multi-BLUE consensus & minority-defect `확인필요` preservation (`tools/evaluation/blue_ensemble.py`, `falsify.blue-ensemble.v1`, `falsify blue ensemble`), `--checkpoint-dir`/`--resume`/`--max-total-seconds` on `arena_campaign.py` (`falsify arena evolve`), and synchronize all 3 Agent Skills.
- Expand `tools/evaluation/benchmark_suite.py` (`falsify arena benchmark`, `falsify.benchmark-report.v1`, `corpusVersion = "v4"`) from 24 to 32 synthetic cases (18 Gold including PRISMA flow, Cochran's `Q`/`I²`, hidden white-text prompt injection, and composite subpanel clone + 14 Benign-Trap Holdout including balanced PRISMA, scanned OCR overlay, AI-security visible discussion, and broken-axis chart).

## 0.2.0-alpha.71

- Add stdlib-only Excel workbook (`.xlsx` multi-sheet OpenXML + `<f>` formula vs cached `<v>` check, XXE/ZIP-bomb hardened) and Jupyter/Quarto notebook (`.ipynb`, `.Rmd`, `.qmd`) loader (`app/local/paper_tabular_notebook_loader.py`), expanding `paper_mcp_bundle.py`, `paper_raw_dataset_audit.py` (`xlsx_formula_value_mismatch`), `paper_code_audit.py` (`notebook_out_of_order_execution`, `notebook_output_prose_mismatch`, never executing cells/macros), `paper_supplement_audit.py`, and `falsify_cli.py`.
- Add IMRaD cross-section sample-size, metric, and protocol consistency auditor (`app/local/paper_internal_consistency.py`, `falsify.internal-consistency.v1`: deterministic `signals` separated from advisory `triageHints`), wired into `paper_blue_sensor.py`, `paper_mcp.py` (`audit_internal_consistency`, `run_blue_sensor`), `falsify_cli.py blue scan --internal-consistency`, and portable `BLUE Evidence v0.4.0` (`app/examples/evidence_blue_v040`) without modifying frozen `v031`–`v039` bundles.
- Expand RED coordinated mutation planner (`app/local/paper_red_planner.py`, `paper_red_detectability.py`) with vector `chart-shape` (`bar`/`scatter`/`curve`) + prose + table/supplement 3-surface `L3`/`L4` bundle synthesis, closed-loop `redBrief` family/surface prioritization (`falsify red plan --red-brief`), and portable autonomous `RED Injector v0.3` (`app/examples/adversarial_red_v03`) without modifying `adversarial_red_v01`–`v02`.
- Upgrade `blue_report_validate.py` with `.xlsx` `(Sheet, Cell)` / `.ipynb` cell / `.Rmd` / `.qmd` quote verification and one-shot `finalize_blue_report` (`falsify.blue-report-finalize.v1`, `falsify blue finalize`: quote repair application + Zero-Drop restoration + unverified quote auto-downgrade to `확인필요`), and synchronize repo-native Agent Skills (`falsify-blue-auditor`, `falsify-red-injector`, plus new `.agents/skills/falsify-arena-operator/SKILL.md`).
- Upgrade `arena_round.py`, `arena_duel.py`, and `arena_campaign.py` (`falsify arena duel`, `falsify arena apply-patch --compact-rules`, `falsify arena evolve --role blue|red|both`) with alternating RED+BLUE co-evolution (`finalBlueHarness` + `finalRedHarness`), Pareto non-regression promotion (`recall` + `holdoutPureFp == 0` + `stealthYield`), and rule deduplication/compaction (`compact_harness_rules`).
- Expand `tools/evaluation/benchmark_suite.py` (`falsify arena benchmark`, `falsify.benchmark-report.v1`, `corpusVersion = "v3"`) from 18 to 24 synthetic cases (14 Gold including `.xlsx` formula mismatch, `.ipynb` out-of-order/leakage, and IMRaD drift + 10 Benign-Trap Holdout including clean multi-sheet `.xlsx`, ordered `Pipeline` `.ipynb`, and explicit per-protocol subsample `n =`).

## 0.2.0-alpha.70

- Add deterministic CONSORT participant-flow arithmetic auditor (`consort_flow_mismatch`, `arm_allocation_sum_mismatch`, `subgroup_denominator_mismatch`, `category_sum_mismatch`) and strictly separated `D3`/`S1` semantic spin-triage hints (`app/local/paper_flow_and_spin_triage.py`, `falsify.flow-spin-triage.v1`), wired into `paper_blue_sensor.py`, `paper_mcp.py` (`audit_flow_and_spin`, `run_blue_sensor`), and `falsify_cli.py blue scan --flow-triage`.
- Add static-only AST/regex code supplement auditor for `.py`/`.R`/`.Rmd`/`.sql` (`app/local/paper_code_audit.py`, `falsify.code-audit.v1`: `code_tailness_mismatch`, `code_preprocessing_leakage`, `code_hardcoded_threshold_mismatch`, `code_undisclosed_row_filter`, never executing scripts), wired into `paper_mcp.py` (`audit_code_supplements`), `falsify_cli.py blue scan --audit-code`, and portable `BLUE Evidence v0.3.9` (`app/examples/evidence_blue_v039`) without modifying frozen `v031`–`v038` bundles.
- Add multi-surface `L3`/`L4` coordinated RED mutation planner (`app/local/paper_red_planner.py`, `falsify.red-plan.v1`), `falsify_cli.py red plan` & `red apply --out-supplement-dir` + `mcp-config --role red|both --supplement`, and portable autonomous `RED Injector v0.2` (`app/examples/adversarial_red_v02`) synthesizing stealth-verified PDF + supplement blind bundles alongside sealed `falsify.red-gold-ledger.v1` ledgers without modifying `adversarial_red_v01`.
- Upgrade `blue_report_validate.py` and `falsify_cli.py blue validate` with PDF ligature (`ﬁ`/`ﬂ`/`ﬀ`/`ﬃ`/`ﬄ`), soft/line-wrap hyphen, minus (`−`), smart-quote, and `µ`/`μ` typographic folding (`status == 'normalized'`) plus `--emit-repair-pack PATH` (`falsify.quote-repair-pack.v1`, answer-key scrubbed).
- Expand `paper_mcp_workspace.py` and `falsify_cli.py blue scan-workspace` with multi-paper automatic supplement pairing (`<stem>_supp*`, `supplements/<stem>/*`, answer-key masked) and ranked batch Layer 0 `triage_workspace` (`falsify.workspace-triage.v1`).
- Add multi-generation unattended co-evolution campaign runner (`tools/evaluation/arena_campaign.py`, `falsify.arena-campaign.v1`, `falsify arena evolve`, `generations <= 3` cap, Holdout FP guard, raw/code supplement signal scoring in `arena_runner.py`) and expand `tools/evaluation/benchmark_suite.py` (`falsify arena benchmark`, `falsify.benchmark-report.v2`) to 18 synthetic cases (11 Gold across `W1–W5`, raw CSV, `.py` leakage, CONSORT flow + 7 Benign-Trap Holdout cases including ligatures, pipeline-scoped CV scaling, and missingness footnotes).

## 0.2.0-alpha.69

- Add row-level raw dataset statistical recomputation auditor (`app/local/paper_raw_dataset_audit.py`, `falsify.raw-dataset-audit.v1`) recomputing `N`, non-missing `n`, group-by `mean ± SD`, `median [IQR]`, `k/n (%)`, Welch/Student `t`-test and 2×2 Fisher/chi-square `p` from `.csv/.tsv/.json` supplements (exempting adjusted `aOR`/`aRR`/`aHR` and multiplicity-corrected `FDR`/`Bonferroni` `p_adj`), wired into `paper_mcp.py` (`recompute_raw_supplement`) and `falsify_cli.py blue scan --recompute-raw`.
- Expose `paper_figure_forensics.audit_figure_forensics` on `paper_mcp.py` (`audit_figures` + `run_blue_sensor(..., includeFigureForensics=...)`) and `falsify_cli.py blue scan --figure-forensics`, and add portable `BLUE Evidence v0.3.8` (`app/examples/evidence_blue_v038`) combining raw-dataset triage with post-model Zero-Drop restoration and a 1-turn quote-repair / ungrounded-quote downgrade gate without modifying frozen `v031`–`v037` bundles.
- Expose `paper_red_detectability.py` on `falsify_cli.py` (`red simulate`, `red trace`), enforce `--min-difficulty L1|L2|L3|L4` pre-export gating on `red apply` (exiting `3` with `difficulty_below_minimum` without writing `--out-pdf`), and add portable autonomous `RED Injector v0.1` (`app/examples/adversarial_red_v01`) emitting a stealth-verified blind bundle plus a sealed `falsify.red-gold-ledger.v1` ledger.
- Upgrade `blue_report_validate.py` and `falsify_cli.py blue validate` with repeatable `--supplement PATH` quote verification across `.csv/.tsv/.json/.md/.txt/.log/.py/.r/.sql/.pdf/.docx` (with supplement `nearestCandidates` and exit `3` on forbidden RED keys), and upgrade `falsify_cli.py mcp-config` with standalone `--workspace DIR` and `--role blue|red|both`.
- Add unattended RED-vs-BLUE duel orchestrator and generation-capped (`max_generations <= 3`) harness patch applier with Holdout Rollback Guard (`tools/evaluation/arena_duel.py`, `falsify arena duel`, `falsify arena apply-patch`), plus a 10-case deterministic synthetic regression benchmark suite (`tools/evaluation/benchmark_suite.py`, `falsify arena benchmark`: 6 Gold `W1–W5` cases + 4 Benign-Trap Holdout cases).

## 0.2.0-alpha.68

- Add BLUE supplement-table arithmetic audit (`supplement_table_sum_mismatch`, `supplement_table_percentage_mismatch`) and a figure/panel forensic sensor (`app/local/paper_figure_forensics.py`, `falsify.figure-forensics.v1`) that detects dHash/aHash duplicate, horizontally mirrored, 180-degree rotated and centred-crop panel pairs plus chart printed-value vs prose mismatch candidates with bboxes; `paper_blue_sensor.run_blue_sensor` exposes it behind the opt-in `include_figure_forensics` flag.
- Add RED detectability simulation and claim propagation (`app/local/paper_red_detectability.py`): `simulate_red_detectability` diffs Layer 0 signals between the source and the in-memory edited copy and classifies L1-L4 cross-inference distance and exposure risk (D3/S1 remain L4 because Layer 0 has no detector for them), and `trace_claim_propagation` locates one claim across prose, tables, figures, citations and supplements. Every mutation failure now returns `{error, actualValue, nearestCandidates, bbox, recoveryHint}` without path leakage (`app/local/paper_red_errors.py`).
- Add `falsify blue validate` (`app/local/blue_report_validate.py`): verbatim quote gate with normalized and nearest-candidate fallback, Zero-Drop restoration ported from the web app, 12-column arena CSV normalization, exit code `3` while a missing quote survives; add `falsify mcp-config` stdio client configuration output for Claude, Codex and Gemini.
- Add read-only multi-document MCP mode (`app/local/paper_mcp_workspace.py`, `python app/local/paper_mcp.py --workspace DIR`): bounded 32-paper scan, answer-key filename masking, `list_papers`/`select_paper` selection, path-escape refusal and no absolute-path payloads; the single `--pdf` mode is unchanged.
- Add an unattended arena round runner and answer-key-free distiller (`tools/evaluation/arena_round.py`, `falsify.arena-round.v1` / `falsify.harness-patch.v1`): leak-gated cleanroom containing only the blind bundle, arbitrary stdio agent commands through `harness_adapter`, multi-run scoring via `evaluate_arena_match`, and failure-to-rule distillation with a fail-closed scrubber; exposed as `falsify arena run-round` and `falsify arena distill`.

## 0.2.0-alpha.67

- Upgrade Read-Only BLUE MCP (`app/local/paper_mcp.py`, `app/local/paper_mcp_bundle.py`) with offline `run_blue_sensor` (`digestOnly` token-budget mode), repeatable `--supplement PATH` bundle tools (`list_supplements`, paginated `read_supplement`, `audit_supplements`), and explicit opt-in `--oracle` `P2` tools (`verify_references`, `verify_registries`).
- Add autonomous `BLUE Evidence v0.3.7` runner (`app/examples/evidence_blue_v037`) prepending a zero-model-cost deterministic Layer 0 Triage Digest (`SPRITE`/`2×2`/`KM` stats, `supp-*` cross-file audit, offline registry checks) and extended `P2` retraction & `OSF`/`PROSPERO`/`GEO`/`PDB` grounding (`<= 18,000` chars) without modifying frozen `v031`–`v036` bundles.
- Expand Coordinated RED MCP (`app/local/paper_text_span_mutator.py`, `app/local/paper_red_mcp.py`) to full-modal stealth authoring with native PDF prose `text-span` inspection/mutation (`list_text_spans`, glyph-only redaction, baseline-aligned font fitting, self-healing `SpanMutationError` `nearestCandidates` & `recoveryHint`), `supplement-edit` (`--supplement`, `list_red_supplements`), `baselineOverlaps` (`Baseline Guard`), and sealed `goldLedger` (`falsify.red-gold-ledger.v1`).
- Add unified headless Agent JSON CLI (`app/local/falsify_cli.py`: `blue scan`, `red targets`, `red apply`, `blind verify`, `arena score` with `--digest-only` `< 12 KB` budget and deterministic exit codes `0`/`2`/`3`/`124`) and repo-native Agent Skills (`.agents/skills/falsify-blue-auditor/SKILL.md`, `.agents/skills/falsify-red-injector/SKILL.md`).
- Add headless Co-Evolution Arena evaluator and blind-bundle verifier (`tools/evaluation/arena_runner.py`: `verify_blind_bundle` across DocInfo/XMP/annotations/AcroForm/supplements with source-inherited exemption, plus `evaluate_arena_match` 1-to-1 bipartite matching, `Baseline Guard` `preExistingExempted`, `W1–W5`/`D1–D7`/`L1–L4` stratified recall, `stealthYield`, `Krippendorff's α`, `AURC`, and `feedbackDigest`).

## 0.2.0-alpha.66

- Convert `app/tests/test_paper_supplement_audit.py` from `pytest` to standard-library `unittest.TestCase` so GitHub Actions Ubuntu `python -m unittest discover -s app/tests -p 'test_*.py'` runs cleanly without external test runners and deploys GitHub Pages.

## 0.2.0-alpha.65

- Fix companion HTTP `supplement_audit` page-text extraction in `paper_evidence_http.py` (`_require_bound_pdf` + `_open_pdf` instead of unsupported `kind='page'` on `EvidenceStore.list_items`) and add end-to-end HTTP adapter regression test in `test_paper_supplement_audit.py`.

## 0.2.0-alpha.64

- Add BLUE multi-file supplement/code/log bundle cross-verification (`blue-supplement-bundle.js`, `paper_supplement_audit.py`, `paper_evidence_http.py`, `document-blue.js`) detecting orphan cited `Table S*`/`Fig. S*` items (`D4-1`), cross-file `N=` sample-size mismatches (`D1`), and main-vs-supplement metric contradictions (`D1`) while seamlessly attaching `supp-*` segments to local and external BLUE runs.
- Expand Layer 0 deterministic statistical & clinical forensics (`paper_stat_math.py`, `paper_stat_audit.py`, `blue-defect-sensor-core.js`) with bounded `SPRITE` mean/SD/N/min/max feasibility, 2×2 contingency table (`a/N1 vs c/N2`) exact Fisher `p` / Pearson & Yates `χ²` / crude `OR`·`RR` verification (exempting adjusted `aOR`/`aRR`), and Kaplan-Meier `Number at risk` monotonicity checks across Python and offline browser `P0`.
- Add `P2` retracted/expression-of-concern citation detection (Crossref `update-to`/`relation` + Europe PMC `Retracted Publication`) and `OSF` (`osf.io/...`), `PROSPERO` (`CRD420...`), `GEO` (`GSE...`), and `PDB` structural `P0` + fixed-host TLS `P2` registry verification (`paper_external_grounding.py`, `paper_registry_identifiers.py`, `paper_blue_sensor.py`).
- Add RED pre-injection `Baseline Guard` source flaw & candidate-overlap scanner plus pixel-preserving lossless PDF `/URI` hyperlink mutator (`W5 D2-1`·`D2-3`) across browser (`red-baseline-uri.js`) and Coordinated RED MCP (`paper_uri_mutator.py`, `paper_red_mcp.py` `scan_source_baseline`, `list_pdf_links`, and `uri-link` operations) with strict blindness leak rejection.
- Upgrade Co-Evolution Arena (`coevolution-arena.js`) and `tools/evaluation/agreement_selective.py` with exact nominal & ordinal `Krippendorff's α` multi-rater / multi-run agreement and `확인필요` selective prediction (`Abstention Rate`, `Selective Accuracy`, `Abstention Gain`, `Risk-Coverage Curve`, `AURC`).

## 0.2.0-alpha.63

- Fix `#blue-defect-sensor` panel class in `blue-defect-sensor-ui.js` so `visual-workflow.js` `:scope > .role-step` keeps `[intake, execute, result]` indices intact, keeping `#blue-defect-sensor` visible directly below BLUE intake and keeping `#doc-blue-request` visible after `BLUE로 보내기` in `latex-source.browser.cjs` CI & GitHub Pages deployment.

## 0.2.0-alpha.62

- Implement Confluence-grounded Cops-and-Robbers (`BLUE` blind defect verifier vs `RED` defect-injection stress tester) v2 co-evolution architecture across RED, BLUE, Human Audit (`H1`), and Co-Evolution Arena (`A1`).
- Separate RED oracle-based defect families (`D1` numeric/table/chart mismatch, `D2` citation/bibliography/URI distortion, `D3` claim-exceeding-evidence/spin, `D4-1` outcome status mislabeling, `S1` domain polarity/mechanism inversion) from `L1`–`L4` stealth difficulty, and enforce a pre-export Blindness Leak Gate (`adversarial-taxonomy.js`, `document-red-core.js`, `red_service.py`, `paper_stealth_audit.py`).
- Add Layer 0 deterministic BLUE forensic sensor (`paper_blue_sensor.py`, `blue-defect-sensor-core.js`, `blue-defect-sensor-ui.js`) covering `P0` offline stat/citation checks, PDF `/URI` vs printed DOI/URL mismatches, `AcroForm` widget inspection, multiple-testing adjusted `p`-value guard (`paper_stat_audit.py`), and opt-in `P2` external oracle comparison (Crossref/Europe PMC/DataCite/`ClinicalTrials.gov`).
- Introduce External BLUE Two-Stage Zero-Drop protocol (`prompt-instructions.js`, `external-exchange.js`, `external-proposals.js`, `external-blue-ui.js`) separating `검증됨_이상없음` audit rows from active defects and auto-recovering silently dropped Stage 1 suspicions as `확인필요`.
- Upgrade `H1` review with 4-way non-gold precision audit (`pre-existing`, `spin-boundary`, `gold-error`, `unsupported`) and add `A1` Co-Evolution Arena (`coevolution-arena.js`) with `P0`/`P2`/`Holdout` Strict+Inclusive dual scoreboards, same-family model bias warnings, repeat-run flip tracking, `tools/evaluation/score.py` 12-column CSV + Red JSON export, and answer-key-free `C1` Harness briefs.

## 0.2.0-alpha.61

- Add deterministic BLUE statistical & arithmetic pre-audit (`paper_stat_math.py`, `paper_stat_audit.py`, read-only MCP `audit_statistics`) checking exact `z`/`t(df)`/`χ²(df)`/`F(df1,df2)`-to-`p` consistency, `n/N (%)` ratios, GRIM integer granularity, `CI` containment/log-symmetry, and 3-way prose-table-figure value reconciliation.
- Enable multi-chunk BLUE on-demand reread of omitted structured tables/figures (`evitem:<itemId>`), raise verified `visualEvidence` PNG cap to 6 across Codex, Claude Code (`stream-json`), and opt-in `stdio`/`wrapper` harnesses, and add Two-Stage Auto-Crop Visual Reread (`autoVisualReread`).
- Upgrade built-in RED with span-occurrence (`occurrence`) targeting for repeated literals, `paperEvidence`-bound multi-modal `table-cell`/`chart-point` candidates, PDF forensic/stealth self-audit (`paper_stealth_audit.py`), and Coordinated RED MCP (`paper_red_mcp.py`) while keeping exported PDFs strictly blind.
- Add full-bibliography Crossref/Europe PMC ghost/Chimera DOI verification + citing-sentence abstract grounding (`paper_external_grounding.py`), `ClinicalTrials.gov` v2 registry primary-outcome/enrollment comparison (`paper_clinical_trials.py`), and portable BLUE `v0.3.6` (`app/examples/evidence_blue_v036`) without altering frozen `v031`–`v035` bundles.

## 0.2.0-alpha.60

- Fix cross-platform Linux CI provenance verification test execution (`[process.execPath, fakeEmcc]`) for the `0.2.0-alpha.59` Wave 1 + Wave 2 release so `Publish workbench` completes and deploys GitHub Pages cleanly.

## 0.2.0-alpha.59

- Expand BLUE evidence context to 24,000 characters ranked by scientific relevance, classify repeated header/footer logos and icons as decorative, and bind multi-grid/multi-page continued tables with units, footnotes and superscripts.
- Add read-only BLUE MCP tools (`read_page_text`, `search_text`, `list_references`), chart printed-value reconciliation, isolated CI error-bar endpoint bounds, and uncalibrated zero-series guards.
- Support nested Form XObject bar/scatter mark isolation, dark-neutral raster curve separation from axes/ticks/text, and structured `table-cell` and `chart-point` external RED edits while keeping blind PDF handoff intact.
- Improve PDF-to-LaTeX numeric figure ordering, bibliography entry separation, verified `\multicolumn`/`\multirow` and two-column long/wide tables, and opt-in line-fit font width guards (`T-0157`).
- Add original LaTeX `.bbl`/multi-bib/`natbib`/`biblatex`/custom-macro analysis and two-column right, full-width and multi-page footnote collision checks (`T-0158`), plus paragraph-vendor `8f3bef6` sync and provenance verification (`sourceBuildVerified: false`).

## 0.2.0-alpha.49

- Edit curve peaks, wells, width and position while retaining source axes, labels and page layout.
- Drag native bar endpoints and scatter markers; keep precise coordinates in collapsed controls.
- Share the pinned Gaussian geometry core between browser editing and RED MCP prepare/preview/export tools.
- Preserve selected native path operands, shared Form occurrences, RGB profiles and image soft masks; patch only changed pixels in opaque raster figures.
- Download directly from the editor, restore byte-identical originals after undo, and hand only the same PDF to BLUE.

## 0.2.0-alpha.48

- Read original PDF line and cubic paths with PyMuPDF and retain source commands, style and page coordinates.
- Route raster curves through pinned WebPlotDigitizer Step/XStep and PlotTracer findLines without refitting user values.
- Preserve short branches, asymmetric error bars, requested/effective ink colors and measured/interpolated provenance.
- Read visible replacements using PDF paint order and share the point/series budget across vector and raster results.
- Verify original path provenance in BLUE and cover the new engine paths in Windows/macOS CI.

## 0.2.0-alpha.47

- Mount RED chart reading after its deferred preview and analysis dependencies load.
- Check the real entry-page script order as well as isolated controller behavior.

## 0.2.0-alpha.46

- Edit extracted table cells and replace selected figure regions in a source-bound PDF copy.
- Redraw line, scatter and bar charts from editable numeric series using pinned Chart.js and optional explicit error bars.
- Add page-region selection, PNG/JPEG replacement, image cropping and labels with before/after previews.
- Record human changes, coordinates and source/output hashes automatically; export a separate JSON record.
- Send only the generated PDF to BLUE and retain the last output when a later edit fails.

## 0.2.0-alpha.45

- Use pinned PlotTracer code for curve extraction and source-bound axis conversion.
- Add four-tick and curve-color correction in the chart preview, with the same options available through MCP.
- Keep missing calibration as a partial result instead of substituting a generated numeric table.
- Run the same JavaScript core in embedded V8 on Windows, macOS and Linux; make the legacy DePlot setup optional.
- Retain full pixel coordinates for MCP/export and compact curve summaries for BLUE's text context.

## 0.2.0-alpha.44

- Separate same-color chart curves and preserve peaks between axis ticks.
- Keep series IDs in tables/CSV and retain complete chart points in BLUE context.
- Preserve source pixels, gaps, sampling error and ambiguous crossings.

## 0.2.0-alpha.43

- 논문 표·그림 구조와 읽기 전용 MCP, 스캔 PDF OCR·그래프 읽기 도구 추가.
- 한국어 띄어쓰기와 Windows OCR 응답 인코딩 수정.
- 원본 눈금 기반 선형·로그·이중 축 곡선 측정과 출처 좌표 제공.
- JSON·CSV 다운로드, 구형 companion 업데이트 안내와 설치 가이드 추가.

## 0.2.0-alpha.42

- AI 배치 도구의 잘못된 명령 복구, 취소와 미접수 처리 수정.
- 저장 순서와 실행 영수증 보존, 이전 PDF를 유지한 실패 요청 복구 수정.
- 긴 원문·기하·자산 조회의 응답 크기와 이어 읽기 계약 수정.

## 0.2.0-alpha.41

- AI 배치 다듬기 진입 시 실행 패널을 펼치고 화면·키보드 포커스를 이동.
- 기준본 전달 준비, AI 검토 대기와 연결 오류를 실행 위치에서 표시.
- 시작 버튼 용어 통일 및 중복 시작·연결 끊김 회귀 검사 추가.

## 0.2.0-alpha.40

- 가로선 논문 표를 원본 영역으로 보존하고 셀 문자열을 원문 문자 범위에 연결.
- 그림–캡션 묶음, 같은 기준선 문장 조각과 하단 쪽번호 분류 수정.
- 생성 PDF의 원본 영역·캡션 연결·표 셀 검사와 화면 요약 추가.
- 실제 7쪽 샘플에서 영역 14개, 캡션 9쌍, 셀 112개 확인. 그림 번호순 배치와 참고문헌 줄 구분은 후속.

## 0.2.0-alpha.39

- PDF 재구성에서 제목·저자·소속·초록·절 제목·각주 위계와 관측한 크기·행간을 조판에 연결.
- 굵기·기울임·첨자 및 숫자 포함 문단의 줄 경계 공백 복원, 수학 기호용 공개 글꼴 보충.
- 기준본의 「AI로 배치 다듬기」로 기존 AI 도구에 원본·기준본 계보를 전달.
- 표 구조·일부 캡션/읽기 순서·전용 아이콘과 내용 충실도 대조는 후속.

## 0.2.0-alpha.38

- AI 레이아웃 편집 도구 23개 연결: 원본 대조, 블록·글꼴·표·그림 조정, 내용 비교와 체크포인트.
- 후보 PDF 보존과 12시간 임시 저장·복구, 소스별 기록 분리 및 단계별 요청 영수증·조회.
- 결과 품질·문제 영역 표시, 원본/후보 비교 캐시와 대응 페이지 찾기, PDF 다운로드·BLUE 전달 개선.
- 단일 단 LaTeX 긴 표의 반복 머리글과 소유권을 확인한 다중 텍스트 셀 지원.
- PDF에서 추정한 병합 셀, 재구성·2단 긴 표와 전체 논문 복원 충실도는 후속 작업.

## 0.2.0-alpha.37

- 저자명 한 단어 편집에서 문단 전체 재배치 대신 원래 글꼴·기준선과 별도 윗첨자를 보존.
- 원문 추출 순서가 다른 문단의 전체 페이지 문자 대조와 이동한 링크 영역 검증 수정.
- [변경 내용](docs/releases/0.2.0-alpha.37.md)

## 0.2.0-alpha.36

- 혼합 서식 숫자 추가 편집과 원문·전체 페이지 텍스트 검증 수정.
- 숫자를 늘렸을 때 기존 링크가 새 숫자 전체를 포함하도록 보존.
- LaTeX ZIP의 시작 파일 기준 경로와 중간 입력 파일의 그림 경로 분석 수정.
- PDF 재구성의 단 분류·세로 간격·꼬리말 예약 영역과 악센트 문자 추출 수정.
- [변경 내용](docs/releases/0.2.0-alpha.36.md)

## 0.2.0-alpha.35

- 본문·윗첨자·링크 색상이 섞인 구간에서 실제 바뀐 문자만 찾아 원래 서식을 유지하도록 수정.
- 저자 줄의 소속 번호와 인용 번호 편집에서 주변 줄을 다시 조판하지 않고 원래 PDF 객체를 유지.
- [변경 내용](docs/releases/0.2.0-alpha.35.md)

## 0.2.0-alpha.34

- LaTeX 프로젝트 입력·소스 구조 편집·브라우저 컴파일과 PDF/BLUE 전달 추가.
- 작업 저장·복구, 변경 표시, 파일 전환 중 오래된 작업의 덮어쓰기 수정.
- PDF→LaTeX 재구성은 고급 옵션의 실험 기능으로 제공.
- [변경 내용](docs/releases/0.2.0-alpha.34.md) / [지원 범위](docs/latex-source-editing-status.ko.html)

## 0.2.0-alpha.33

- 긴 수정문과 마지막 줄 삭제에서 원본 글꼴, 줄 배치와 가림 도형 순서 보존.
- 표와 본문 동시 편집, 표 재조판, 링크와 회전·CropBox 좌표 검사 수정.
- Tab 이동 후 자동 미리보기와 파일 교체 후 상태 초기화 수정.
- [변경 내용](docs/releases/0.2.0-alpha.33.md) / [검증 기록](docs/pdf-editor-repair-20261030.html)

## 0.2.0-alpha.27

- 원문 직접 편집창이 타이핑 직후 닫히는 이벤트 처리 오류 수정.
- 입력창 내부 커서 이동·선택과 한글 조합 중 편집 상태 보존.
- [변경 내용](docs/releases/0.2.0-alpha.27.md)

## 0.2.0-alpha.26

- 원본·수정본의 변경 부분 강조, 삭제 위치 표시, 편집 목록에서 비교 위치로 이동.
- 새 RED 요청의 한국어 근거 기본값과 영어 선택. 인용문은 원래 언어 유지.
- [변경 내용](docs/releases/0.2.0-alpha.26.md)

## 0.2.0-alpha.22

- PDF direct editing, whole-paper recomposition, transparent figure replacement.
- Explicit failure recovery, stable local harness binding and Confluence attempt records.
- [Release notes](docs/release-alpha22.md)

## 0.2.0-alpha.18

- RED 선택 후보를 버튼 한 번으로 PDF에 적용하고 바로 다운로드합니다.
- 알려진 학습용 표시를 편집 전에 제거하고 PDF와 별도 변경 기록을 분리합니다.
- [변경 내용](docs/release-alpha18.md)

## 0.2.0-alpha.17

- 원문·변경 항목에서 바로 편집하고 키보드로 문단을 선택합니다.
- 편집창 배치, 문단 준비, 실패 복구와 보조 도구 노출을 정리했습니다.
- [변경 내용](docs/release-alpha17.md) · [UX 판단 근거](docs/ux-editor-refinement.md)

## 0.2.0-alpha.16

- Add PDF page and region selection for optional visual BLUE input through built-in Codex, with separate observations and bound image references.
- Compare recorded Harness observations only when file, text, visual input, model, budget, rubric and provenance match. Unknown attempts and costs remain unknown.
- Add bounded original-format DOCX, HTML and ODT exports; ODT visual rendering remains unverified.
- Serialize pending admission and updates across tabs with Web Locks; preserve request-bound, GET-only recovery.
- Fix table painted-bounds warnings and transport source-proven FitR destinations through supported document flow.
- Clarify Korean guidance and align Confluence, connection and recovery documentation.

## 0.2.0-alpha.10

- Version the changed role, navigation and Confluence entry assets so browsers load the matching visual workflow implementation after an upgrade. Release packaging rejects stale asset version suffixes.
- The alpha.9 visual workflow, OSS components, storage semantics and regression coverage remain unchanged.

## 0.2.0-alpha.9

- Airport-style visual file intake: drop, paste or pick a paper; actual first-page PDF thumbnail; empty future stages collapse.
- Selected Harness shelf, large play control, compact PC connection, library-first tools and per-item team save without changing either execution selection.
- Team drawer starts user-delegated connection when needed. Explicit destination/consent gates publication; technical details are disclosed on demand.
- Symbolic human verdicts delegate to existing validated records. A real-browser regression covers overall label activation, independent RED/BLUE input, multi-file refusal and responsive layouts.
- Reused GoogleChromeLabs file-drop 1.0.1 and pinned Lucide SVG sources with license/provenance receipts. No new frontend framework. See docs/release-alpha9.md.

## 0.2.0-alpha.8

- Confluence is the only remote archive: explicit team publication of selected experiments, Harnesses and detailed reviews.
- Fetched records open in temporary native review without merging into original local storage; publish draft reviews explicitly to retain them.
- Central user-delegated Atlassian OAuth, stateless bounded relay, immutable hash-checked attachments and legacy write retirement. Existing local and historical database records remain preserved.
- Synthetic real-OAuth and independent-browser-origin roundtrips verified; original/edited PDF bytes are not included in JSON archives. See docs/release-alpha8.md.

## 0.2.0-alpha.7

- Native human review pairs RED before/after and recorded attack intent with all BLUE findings. Changed expressions are marked and quote overlaps displayed first without automatic scoring.
- Per-finding and per-attack judgments/reasons persist with the existing append-only review history and JSON backup; old records remain supported.
- RED-assisted review records its exposure and carries that disclosure into a shared review's overall note. Detailed per-finding/RED comparison remains local, not automatically shared.
- Review requires no companion connection. The connection panel is hidden in this destination; desktop columns stack on small screens. RED-only/BLUE-only use stays independent.

## 0.2.0-alpha.6

- Host-bound evidence references make repeated BLUE selection quotes unambiguous without weakening final grounding.
- Matched BLUE failures remain visible across reload, with explicit request/diagnostic export and discard guidance.
- Experimental BLUE Evidence v0.3.4 uses a self-contained source bundle and preserves immutable inherited audit records.
- Offline controlled-comparison preparation distinguishes machine configuration, strategy, failures and unreviewed findings.
- Source ZIP preservation checks work without Git history. Human gold, full comparison UI and another-PC validation remain pending.

See docs/release-alpha6.md for verification and limitations.

## 0.2.0-alpha.5

- Password change/revoke-all sessions; exact-request RED/BLUE reload recovery and same-page double-click admission.
- Portable BLUE Evidence v0.3.3 sources and per-PC profile generation with explicit external-literature opt-in.
- Quick-first hosted HTML guide, account/recovery documentation, and PDF Editor alpha.6 compatibility.
- Source-only distribution excludes private records, machine profiles and patched editor WASM.

See docs/release-alpha5.md for verification and limitations.

## 0.2.0-alpha.4

- Optional team records in Results: invite-only username/password accounts, private-by-default uploads, explicit team sharing,
  immutable payload versions, owner-only revision-checked changes, and subjective reviews grouped by matching conditions.
- Team harness preview remains separate from registration and local CLI execution. Local papers and records are not
  automatically uploaded or replaced. Server records are client-reported, not execution attestations or scientific scores.
- Worker/D1 source, bounded request and account quotas, salted scrypt password hashes and expiring hashed sessions.
- Shared run summaries exclude private evidence and local IDs on the server, including when listing an owner's records.
- Shared API reads require an active invited-member session. Operator-only invitation issuance/admission/revocation;
  no public admin endpoint. Static GitHub Pages and source remain public, not private hosting.
- Flexible wrapper profiles adapt existing stdio/HTTPS programs: prompt/JSON/template/extracted-text files as input,
  JSON or a single fenced JSON block as output, deterministic pointer/field/array/stage mappings and preview-only builder.
  Original binary PDFs, arbitrary prose interpretation and automatic README-to-wrapper generation are not included.
  Wrapper execution requires a companion advertising support; registration never executes code. See docs/harness-wrapper.md.

Requires a configured shared API. No email/GitHub identity verification, email password recovery, automatic complete
cross-device ledger sync, model execution certification, or causal harness ranking. PDF editor remains 0.1.0-alpha.5.

## 0.2.0-alpha.3

Source-only prerelease. See docs/release-alpha3.md. The separately configured PDF editor is 0.1.0-alpha.5.

- Experiment records separate local-broker runs, manual responses and imported records; a harness-hash mismatch or
  missing hash is shown as an unconfirmed harness and excluded from averages. Model-call correctness stays unknown.
- PDF import warns about glyphs without a Unicode mapping instead of silently using their text.
- PDF export refusals carry fixed refusal codes; regional, typography and reading-order QA gained a bounded
  rigid-run tolerance (0.02 pt, warning only) and a block-order proof for reordered-but-complete text.
- Legacy editor/export fixes in the local companion, with focused regressions.

Not claimed: complete DOCX/ODT/HTML layout output, figure-aware BLUE, a shared database, full-model benchmarks or
AMAS documents being fixed. No arbitrary-PDF, invisibility or scientific performance claims.

## 0.2.0-alpha.2

- Optional manual raster-image placement selection in RED, separate from text candidates and BLUE.
- Source-bound painting IDs and single-occurrence resource isolation, including shared page resources.
- PNG Before/After and experimental-copy consent; PDF and separate rendering-check report downloads.
- Authenticated isolated image service with bounded input, fixed errors and temporary cleanup.

Requires optional image dependencies on Python3.11+. Forms/inline images, complex clipping/masks, vector figures and tables
are outside the initial supported boundary. BLUE remains text-only, and rendering checks are not scientific approval.
See docs/pdf-image-editing.md. Six synthetic shared/inherited placements were each replaced separately: MuPDF and the
configured PDFium runtime found zero changed pixels outside the selected region. This is not arbitrary-paper fidelity or
domain approval. The separate PDF editor remains0.1.0-alpha.4; image writing is an optional companion operation.

## 0.2.0-alpha.1

Source-only prerelease of the Workbench and local companion. The separate PDF editor remains 0.1.0-alpha.4.

- Source-derived text edit plans and independent edited-page/region quality checks.
- Exact downloaded-PDF preview using the verified output bytes, with cancellation and bounded page rendering.
- Optional structure, fixed-area layout and object-occurrence analysis modules, with synthetic regression coverage.
- Explicit authenticated PDF preflight from RED: source inventory, shared-image counts and advisory selected-text layout.
  Does not run a model, authorize a scientific attack, block text export or pass RED information into BLUE.
- Companion version and feature reporting, while retaining old-companion/manual operation compatibility.

Docling ML conversion is not enabled; structure schema compatibility was tested separately. The layout planner is metrics-only,
not a new PDF writer. Object replacement is still a synthetic-only unique-XObject prototype at this release boundary; shared
per-occurrence writing is the next implementation. BLUE remains text-only.

The source archive excludes local environments, private papers/harnesses/records, model artifacts and the locally patched WASM.
Longer PDF export requires the separately configured editor described in docs/pdf-editor.md. Existing user installations must
restart idle companions through the supported launcher; pairing tokens change on restart and browser-local records are retained.
