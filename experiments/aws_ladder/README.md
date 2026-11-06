# AWS 탐지기 사다리: 1단과 2단

변조본 PDF 하나를 받아 범용 탐지기 두 단에 걸어 보는 스크립트입니다. 결함 유형을 모르는
범용 장치가 어디까지 잡는지를 우리 Blue(3단)와 견주기 위한 밑변입니다.

| 단 | 무엇 | 보는 것 |
|---|---|---|
| 1단 | Amazon Bedrock Guardrails의 근거 일치 검사(contextual grounding check) | 원문과 바꾼 문장을 쌍으로 걸어 점수가 갈리는지 |
| 2단 | Bedrock에서 부르는 범용 모델 | 같은 글을 독립 2회 호출해 판정이 갈리는지 |

**대조군을 함께 거는 것이 핵심입니다.** 바꾼 문장만 걸어 낮은 점수가 나오면 그 숫자가 성능처럼
읽힙니다. 바뀌지 않은 문장을 같이 걸어야 "구별한 것"과 "아무 문장이나 거부한 것"이 갈립니다.

## 맹검

탐지기에 들어가는 글은 **변조본뿐입니다.** 근거 글도 검사 문장도 대조군도 모두 변조본 안에서
나옵니다. 원본은 `--orig` 로만 받고, 그때도 어디가 바뀌었는지를 가리는 데만 쓰며 탐지기
입력으로는 들어가지 않습니다. 라운드가 끝나기 전에는 `--orig` 를 주지 않습니다.

검사 `test_demo.py::test_control_comes_from_the_altered_pdf_not_the_original` 이 이것을 막습니다.

## 준비

```bash
pip install boto3                 # pdfinfo, pdftotext 는 poppler 에 들어 있습니다
export FALSIFY_AWS_PROFILE=<본인 AWS 프로파일>
export FALSIFY_GUARDRAIL_ID=<본인 Guardrail ID>
export FALSIFY_AWS_REGION=us-east-1          # 기본값
export FALSIFY_MODEL_ID=amazon.nova-lite-v1:0 # 기본값. 바꿔 끼울 수 있습니다
```

계정에 묶인 값은 환경변수로만 받습니다. 기본값으로 박지 않는 것을 검사
`test_no_account_identifier_is_hardcoded` 가 강제합니다.

Guardrail 은 Bedrock 콘솔에서 contextual grounding check 만 켜서 하나 만들면 됩니다.
만드는 절차는 Confluence 자료실의 "교안 2: AWS 탐지기 사다리 실습" 에 있습니다.

## 돌리기

```bash
python3 demo.py --check                       # 설정과 권한 확인
python3 demo.py 변조본.pdf                     # 1단과 2단 모두
python3 demo.py 변조본.pdf --step 1 --n 4      # 1단만, 4쌍
python3 demo.py 변조본.pdf --save 결과.json    # 결과 저장
python3 demo.py --replay 결과.json             # 호출 없이 같은 화면을 다시
```

## 검사

```bash
python3 -m pytest test_demo.py -q
```

네트워크를 쓰지 않습니다. 참값을 아는 입력으로 문장 고르기와 맹검 규율만 겁니다.

## 모델 선택

2단의 기본값은 `amazon.nova-lite-v1:0` 입니다. **고른 이유는 성능이 아니라 그 주에 바로
호출할 수 있었다는 것입니다.** `FALSIFY_MODEL_ID` 로 바꿔 끼울 수 있고, 2단의 설계는 원래
모델 여러 종류를 각각 돌려 재현성과 판정 차이를 비교하는 것입니다. 모델 하나의 숫자를
2단의 성적으로 읽지 않습니다.
