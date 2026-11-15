"""Install-only profile binding for BLUE Evidence v0.3.6. Does not execute models or modify old profiles."""
import json
from pathlib import Path
import sys
import runner


def build(dest=None):
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
        '참고문헌 DOI/제목·저자 질의(최대25건)는 Crossref/Europe PMC에, NCT 등록번호(최대10건)는 ClinicalTrials.gov v2에 전송됩니다. '
        '전체 PDF는 외부 API에 업로드하지 않습니다. 비공개·민감 원문에는 사용하지 마세요. 모델 처리에는 기존 Claude 구독을 사용합니다.'
    )
    profile['settings']['budgetDisclosure'] = (
        '문서 scan/selection 호출 최대120초, 그 외 단계 최대70초, 내부 모델 최대4회, 전체 adapter150초. '
        '참고문헌/임상등록 조회는 7초 TLS 제한·리다이렉트 금지·자동 재시도 없음.'
    )
    profile['settings']['limitations'] = (
        '0.3.6 실험 번들. 전수 참고문헌 검증·인용 주장 초록 대조·ClinicalTrials.gov v2 비교는 '
        '메타데이터·초록·등록 요약 범위이며 원문 전체·출판된 프로토콜 개정 이력·도메인 승인·정확도 개선 입증이 아님.'
    )
    profile['settings']['predecessor'] = 'shinick-blue-evidence-external-v035; 기존 정의·기록은 변경하지 않음.'
    from harness import validate
    validate(profile, 'blue')
    target = Path(dest) if dest is not None else runner.HERE / 'profile.json'
    target.write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding='utf8')
    return profile


if __name__ == '__main__':
    result = build()
    print(json.dumps({'version': result['version'], 'bundleSha256': result['settings']['bundleSha256']}))
