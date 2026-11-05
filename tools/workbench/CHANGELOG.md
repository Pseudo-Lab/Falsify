# Changelog

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
