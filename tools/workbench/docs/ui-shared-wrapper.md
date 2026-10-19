# UI 확장 기록 — 공유 기록·초대 가입·wrapper 프로필

이 문서는 [DESIGN.md](../DESIGN.md)의 "Airport Terminal Wayfinding" 세계를 그대로 상속한 두 Operate 확장의
실제 구현 관례만 기록한다. 새 토큰·새 시각 언어·디자인 시스템 개정이 아니며 출시 인증서도 아니다.
기준 커밋 `0cf0881`. 원천: `app/dist/cloud-records.{js,css}`, `app/dist/harness-wrapper.{js,css}`.
사용법과 계약은 [팀원 초대와 공동 기록](team-access.md), [Wrapper adapter](harness-wrapper.md)에 있다.

## 상속 (변경 없음)

- 색·글꼴·반경·간격은 기존 CSS 변수(`--ink`, `--paper`, `--muted`, `--line`, `--surface`, `--red-ink`,
  `--radius`, `--font`, `--motion`, `--ease`)만 쓴다. 일부 값(`#aeb6bc`, `#8c949b`, `#e5e8e9`, 포커스 `#246388`)은
  변수 대신 DESIGN.md의 `border-strong`, `field-stroke`, `secondary-hover`, `focus` 값을 리터럴로 적었다.
- 두 확장 모두 노란색과 그림자를 쓰지 않는다(The One Sign Rule, The Flat Work Surface Rule).
  공유 기록은 결과 기록 화면 안의 한 섹션이고, wrapper 빌더는 Harness 관리 안의 접힌 disclosure다.
  새 목적지·마법사·진행 막대는 없다(The Independent Destinations Rule).

## 공유 기록 섹션 (`.cloud-records`)

- 첫 화면: 섹션 제목, 연결 상태(`#cloud-connection`), 13px muted 개인정보 문장(`.cloud-privacy`).
  세부 조작은 `details.cloud-panel`(계정, 내 로컬 기록 올리기, 같은 조건 비교)에 접는다.
- 범위 전환은 붙은 세그먼트 버튼(`.cloud-tabs`, `aria-pressed`): 눌린 쪽은 ink 채움·흰 글자,
  나머지는 투명, 1px Steel Border. 700px 이하에서 같은 폭으로 늘어난다.
- 기록 목록은 1px Divider Gray 위 경계로 나눈 평면 행(`.cloud-record`), 메타데이터는 `dl` 2열
  (dt muted, dd 탭룰러 숫자), 700px 이하 1열. 종류·공개 범위·작성자·"작성자 보고 · 미검증"은
  기존 `status-label` 칩(`.cloud-chips`)의 텍스트로 표시하고 제목은 14px h3이다.
- 업로드 미리보기(`.cloud-preview`)는 mist 채움 Consolas 13px, 최대 320px 자체 스크롤.
  비어 있으면 "보낼 내용이 아직 없습니다."를 muted로 보인다. 확인 체크와 경고는 `.check-row`·13px 문장.
- 작성 영역(`.cloud-compose`)만 위 경계를 ink 1px로 올려 구분한다. 그 외 구획선은 Divider Gray.
- 오류는 Error Red 글자(`.error`)만, 채움·테두리 없음.

## 로그인·초대 가입 폼 (`#cloud-auth-form`)

- 2열 그리드(최대 720px, 700px 이하 1열), 라벨 안에 12px muted 제약 힌트(`small`, `aria-describedby`)를
  필드 위에 둔다. 예: "영문·숫자·_·- 3–32자". 필드는 흰 채움, 1px Field Stroke, 4px, 최소 44px.
- 초대코드 필드는 `type=password`, `autocomplete=off`, 가입에만 전송된다. 비밀번호·초대코드는
  결과와 무관하게 요청 전에 비운다. 표시 이름은 선택 `details.cloud-display`로 접는다.
- 로그인 전에는 공유 목록을 요청하지 않고 로그인 안내만 보인다. "공유"는 팀 공유이지 인터넷 공개가 아니다.

## Wrapper 프로필 빌더 (`details#harness-wrapper`)

- 요약 줄 "기존 프로그램 연결 프로필 · wrapper", 위아래 1px Divider Gray 경계, 그림자·카드 없음.
- 네 개의 `fieldset.wrapper-group`(기본 정보, 실행 대상, 입력 전달, 출력 읽기)이 2열 그리드
  (간격 22px 28px), 820px 이하 1열. legend는 16px/700(Subtitle), 필드 라벨 12px/600, 힌트 13px muted 75ch.
- 입력은 공유 기록 필드와 같은 stroke·4px·10px. JSON textarea만 Consolas 13px, 설명 textarea는 시스템 sans.
- 미리보기(`.wrapper-preview`)는 support panel 관례(mist, 12px 반경, 18px 20px). 결과 `pre`는 흰 채움,
  1px Divider Gray, 4px, 최대 320px 스크롤, 탭룰러 숫자. 상태 줄 오류만 Error Red.
- 빌더는 기존 harness-editor에 JSON을 생성·검증·미리보기할 뿐 등록·실행하지 않는다.

## 표현해야 할 경계 (문구 관례)

- 정적 GitHub Pages 화면은 공개, 공동 API의 기록은 초대받은 활성 팀원 세션 전용.
- 공유 기록의 엔진·조건 라벨은 클라이언트가 보고한 값이며 서버가 검증한 결과가 아니다.
- Harness 등록은 실행이 아니다. 실행은 기존 executionConsent 게이트를 따른다.
- wrapper 미리보기는 합성 샘플에 대한 매핑 확인이며 실제 프로그램 호환성 증명이 아니다.

## 기록하지 않은 것

- 리터럴 hex 몇 개는 토큰 사용 누락이지 새 토큰이 아니다. 별도 토큰으로 승격하지 않았다.
- DESIGN.md, `.impeccable/design.json`은 이 확장으로 고치지 않았다. 증거 캡처는 조정 루트의
  `.impeccable/review/*-v2.png`(작업 트리 밖)에 있다.
