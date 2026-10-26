"""Build the scan-format repair definition locally; predecessor files stay untouched."""
import copy
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from runner import bundle_identity


def main():
    profile = copy.deepcopy(json.loads((HERE.parent / 'evidence_blue_v031/profile-template.json').read_text(encoding='utf-8')))
    profile.update(id='shinick-blue-evidence-external-v033', version='0.3.3',
                   name='BLUE Evidence v0.3.3 · 스캔 출력 계약 · 외부 문헌 + 독립·교차검토',
                   instructions='통계와 방법론 독립 검토 후 새 세션에서 교차 검토합니다. 문서 내부 지적과 외부 문헌 근거 지적을 구분하고 실제 조회한 출처를 인용하세요. 검색 미발견을 결함으로 단정하지 마세요. 근거는 제공받은 논문에서 정확하게 복사하세요.')
    profile['adapter'] = {'type': 'stdio', 'executable': sys.executable, 'args': [str(HERE / 'runner.py')]}
    profile['settings'].update(bundleSha256=bundle_identity(), diagnosticVersion='0.3.3',
        auditSchema='falsify.blue-evidence-audit.v0.3.3',
        auditDirectory=str(HERE.parents[2] / '.local/blue-evidence-v033-audits'),
        limitations='PC별 설치 경로. 실행기는 스캔 evidence의 공백 차이만 실제 전달된 원문 한 곳에 재앵커링한 후 정확 인용 검사한다. 하이픈·부호는 변경하지 않는다. 원응답·파생 기록은 비공개 감사에 분리 보존. 최종 전문가·선택 인용은 보정하지 않는다. 외부 조회는 메타데이터/초록만이며 그림판독·재분석·도메인승인·OS격리·정확도 개선 입증이 아니다.',
        predecessor='BLUE Evidence v0.3.2 id shinick-blue-evidence-external-v032. 이전 코드·profile·실험 결과 보존; scan JSON schema 길이 상한 추가.')
    sys.path.insert(0, str(HERE.parents[1] / 'local'))
    from harness import validate
    validate(profile, 'blue')
    (HERE / 'profile.json').write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'version': profile['version'], 'bundleSha256': profile['settings']['bundleSha256']}))


if __name__ == '__main__':
    main()
