"""Install-only profile binding for the adversarial RED runner v0.3.0."""
import json
from pathlib import Path
import sys

import runner


def build(dest=None):
    """Return the canonical falsify.harness.v1 RED profile. Write it only when dest is set."""
    profile = {
        'schema': 'falsify.harness.v1',
        'id': runner.PROFILE_ID,
        'name': 'Adversarial RED runner v0.3.0',
        'version': runner.VERSION,
        'role': 'red',
        'maxCalls': 4,
        'instructions': runner.INSTRUCTIONS,
        'adapter': {
            'type': 'stdio',
            'executable': sys.executable,
            'args': [str(runner.HERE / 'runner.py')],
        },
        'settings': runner.contract_settings(),
    }
    from harness import validate
    validate(profile, 'red')
    if dest is not None:
        Path(dest).write_text(json.dumps(profile, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return profile


if __name__ == '__main__':
    print(json.dumps(build(), ensure_ascii=False, indent=2))
