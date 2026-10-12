"""Copy and implement your own harness. stdin invocation -> stdout schema object.

Do not log to stdout. Settings/credentials are your implementation's responsibility.
The default below abstains honestly; replace with your model/tool pipeline.
"""
import json
import sys

def act(invocation):
    # invocation['prompt']: supplied document fragments + role contract
    # invocation['outputSchema']: required strict JSON response schema
    # invocation['settings']: your arbitrary JSON configuration
    # Multi-chunk invocations can occur; preserve application role boundaries.
    key = 'candidates' if invocation['role'] == 'red' else 'findings'
    if 'summary' in invocation['outputSchema']['properties']:
        return {'status': 'abstain', 'summary': 'Implement your chunk reader.', 'evidence': []}
    return {'status': 'abstain', key: []}

if __name__ == '__main__':
    print(json.dumps(act(json.load(sys.stdin)), ensure_ascii=False))
