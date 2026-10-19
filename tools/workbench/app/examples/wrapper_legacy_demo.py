"""LegacyLint 2.3 — a synthetic *legacy* program used to demonstrate the wrapper adapter.

It predates Falsify and knows nothing about the falsify.harness-invocation.v1 output
schema: it always prints its own report shape ("outcome"/"digest"/"highlights"/"items"/
"picks"). The wrapper profile (wrapper-profile.json) maps that report to each stage
schema with output.stageMaps. Deterministic rules only: no model, network, files or paper
binary. It is a compatibility demo, not a reviewer; replace it with your real program.

Input (choose one, mirroring wrapper input.mode):
  --in invocation   stdin = invocation JSON          (input.mode "invocation")
  --in prompt       stdin = raw prompt text          (input.mode "prompt")
  --in job          stdin = {"job": {...}} JSON      (input.mode "template")
  --in files --invocation P --prompt-file P --schema P   (input.mode "files")
Output:
  --out json (default) | --out fence (one ```json block) | --out file --out-file P
"""
import argparse
import json
import re
import sys

ANTONYMS = {'increases': 'decreases', 'decreases': 'increases', 'higher': 'lower', 'lower': 'higher',
            'improves': 'worsens', 'supports': 'contradicts', '증가했다': '감소했다', '감소했다': '증가했다'}
ABSOLUTES = ('always', 'proves', 'guarantees', 'in all cases', '항상', '증명한다')
DECLINE, NOTHING = 'LEGACY-DECLINE', 'LEGACY-NOTHING'
SENTENCE = re.compile(r'[^.!?。\n]+[.!?。]?')


def payload_of(prompt):
    """The application appends one JSON object at the end of every prompt."""
    decoder, text = json.JSONDecoder(), prompt.rstrip()
    for match in re.finditer(r'\{"', text):
        try:
            value, end = decoder.raw_decode(text, match.start())
        except ValueError:
            continue
        if end == len(text) and isinstance(value, dict):
            return value
    raise SystemExit('LegacyLint: no trailing JSON payload')


def sentences(text):
    return [m.group(0).strip() for m in SENTENCE.finditer(text) if m.group(0).strip()]


def word_hit(sentence, words):
    lowered = sentence.lower()
    return next((w for w in words if re.search(r'(?<!\w)' + re.escape(w) + r'(?!\w)', lowered)), None)


def passages(payload):
    """(paragraph id, text, whole-segment flag) the legacy rules may quote from."""
    if 'segments' in payload:
        return [(s['id'], s['text'], True) for s in payload['segments']]
    if 'rereadWindows' in payload:
        found = [(w['segmentId'], w['text'], False) for w in payload['rereadWindows']]
    else:
        found = []
    for note in payload.get('allChunkNotes', []):
        found += [(e['segmentId'], e['quote'], False) for e in note['evidence']]
    return found


def lint(prompt):
    payload = payload_of(prompt)
    report = {'legacy': 'LegacyLint/2.3', 'outcome': 'ok', 'digest': '', 'highlights': [], 'items': [], 'picks': []}
    if DECLINE in prompt:
        return {**report, 'outcome': 'refusal', 'digest': 'declined by policy marker'}
    if NOTHING in prompt:
        return {**report, 'outcome': 'abstain', 'digest': 'insufficient basis'}
    attack = 'level' in payload
    seen = set()
    for para, text, whole in passages(payload):
        for s in sentences(text):
            if (para, s) in seen or (whole and text.count(s) != 1):
                continue
            seen.add((para, s))
            swap, absolute = word_hit(s, ANTONYMS), word_hit(s, ABSOLUTES)
            if (swap or absolute) and len(report['highlights']) < 4 and len(s) <= 600:
                report['highlights'].append({'para': para, 'text': s, 'why': 'legacy marker sentence'})
            if len(s) <= 300 and len(report['picks']) < 8 and (swap or absolute):
                report['picks'].append({'para': para, 'anchor': s, 'why': 'reread around legacy marker'})
            if len(report['items']) >= 12:
                continue
            support = [{'para': para, 'text': s, 'why': 'the flagged sentence itself'}]
            ref = 'LL-%d' % (len(report['items']) + 1)
            if attack and swap:
                rewrite = re.sub(r'(?<!\w)' + re.escape(swap) + r'(?!\w)', ANTONYMS[swap], s, count=1, flags=re.I)
                report['items'].append({'ref': ref, 'para': para, 'tier': payload['level'], 'excerpt': s, 'rewrite': rewrite,
                    'note': 'Swapping "%s" reverses the stated direction.' % swap, 'support': support,
                    'caveat': 'Rule-based synthetic edit; meaning not reviewed.'})
            elif not attack and absolute:
                report['items'].append({'ref': ref, 'para': para, 'tier': 0, 'excerpt': s, 'rewrite': '',
                    'note': 'Absolute claim "%s" is not qualified in the supplied text.' % absolute, 'support': support,
                    'caveat': 'Keyword rule; no domain judgment.'})
    report['digest'] = '%d passage(s), %d marker sentence(s)' % (len(passages(payload)), len(report['highlights']))
    return report


def read_input(args):
    if args.mode == 'files':
        with open(args.prompt_file, encoding='utf-8') as f:
            prompt = f.read()
        with open(args.invocation, encoding='utf-8') as f:
            json.load(f)  # the legacy tool only checks that the sidecar parses
        with open(args.schema, encoding='utf-8') as f:
            json.load(f)
        return prompt
    raw = sys.stdin.buffer.read().decode('utf-8')
    if args.mode == 'invocation':
        return json.loads(raw)['prompt']
    if args.mode == 'job':
        return json.loads(raw)['job']['text']
    return raw


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--in', dest='mode', choices=['invocation', 'prompt', 'job', 'files'], default='invocation')
    parser.add_argument('--invocation')
    parser.add_argument('--prompt-file')
    parser.add_argument('--schema')
    parser.add_argument('--out', choices=['json', 'fence', 'file'], default='json')
    parser.add_argument('--out-file')
    args = parser.parse_args()
    text = json.dumps(lint(read_input(args)), ensure_ascii=False, indent=2)
    if args.out == 'file':
        with open(args.out_file, 'w', encoding='utf-8') as f:
            f.write(text)
        return
    if args.out == 'fence':
        text = '```json\n' + text + '\n```'
    sys.stdout.buffer.write((text + '\n').encode('utf-8'))


if __name__ == '__main__':
    main()
