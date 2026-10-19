"""Synthetic wrapper-runtime fixture; never calls a model or reads a paper file. Mode is argv[1]."""
import json
import os
import sys
import time

mode = sys.argv[1]
if mode == 'invocation':
    inv = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    print(json.dumps({'result': {'role': inv['role'], 'tag': inv['schema'], 'call': inv['call'], 'prompt': inv['prompt'],
                                 'items': [{'text': 'a'}, {'text': 'b'}]}}))
elif mode == 'prompt':
    text = sys.stdin.buffer.read().decode('utf-8')
    sys.stdout.write('```json' + chr(10) + json.dumps({'echo': text}) + chr(10) + '```' + chr(10))
elif mode == 'template':
    print(json.dumps({'got': json.loads(sys.stdin.buffer.read().decode('utf-8'))}))
elif mode == 'files':
    paths = sys.argv[2:6]
    with open(paths[0], encoding='utf-8') as f: inv = json.load(f)
    with open(paths[1], encoding='utf-8', newline='') as f: prompt = f.read()
    with open(paths[2], encoding='utf-8') as f: schema = json.load(f)
    data = {'stdin': sys.stdin.read(), 'cwd': os.getcwd(), 'paths': paths, 'role': inv['role'],
            'promptMatches': prompt == inv['prompt'], 'schemaType': schema['type']}
    with open(paths[3], 'w', encoding='utf-8') as f: json.dump(data, f)
    print('stdout is ignored for file output')
elif mode == 'review':
    json.loads(sys.stdin.read())
    print(json.dumps({'result': {'state': 'ok', 'items': [], 'notes': 'synthetic note'}}))
elif mode == 'sleep':
    time.sleep(60)
elif mode == 'fail':
    sys.stdout.write('secret-token-abc')
    sys.exit(3)
elif mode == 'big':
    sys.stdout.write('x' * 200000)
elif mode == 'bigfile':
    with open('output.json', 'w') as f: f.write('x' * 200000)
elif mode == 'nofile':
    print('{}')
elif mode == 'dirfile':
    os.mkdir('output.json')
elif mode == 'symlink':
    with open('real.json', 'w') as f: f.write('{"status": "ok"}')
    os.symlink(os.path.abspath('real.json'), 'output.json')
