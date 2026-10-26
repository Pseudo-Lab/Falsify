"""Bind this PC's Python, runner and audit directory. Predecessor profiles stay untouched."""
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import runner


def build(dest=None):
    profile = json.loads((HERE / 'profile-template.json').read_text(encoding='utf-8'))
    profile['id'] = runner.PROFILE_ID
    profile['version'] = runner.VERSION
    profile['name'] = runner.PROFILE_NAME
    profile['instructions'] = runner.INSTRUCTIONS
    profile['adapter'] = {'type': 'stdio', 'executable': sys.executable, 'args': [str(HERE / 'runner.py')]}
    profile['settings'].update(runner.contract_settings())
    profile['settings']['auditDirectory'] = str(runner.v033.REPO / '.local' / runner.AUDIT_DIR_NAME)
    sys.path.insert(0, str(HERE.parents[1] / 'local'))
    from harness import validate
    validate(profile, 'blue')
    target = HERE / 'profile.json' if dest is None else Path(dest)
    target.write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding='utf-8')
    return profile


def main():
    profile = build()
    print(json.dumps({
        'version': profile['version'], 'id': profile['id'],
        'bundleSha256': profile['settings']['bundleSha256'],
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
