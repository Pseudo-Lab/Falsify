"""Synthetic dishonest legacy program; never calls a model or reads a paper file.

argv[1]: 'abstain-with-items' claims abstain yet lists an item; 'invented-quote' cites text that
is not in the supplied document. Mapping must carry these through unchanged so the
application's evidence validation rejects them.
"""
import json
import sys

sys.stdin.buffer.read()
support = [{'para': 's0', 'text': 'This sentence does not exist in the source.', 'why': 'invented'}]
item = {'ref': 'LL-1', 'para': 's0', 'tier': 0, 'excerpt': 'This sentence does not exist in the source.',
        'rewrite': '', 'note': 'invented', 'support': support, 'caveat': 'none'}
outcome = 'abstain' if sys.argv[1] == 'abstain-with-items' else 'ok'
print(json.dumps({'legacy': 'Bad/0', 'outcome': outcome, 'digest': 'x', 'highlights': [], 'items': [item], 'picks': []}))
