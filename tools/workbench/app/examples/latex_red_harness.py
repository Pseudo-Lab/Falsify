"""RED harness: deterministic defect candidates from supplied extracted text.

stdin invocation JSON -> stdout schema object only. No logging to stdout, no
network, no model call: the swap table and the one-per-line budget make the
output reproducible on any PC within the companion's per-call time limit.

The Workbench receives extracted paragraph text (`segments`), so this harness
works on that text and quotes it verbatim. Re-typesetting the paper around these
candidates stays a separate companion step (`harness/falsify.py` in the research
folder); this file only decides what changes and where.

Registration example:

    {"schema":"falsify.harness.v1","id":"latex-red","name":"LaTeX RED",
     "version":"1","role":"red",
     "instructions":"Contradict stated comparisons, quantities and hedges.",
     "maxCalls":8,
     "adapter":{"type":"stdio","executable":"C:/Python312/python.exe",
                "args":["C:/path/to/app/examples/latex_red_harness.py"]},
     "settings":{"language":"ko"}}
"""
import json
import sys

MAX_CANDIDATES = 12
MAX_EVIDENCE = 6

# (what to look for, replacement) per attack type, applied in order.
SWAPS = {
    'contradiction': [
        ('reduces', 'increases'), ('higher', 'lower'), ('improve', 'degrade'),
        ('outperform', 'underperform'), ('more', 'less'), ('significant', 'negligible'),
    ],
    'condition-omission': [
        ('if a review repeats', 'a review repeats'),
        ('when the input is slightly changed', ''),
        ('for most cases', 'in every case'),
        ('under LLM influence', 'by definition'),
    ],
    'unsupported-inference': [
        ('suggests that', 'proves that'), ('may lack', 'lacks'),
        ('is consistent with', 'demonstrates'), ('appears to', 'does'),
    ],
}
RELATION = {
    'ko': {'contradiction': '같은 지표의 방향을 뒤집는다.',
           'condition-omission': '조건 절을 줄여 주장 범위를 넓힌다.',
           'unsupported-inference': '완충 표현을 제거해 근거 없이 단정한다.'},
    'en': {'contradiction': 'flips the direction of the same measure',
           'condition-omission': 'drops the limiting clause around the claim',
           'unsupported-inference': 'removes the hedge and asserts'},
}


def payload_of(prompt):
    """Pull the JSON payload the app appends after its own instructions."""
    start = prompt.find('{"attackTypes"')
    if start < 0:
        start = prompt.rfind('\n{')
    return json.loads(prompt[start:].strip() or '{}')


def notes_payload(data):
    """Multi-chunk calls carry chunk notes instead of full segments."""
    return [{'id': n.get('segmentId') or 's0', 'label': 'note', 'text': n.get('summary', '')}
            for n in data.get('allChunkNotes', []) if isinstance(n, dict)]


def segments_of(data):
    segments = data.get('segments')
    if isinstance(segments, list) and segments:
        return segments
    return notes_payload(data)


def chosen_types(data):
    types = data.get('attackTypes')
    if isinstance(types, list) and types:
        return [t for t in types if t in SWAPS]
    level = data.get('level')
    if isinstance(level, int) and 1 <= level <= 3:
        return [list(SWAPS)[level - 1]]
    return list(SWAPS)


def find_swap(text, types):
    """First swap whose source phrase occurs exactly once in this paragraph."""
    best = None
    for attack in types:
        for old, new in SWAPS[attack]:
            hits = text.count(old)
            if hits != 1:
                continue
            point = (text.find(old), attack, old, new)
            if best is None or point[0] < best[0]:
                best = point
    return best


def candidate(index, segment, types, language):
    text = segment['text']
    found = find_swap(text, types)
    if not found:
        return None
    offset, attack, old, new = found
    after = text.replace(old, new, 1)
    if after == text:
        return None
    item = {'id': 'C%d' % index, 'segmentId': segment['id'],
            'before': old, 'after': new,
            'rationale': RELATION[language][attack],
            'evidence': [{'segmentId': segment['id'], 'quote': old,
                          'relation': RELATION[language][attack]}][:MAX_EVIDENCE],
            'uncertainty': None}
    return item, attack


def keys_of(schema, name):
    """Field names the app requires at this stage (objects and array items)."""
    properties = (schema or {}).get('properties') or {}
    target = properties.get(name) or {}
    if target.get('type') == 'array':
        target = target.get('items') or {}
    return name in properties, set(target.get('properties', {}))


def act(invocation):
    role = invocation.get('role', 'red')
    schema = invocation.get('outputSchema') or {}
    settings = invocation.get('settings') or {}
    language = settings.get('language') if settings.get('language') in RELATION else 'ko'
    try:
        data = payload_of(invocation.get('prompt', ''))
    except (ValueError, json.JSONDecodeError):
        data = {}
    types = chosen_types(data)

    if role != 'red' or 'candidates' not in (schema.get('properties') or {'candidates': 1}):
        # BLUE and chunk reads judge a different axis; abstaining is the honest answer here.
        if 'findings' in (schema.get('properties') or {}):
            return {'status': 'abstain', 'findings': []}
        if 'summary' in (schema.get('properties') or {}):
            return {'status': 'abstain', 'summary': 'RED only harness.', 'evidence': []}
    _, item_keys = keys_of(schema, 'candidates')

    candidates, index = [], 1
    for segment in segments_of(data):
        if len(candidates) >= MAX_CANDIDATES:
            break
        made = candidate(index, segment, types, language)
        if not made:
            continue
        item, attack = made
        item['level'] = list(SWAPS).index(attack) + 1
        item['attackTypes'] = [attack]
        # The app compares key sets exactly, so keep only what this call asked for.
        candidates.append({k: v for k, v in item.items() if k in item_keys})
        index += 1
    return {'status': 'ok' if candidates else 'abstain', 'candidates': candidates}


if __name__ == '__main__':
    # The companion strips most environment variables, so handle bytes directly
    # instead of relying on the locale default of stdin/print.
    raw = sys.stdin.buffer.read()
    body = json.dumps(act(json.loads(raw.decode('utf-8') or '{}')), ensure_ascii=False)
    sys.stdout.buffer.write(body.encode('utf-8') + b'\n')