"""Install-only profile binding. Does not execute models or overwrite old profiles."""
import json
from pathlib import Path
import sys
import runner


def build(dest=None):
    profile = json.loads((runner.PREVIOUS / 'profile-template.json').read_text(encoding='utf8'))
    profile.update(id=runner.PROFILE_ID, name=runner.PROFILE_NAME, version=runner.VERSION)
    profile['adapter'] = {'type': 'stdio', 'executable': sys.executable, 'args': [str(runner.HERE / 'runner.py')]}
    profile['settings'].update(runner.contract_settings())
    profile['settings']['auditDirectory'] = str(runner.v034.v033.REPO / '.local' / runner.AUDIT_DIR_NAME)
    profile['settings']['budgetDisclosure'] = '문서 scan/selection 호출 최대120초, 그 외 단계 최대70초, 내부 모델 최대4회, 전체 adapter150초. 자동 재시도 없음.'
    profile['settings']['limitations'] = '0.3.5 timeout hotfix. v034 검토 전략과 근거 검사는 유지. 문서 단계 대기 상한만70→120초. 전체150초. 성공/정확도 보장은 아님. PC별 설치 경로.'
    profile['settings']['predecessor'] = 'shinick-blue-evidence-external-v034; 기존 정의·기록은 변경하지 않음.'
    from harness import validate
    validate(profile, 'blue')
    target = Path(dest) if dest is not None else runner.HERE / 'profile.json'
    target.write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding='utf8')
    return profile


if __name__ == '__main__':
    result = build()
    print(json.dumps({'version': result['version'], 'bundleSha256': result['settings']['bundleSha256']}))
