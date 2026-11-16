"""Install-only profile binding for BLUE Evidence v0.4.1. Does not execute models or modify old profiles."""
import json
from pathlib import Path
import sys
import runner


def build(dest=None):
    """Build and validate the BLUE Evidence v0.4.1 profile JSON without touching predecessor profiles."""
    profile = json.loads((runner.v034.HERE / 'profile-template.json').read_text(encoding='utf8'))
    profile.update(
        id=runner.PROFILE_ID,
        name=runner.PROFILE_NAME,
        version=runner.VERSION,
        instructions=runner.INSTRUCTIONS,
    )
    profile['adapter'] = {'type': 'stdio', 'executable': sys.executable, 'args': [str(runner.HERE / 'runner.py')]}
    profile['settings'].update(runner.contract_settings())
    profile['settings']['auditDirectory'] = str(runner.v033.REPO / '.local' / runner.AUDIT_DIR_NAME)
    profile['settings']['privacy'] = (
        '참고문헌 DOI/제목·저자 질의와 공개 식별자 조회만 외부 API로 나갑니다. '
        '전체 PDF, 보충자료 원문, 숨은 텍스트·주석·메타데이터 보안 감사, 도표 서브패널·축 검사, '
        '행 단위 재계산, 코드·노트북·스프레드시트 정적 대조, IMRaD 내부 일관성 감사는 로컬에서만 실행됩니다. '
        '분석 스크립트와 노트북 셀은 실행하지 않습니다. 비공개·민감 원문에는 사용하지 마세요. '
        '모델 처리에는 기존 Claude 구독을 사용합니다.'
    )
    profile['settings']['budgetDisclosure'] = (
        'Layer 0 정적 통계·원자료 재계산·코드 보충 정적 대조·IMRaD·PDF 보안·선택적 메타분석 Triage는 '
        '모델 호출 0회·네트워크 0회로 선행됩니다. '
        '인용 미검증 결함은 수리 호출을 최대 1회 더 쓸 수 있습니다. '
        '문서 scan/selection 호출 최대 120초, 그 외 단계 최대 70초, 내부 모델 최대 4회, 전체 adapter 150초.'
    )
    profile['settings']['limitations'] = (
        '0.4.1 실험 번들. PDF 보안 신호는 숨은 글자·렌더 모드 3·주석·메타데이터·보충 텍스트의 명시적 주입 구문만 담습니다. '
        '보안 논문의 본문에 보이는 공격 예문은 제목·표제가 그 주제를 다룰 때 신호에서 빠집니다. '
        '도표 서브패널 재사용과 축 왜곡은 paper_figure_forensics가 로컬에서 계산합니다. '
        'meta/table 감사는 paper_meta_and_table_audit가 있을 때만 digest에 들어갑니다. '
        '인용 게이트는 제공된 세그먼트와의 문자열 일치이며 Zero-Drop 복원과 미검증 인용 강등을 유지합니다. '
        '404·미발견만으로 위조를 단정하지 마세요.'
    )
    profile['settings']['predecessor'] = 'shinick-blue-evidence-triage-v040; 기존 정의·기록은 변경하지 않음.'
    from harness import validate
    validate(profile, 'blue')
    target = Path(dest) if dest is not None else runner.HERE / 'profile.json'
    target.write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding='utf8')
    return profile


if __name__ == '__main__':
    result = build()
    print(json.dumps({'version': result['version'], 'bundleSha256': result['settings']['bundleSha256']}))
