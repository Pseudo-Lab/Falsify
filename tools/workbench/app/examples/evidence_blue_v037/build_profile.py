"""Install-only profile binding for BLUE Evidence v0.3.7. Does not execute models or modify old profiles."""
import json
from pathlib import Path
import sys
import runner


def build(dest=None):
    """Build and validate the BLUE Evidence v0.3.7 profile JSON without touching predecessor profiles."""
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
        '참고문헌 DOI/제목·저자 질의(최대25건)는 Crossref/Europe PMC에, NCT 등록번호(최대10건)는 ClinicalTrials.gov v2에, '
        '공개 과학 식별자(OSF·NCBI GEO·RCSB PDB)는 각 공개 메타데이터 API에 전송됩니다. '
        '전체 PDF와 보충자료 원문 파일은 외부 API에 업로드하지 않으며 Layer 0 정적 포렌식은 로컬에서만 실행됩니다. '
        '비공개·민감 원문에는 사용하지 마세요. 모델 처리에는 기존 Claude 구독을 사용합니다.'
    )
    profile['settings']['budgetDisclosure'] = (
        'Layer 0 정적 통계·식별자·보충자료 Triage는 모델 호출 0회·네트워크 0회로 선행 실행됩니다. '
        '문서 scan/selection 호출 최대120초, 그 외 단계 최대70초, 내부 모델 최대4회, 전체 adapter 150초. '
        '외부 참고문헌/임상·식별자 조회는 7초 TLS 제한·리다이렉트 금지·자동 재시도 없음.'
    )
    profile['settings']['limitations'] = (
        '0.3.7 실험 번들. Layer 0 정적 통계·보충자료 대조와 P2 외부 검증(Crossref·Europe PMC 철회 여부·'
        'ClinicalTrials.gov v2·OSF/GEO/PDB/PROSPERO)은 triage 후보 신호 및 메타데이터·초록 범위이며 '
        '원문 전체·통계 재분석·출판된 프로토콜 개정 이력·도메인 승인이 아닙니다. '
        '404·미발견·비공개/엠바고 등록만으로 위조를 단정하지 마세요.'
    )
    profile['settings']['predecessor'] = 'shinick-blue-evidence-external-v036; 기존 정의·기록은 변경하지 않음.'
    from harness import validate
    validate(profile, 'blue')
    target = Path(dest) if dest is not None else runner.HERE / 'profile.json'
    target.write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding='utf8')
    return profile


if __name__ == '__main__':
    result = build()
    print(json.dumps({'version': result['version'], 'bundleSha256': result['settings']['bundleSha256']}))
