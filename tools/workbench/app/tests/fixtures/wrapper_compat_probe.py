"""Synthetic files-mode probe; never calls a model or reads a paper file.

Usage: probe.py {input} {prompt} {schema} {output}. Exits non-zero unless stdin is empty and the
three generated files are absolute, fixed-name and mutually consistent; then writes an
identity-shaped abstain result to {output}.
"""
import json
import os
import sys

if sys.stdin.buffer.read():
    sys.exit(3)
invocation_path, prompt_path, schema_path, output_path = sys.argv[1:5]
names = [os.path.basename(p) for p in (invocation_path, prompt_path, schema_path, output_path)]
if names != ['invocation.json', 'prompt.txt', 'schema.json', 'output.json'] or not all(map(os.path.isabs, sys.argv[1:5])):
    sys.exit(4)
with open(invocation_path, encoding='utf-8') as f:
    invocation = json.load(f)
with open(prompt_path, encoding='utf-8') as f:
    prompt = f.read()
with open(schema_path, encoding='utf-8') as f:
    schema = json.load(f)
if prompt != invocation['prompt'] or schema != invocation['outputSchema']:
    sys.exit(5)
keys = set(schema['properties'])
result = {'status': 'abstain', 'summary': 'probe', 'evidence': []} if 'summary' in keys else \
    {'status': 'abstain', (keys - {'status'}).pop(): []}
with open(output_path, 'w', encoding='utf-8') as f:
    json.dump(result, f)
