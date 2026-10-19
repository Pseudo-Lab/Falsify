"""Synthetic wrapper output-format fixture; never calls a model or reads a paper file.

argv[1] picks the stdout variant. The JSON value is always an identity BLUE result so only
the output framing decides acceptance.
"""
import json
import sys

sys.stdin.buffer.read()
value = {'status': 'ok', 'findings': []}
compact, pretty = json.dumps(value), json.dumps(value, indent=2)
VARIANTS = {
    'pretty': pretty,                                            # multi-line JSON value: valid json
    'fence': '```json\n' + pretty + '\n```',                     # one whole fence: valid json-fence
    'prose-json': 'Here is my answer:\n' + compact,             # noisy prose before JSON
    'json-lines': compact + '\n' + compact,                      # two JSON values (JSON Lines)
    'prose-fence': 'Result below.\n```json\n' + compact + '\n```\nThanks!',
    'two-fences': '```json\n' + compact + '\n```\n```json\n' + compact + '\n```',
    'envelope': json.dumps({'envelope': {'report': value}}),     # needs output.path /envelope/report
    'huge': json.dumps({'status': 'ok', 'findings': [], 'pad': 'x' * 160000}),
}
sys.stdout.buffer.write((VARIANTS[sys.argv[1]] + '\n').encode('utf-8'))
