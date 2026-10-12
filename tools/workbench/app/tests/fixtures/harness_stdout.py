"""Synthetic protocol fixture; never calls a model or reads a paper file."""
import json
import sys
invocation = json.load(sys.stdin)
key = 'candidates' if invocation['role'] == 'red' else 'findings'
print(json.dumps({'status': 'ok', key: []}))
