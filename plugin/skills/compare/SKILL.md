---
name: compare
description: "Falsify: compare a finished Blue run with an answer key and write a side-by-side document (human only, never in a blind session). Example: /falsify:compare runs/paper/blue-run1 ../falsify-keys/key.md"
argument-hint: "<blue run folder> <answer key file (.md, .json, .csv, .txt)>"
disable-model-invocation: true
allowed-tools:
  - Bash(python "${CLAUDE_PLUGIN_ROOT}/tools/main_compare.py" *)
---

You are comparing a finished Blue run with its answer key. This is not a blind session: you will see the answers. Do not start or continue a Blue run in this session afterwards.

## Steps

1. Run `python "${CLAUDE_PLUGIN_ROOT}/tools/main_compare.py" show $ARGUMENTS`. It prints the run info, the answer key and the Blue result. If it ends with `ERROR`, show the message as is and stop. Do not open the key or any file outside the run folder with other tools.
2. Write the comparison, in Korean, to the draft path the command printed (`<run>/work/compare_draft.md`), following the structure below.
3. Run `python "${CLAUDE_PLUGIN_ROOT}/tools/main_compare.py" save <blue run folder>`. It moves the draft out of the workspace, next to the keys.
4. Tell the user in Korean: where the file is, the three counts from section 1, and the open decisions from the last section. Remind them it is your reading of two documents and each line needs a human check.

## How to match

- Work from the key's own definitions: its list of planted defects, its acceptance criteria per defect, and any lists of original-paper discrepancies or deliberate traps. Do not invent criteria the key does not state.
- A Blue row matches a planted defect when it points at the same sentence, number or reference entry **and** describes the same problem. Same page or same type alone is not a match.
- One planted defect can be matched by at most one Blue row; if several rows report it, name them all in that defect's line.
- Keep three outcomes apart: flagged as a defect, flagged as `확인필요`, not reported. Do not decide for the human whether a `확인필요` row counts.
- Quote only what is in the two documents. Do not use outside knowledge about the paper and do not look anything up.
- No scores: no recall, precision, points or grades. Counts of the three outcomes are fine.

## Document structure (all headings and text in Korean)

```
# 정답 대조: <paper> · <run>

**정답이 들어 있습니다. 채점 전에는 Blue에게 공유하지 않습니다.**
**Claude가 두 문서를 읽고 대응시킨 것입니다. 점수가 아니며, 각 줄은 사람이 확인해야 합니다.**

- 정답지 / Blue 결과 / 실행 정보(모델, 추론 강도, 분, 프롬프트 해시, 조회 허용 여부) / 대조한 날

## 1. 한눈에 보기
심은 결함 N개 가운데 결함으로 지적한 것, 확인필요로 지적한 것, 놓친 것의 개수.
대응되지 않는 Blue 행의 개수.

## 2. 심은 결함별 대조
표: 정답 ID | 난이도 | 위치 | 심은 내용 | Blue 행 | Blue의 유형 | 대조 결과 | 근거
대조 결과는 `찾음` / `확인필요로 지적` / `놓침` 가운데 하나. 위치는 맞는데 이유가 다르면 `찾음(이유 다름)`.
근거 칸에는 Blue가 무엇과 대조했는지, 정답지의 인정 기준과 같은지 다른지를 적는다.

## 3. 심은 결함과 대응되지 않는 Blue 행
표: Blue 행 | 유형 | 쪽 | Blue의 지적 | 정답지에서의 위치 | 메모
정답지에 "원문에 원래 있는 어긋남"이나 "오탐 유도 요소" 목록이 있으면 거기에 해당하는지 적는다.

## 4. 정답지의 다른 목록을 Blue가 어떻게 다뤘나
정답지에 원문 기존 어긋남, 오탐 유도 요소 같은 목록이 있을 때만. 항목마다 Blue가 결함으로 올렸는지,
기각한 후보에 적었는지, 언급하지 않았는지. 목록이 없으면 이 절은 "정답지에 해당 목록 없음"이라고만 쓴다.

## 5. 사람이 정할 것
확인필요 행의 인정 여부, 오탐인지 원 논문의 표현인지 갈리는 행, 정답지에 추가할 후보 등.
```
