"""Install-only profile binding for BLUE Evidence v0.3.9. Does not execute models or modify old profiles."""
import json
from pathlib import Path
import sys
import runner


def build(dest=None):
    """Build and validate the BLUE Evidence v0.3.9 profile JSON without touching predecessor profiles."""
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
        '전체 PDF, 보충자료 원문, 행 단위 재계산, 코드 보충의 정적 대조는 로컬에서만 실행되며 외부로 업로드하지 않습니다. '
        '분석 스크립트는 실행하지 않습니다. 비공개·민감 원문에는 사용하지 마세요. 모델 처리에는 기존 Claude 구독을 사용합니다.'
    )
    profile['settings']['budgetDisclosure'] = (
        'Layer 0 정적 통계·원자료 재계산·코드 보충 정적 대조·식별자·보충자료 Triage는 모델 호출 0회·네트워크 0회로 선행됩니다. '
        '인용 미검증 결함은 수리 호출을 최대 1회 더 쓸 수 있습니다. '
        '문서 scan/selection 호출 최대 120초, 그 외 단계 최대 70초, 내부 모델 최대 4회, 전체 adapter 150초.'
    )
    profile['settings']['limitations'] = (
        '0.3.9 실험 번들. 코드 보충 대조는 AST와 제한된 정규식만 사용하며 스크립트를 실행하지 않습니다. '
        '행 단위 CSV/TSV/JSON 재계산은 비보정 이표본 검정과 기술통계만 다루며 다변량·다중비교 p값은 원자료 신호가 아닙니다. '
        '인용 게이트는 제공된 세그먼트와의 문자열 일치이며 통계적 타당성 승인이 아닙니다. 404·미발견만으로 위조를 단정하지 마세요.'
    )
    profile['settings']['predecessor'] = 'shinick-blue-evidence-triage-v038; 기존 정의·기록은 변경하지 않음.'
    from harness import validate
    validate(profile, 'blue')
    target = Path(dest) if dest is not None else runner.HERE / 'profile.json'
    target.write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding='utf8')
    return profile


if __name__ == '__main__':
    result = build()
    print(json.dumps({'version': result['version'], 'bundleSha256': result['settings']['bundleSha256']}))
