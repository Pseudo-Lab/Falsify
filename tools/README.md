# 러너용 도구

**파이썬이 없어도 됩니다.** `docs/prompts/` 의 프롬프트를 어떤 챗봇에든 붙여 넣으면 아래
도구와 같은 일을 할 수 있습니다. 여기 도구는 같은 일을 손 안 대고 반복하려는 분을 위한 것입니다.

막히면 혼자 붙들지 말고 🙋 이슈나 카톡에 올려 주세요. 같은 데서 막히는 분이 대개 더 있습니다.

## 준비

파이썬 3.10 이상. 의존성은 `requests` 하나입니다 (검사를 돌릴 때만 `pytest`).

```bash
pip install -r requirements.txt
```

`til_collect.py` 만 GitHub CLI(`gh`)가 더 필요합니다. https://cli.github.com 에서 설치하고
`gh auth login` 을 한 번 해 두세요.

## 한 줄 명령

| 할 일 | 명령 |
|---|---|
| 논문 제안 전에 라이선스 확인하고 📄 이슈 본문 만들기 | `python tools/propose_paper.py PMC12215570` |
| 논문 원문 받기 (Red, Blue 공통) | `python tools/fetch_paper.py PMC12215570` |
| 패치를 원문에 적용해 변조본 만들기 (Red 자가 확인, Blue 판정 준비) | `python tools/apply_patch.py corpus/raw/PMC12215570.md submissions/w3/team-a/PMC12215570.diff -o work/PMC12215570.tampered.md` |
| Blue 판정을 집계하고 논문별 다음 수 정하기 (집계 당번) | `python tools/score.py results/w4/ --keys ../Falsify-keys/w3 --papers corpus/papers.csv` |
| 마무리 한마디 모으기 (빌더) | `python tools/til_collect.py --week 3 --members 9` |

식별자는 PMCID(`PMC12215570`), arXiv 번호(`2402.06196`), DOI(`10.1001/...`, 제안 도구만) 를 받습니다.

## propose_paper.py

Europe PMC(또는 arXiv)에서 라이선스, 제목, 학술지, 연도, 표 수, 참고문헌 수, 임상시험 등록번호
(NCT, DRKS, ISRCTN, KCT), 코드 저장소(github.com)를 뽑아 📄 논문 제안 이슈 양식 순서로 출력합니다.
출력을 그대로 이슈에 붙여 넣고 "왜 이 논문인가" 와 "분야" 만 채우면 됩니다.

종료 코드로 라이선스 판정을 알립니다.

| 종료 코드 | 라이선스 | 뜻 |
|---|---|---|
| 0 | CC0, CC BY | 쓸 수 있음 |
| 1 | CC BY-NC, CC BY-SA, 모름 | 확인 필요. 빌더와 함께 봅니다 |
| 2 | CC BY-ND, CC BY-NC-ND, arXiv 기본 라이선스 | 쓸 수 없음. 개작이나 재배포가 막혀 있습니다 |

라이선스 출처는 Europe PMC `search` API 의 `license` 필드, arXiv 는 OAI-PMH 의 `license` 입니다
(arXiv 의 Atom API 에는 라이선스가 없습니다).

## fetch_paper.py

원문을 `corpus/raw/<id>.md` 로, 메타데이터(제목, 저자, 라이선스, 출처 URL, 받은 시각 KST, 표와
참고문헌 수)를 `corpus/raw/<id>.meta.json` 으로 저장합니다.

- PMCID: Europe PMC 의 전문 XML(JATS)을 마크다운으로 옮깁니다. OT 시연 때 쓴 변환과 같은 모양입니다.
- arXiv: HTML 판이 있으면 그것을 옮기고, 없으면 초록만 남깁니다 (그때는 메시지로 알립니다).

`corpus/raw/` 는 저장소에 올리지 않습니다. 원문은 각자 받습니다.

## apply_patch.py

unified diff 를 원문에 적용합니다. `patch` 명령이 없는 환경에서도 돌아갑니다.

- 변조본 머리에 경고 블록을 넣습니다. 원본 id 는 원문 옆의 `<id>.meta.json` 에서 읽습니다.
- 앞쪽에 줄이 끼어 위치가 밀려도 문맥이 맞으면 적용합니다.
- 실패하면 몇 번째 hunk 가 어디서 어긋났는지 보여 주고 종료 코드 1 로 끝납니다. 결과 파일은 만들지 않습니다.
- `--reverse` 로 변조본에서 원문으로 되돌릴 수 있습니다.

패치를 만드는 쪽(Red)은 `diff -u corpus/raw/PMC12215570.md work/PMC12215570.tampered.md > PMC12215570.diff`
처럼 만들면 됩니다 (변조본의 경고 블록은 빼고 비교하세요).

## score.py

`results/wN/` 의 Blue CSV 를 모아 `benchmark/wN.json` 과 표를 냅니다.

CSV 열은 고정입니다. 빠진 열이 있으면 어느 열인지 알려 주고 종료 코드 2 로 끝납니다.

```
paper_id, team, judge_type, model, iteration, location, defect_type, label, evidence, time_sec, tokens, is_holdout
```

- `label` 은 맞음 / 아님 / 확인필요.
- `location` 은 줄 번호(`L142`)를 권합니다. 정답과 **±2줄** 안이면 같은 위치로 봅니다
  (패치로 줄이 밀릴 수 있어서). 줄 번호가 아니면 글자가 같아야 합니다.
- `iteration` 은 판정 회차. 논문마다 팀마다 **마지막 회차의 행만** 제출로 봅니다.

내는 것: 논문별과 전체 재현율, 정밀도, 유보율(확인필요 비율), 홀드아웃 거짓양성률, 팀 간
일치도(두 팀 이상이 같은 논문을 판정하면 결함 위치 단위 Cohen's kappa), 회차별 재현율.

논문별 다음 수는 승급 루프 규칙대로입니다.

| 결과 | 다음 수 |
|---|---|
| 확인필요가 절반 넘음 | `human_review` 사람 재판정 |
| 놓친 결함이 있음 | `blue_rematch` Blue 재방어 |
| 다 잡았는데 오탐 있음 | `blue_precision` Blue 정밀도 수정 |
| 다 잡았고 오탐 0, 반복 1회 | `red_up` Red 승급 |
| 다 잡았고 오탐 0, 반복 2회 이상 | `hold` 승급 보류 |
| 홀드아웃 논문 | `holdout` 오탐 수만 봅니다 |

홀드아웃 논문(`papers.csv` 의 `role=holdout`)에 찍힌 맞음은 정의상 전부 오탐이라 재현율 분모에는
안 들어가고 거짓양성률과 정밀도 분모에만 들어갑니다.

## til_collect.py

매주 모임 끝의 "마무리 한마디" 스레드를 모읍니다. Discussion(카테고리 "마무리 한마디", 제목
`[W3] 마무리 한마디`)과 Issue(라벨 `til`, 제목에 `[W3]`) 둘 다 찾아봅니다.

- 댓글마다 작성자, 시각(KST), 종류(💡 알게 된 것, 🧱 막힌 것, ➡️ 다음에 할 것, 💬 그 밖의 말, 없으면 기타), 본문.
- 스레드 본문(빌더의 첫 글)도 한 줄로 칩니다.
- `benchmark/til/w3.json` 과 `benchmark/til/til_by_person.md` (사람별로 주차 순 누적. 같은 주차를 다시 돌리면 그 주차만 바꿔 끼웁니다).
- 참여 인원 분모는 `--members 9` 또는 `corpus/members.txt` (한 줄에 login 하나).

## 검사

```bash
pytest -q              # 녹화된 응답으로만 돈다 (네트워크 불필요)
pytest -q -m network   # 실제 Europe PMC, arXiv, gh 를 부른다
```

녹화 응답은 `tests/fixtures/` 에 있습니다. 참값으로 쓴 논문은 다음과 같습니다.

| 파일 | 무엇 | 참값 |
|---|---|---|
| `europepmc/PMC12215570.*` | JAMA Netw Open 2025 편두통 앱 RCT (OT 시연 논문) | CC BY, 표 3, 참고문헌 30, DRKS00024174 |
| `europepmc/PMC12703818.*` | EFSA Journal 2025 In Memoriam | CC BY-ND (쓸 수 없음, 종료 코드 2) |
| `europepmc/PMC12853249.*` | Ultrasonography 2025 심사위원 감사문 | CC BY-NC (확인 필요, 종료 코드 1) |
| `arxiv/2402.06196.*` | Large Language Models: A Survey | CC BY 4.0, HTML 판 있음 |
| `arxiv/1706.03762.*` | Attention Is All You Need | arXiv 기본 라이선스 (종료 코드 2) |
| `patch/*` | 세 줄을 바꾸는 가짜 논문과 diff | 적용 후 역적용하면 원문과 같다 |
| `score/*` | Blue 두 팀, 정답 4건, 홀드아웃 1편 | 재현율 0.75, 다음 수 blue_rematch |
| `til/*` | 댓글 5개(이모지 3개)와 빌더 글 | 💡2 🧱1 ➡️1 💬0 기타2, 9명 중 5명 |
