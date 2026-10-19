"""Flexible wrapper adapter: deterministic input/output reshaping around one stdio/HTTPS target.

Trusted user code, NOT an OS sandbox. Mappings are pure data templates (no eval, interpolation or
scripts); validate_shape and the services' evidence checks stay authoritative over anything mapped here.
"""
import json
import math
import os
import re
import stat
import tempfile

import harness
import harness_adapter
from harness_adapter import validate_shape

MODES = ('invocation', 'prompt', 'template', 'files')
SOURCES = ('stdout', 'file')
FORMATS = ('json', 'json-fence')
STAGES = ('scan', 'selection', 'red', 'blue')
STAGE_KEYS = {'summary': 'scan', 'targets': 'selection', 'candidates': 'red', 'findings': 'blue'}
# Whole-token argument placeholders -> fixed generated file names in the private temp dir.
PLACEHOLDERS = {'{input}': 'invocation.json', '{prompt}': 'prompt.txt', '{schema}': 'schema.json', '{output}': 'output.json'}
PLACEHOLDER_TEXT = re.compile(r'\{(?:input|prompt|schema|output)\}')
MAX_CONFIG_CHARS = 32000
MAX_DEPTH = 20
MAX_ITEMS = 1000
MAX_PRODUCED = 100000
FORBIDDEN_KEYS = {'__proto__', 'constructor', 'prototype'}
POINTER = re.compile(r'(?:/(?:[^~/]|~[01])*)*', re.S)
INDEX = re.compile(r'0|[1-9][0-9]*', re.ASCII)
# Shared with harness-core.js parseOutput: JSON whitespace only around the block, newline before the closing fence.
FENCE = re.compile(r'[ \t\r\n]*```(?:json)?[ \t]*\r?\n(.*?)\r?\n```[ \t\r\n]*', re.S)

def check_pointer(pointer):
    if not isinstance(pointer, str) or len(pointer) > 2000 or not POINTER.fullmatch(pointer):
        raise ValueError('wrapper JSON pointer는 RFC 6901 형식("" 또는 "/a/0")이어야 합니다.')
    # Mirrors the browser helper, which refuses prototype tokens.
    if FORBIDDEN_KEYS & {t.replace('~1', '/').replace('~0', '~') for t in pointer.split('/')[1:]}:
        raise ValueError('wrapper JSON pointer에 금지된 토큰(__proto__/constructor/prototype)이 있습니다.')

def check_template(node, depth=0, count=None):
    count = [0] if count is None else count
    count[0] += 1
    if depth > MAX_DEPTH or count[0] > MAX_ITEMS:
        raise ValueError('wrapper map 깊이(20)/항목(1,000) 제한 초과')
    if isinstance(node, dict):
        if FORBIDDEN_KEYS & set(node): raise ValueError('wrapper map에 금지된 키(__proto__/constructor/prototype)가 있습니다.')
        if any(k.startswith('$') for k in node):
            if set(node) == {'$from'}: check_pointer(node['$from'])
            elif set(node) == {'$each', 'template'}:
                check_pointer(node['$each'])
                check_template(node['template'], depth + 1, count)
            else: raise ValueError('wrapper map 지시자는 {"$from"} 또는 {"$each","template"} 형식만 허용합니다.')
            return
        for v in node.values(): check_template(v, depth + 1, count)
    elif isinstance(node, list):
        for v in node: check_template(v, depth + 1, count)
    elif not (node is None or isinstance(node, (str, int, float))):
        raise ValueError('wrapper map 값은 JSON이어야 합니다.')

def validate_adapter(adapter):
    if not isinstance(adapter, dict) or set(adapter) != {'type', 'target', 'input', 'output'} or adapter['type'] != 'wrapper':
        raise ValueError('wrapper adapter 필드는 type/target/input/output만 허용합니다.')
    # Compact JSON measured in UTF-16 code units, the same count as JSON.stringify(...).length in the browser.
    try: size = len(json.dumps(adapter, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-16-le', 'surrogatepass')) // 2
    except (TypeError, ValueError): raise ValueError('wrapper 설정은 JSON이어야 합니다.') from None
    if size > MAX_CONFIG_CHARS: raise ValueError('wrapper 설정은 직렬화 32,000자 이내입니다.')
    target, given, output = adapter['target'], adapter['input'], adapter['output']
    if not isinstance(target, dict) or target.get('type') not in ('stdio', 'http'):
        raise ValueError('wrapper target은 stdio/http adapter 형식만 허용합니다(중첩 불가).')
    harness.validate_transport(target)
    mode = given.get('mode') if isinstance(given, dict) else None
    if mode not in MODES or set(given) != ({'mode', 'template'} if mode == 'template' else {'mode'}):
        raise ValueError('wrapper input은 mode(invocation/prompt/template/files)와 template 모드의 template만 허용합니다.')
    if mode == 'template': check_template(given['template'])
    if mode == 'files' and target['type'] != 'stdio': raise ValueError('wrapper files 모드는 stdio target만 허용합니다.')
    if target['type'] == 'stdio' and mode != 'files' and {a for a in target['args'] if a in PLACEHOLDERS} - {'{output}'}:
        raise ValueError('{input}/{prompt}/{schema} 자리표시자는 files 모드에서만 허용합니다.')
    if target['type'] == 'stdio' and any(a not in PLACEHOLDERS and PLACEHOLDER_TEXT.search(a) for a in target['args']):
        raise ValueError('wrapper args 자리표시자는 인자 하나 전체로만 씁니다.')
    if not isinstance(output, dict) or not {'source', 'format'} <= set(output) or set(output) - {'source', 'format', 'path', 'map', 'stageMaps'}:
        raise ValueError('wrapper output 필드는 source/format/path/map/stageMaps만 허용합니다.')
    if output['source'] not in SOURCES or output['format'] not in FORMATS:
        raise ValueError('wrapper output source는 stdout/file, format은 json/json-fence입니다.')
    if output['source'] == 'file' and target['type'] != 'stdio': raise ValueError('wrapper file 출력은 stdio target만 허용합니다.')
    if 'path' in output: check_pointer(output['path'])
    if 'map' in output: check_template(output['map'])
    if 'stageMaps' in output:
        if not isinstance(output['stageMaps'], dict) or set(output['stageMaps']) - set(STAGES):
            raise ValueError('wrapper stageMaps 키는 scan/selection/red/blue입니다.')
        for t in output['stageMaps'].values(): check_template(t)
    return adapter

def resolve_pointer(value, pointer):
    check_pointer(pointer)
    for token in pointer.split('/')[1:]:
        token = token.replace('~1', '/').replace('~0', '~')
        if isinstance(value, dict) and token in value: value = value[token]
        elif isinstance(value, list) and INDEX.fullmatch(token) and int(token) < len(value): value = value[int(token)]
        else: raise ValueError('wrapper 출력에 JSON pointer 경로가 없습니다. 기본값을 만들지 않습니다: ' + pointer[:200])
    return value

def _spend(value, budget):
    budget[0] -= 1
    if budget[0] < 0: raise ValueError('wrapper map 결과가 너무 큽니다.')
    for v in value.values() if isinstance(value, dict) else value if isinstance(value, list) else ():
        _spend(v, budget)

def apply_map(node, context, budget):
    if isinstance(node, dict):
        if set(node) == {'$from'}:
            value = resolve_pointer(context, node['$from'])
            _spend(value, budget)
            return value
        if set(node) == {'$each', 'template'}:
            items = resolve_pointer(context, node['$each'])
            if not isinstance(items, list) or len(items) > MAX_ITEMS: raise ValueError('wrapper $each 대상은 1,000개 이하 배열이어야 합니다.')
            _spend((), budget)
            return [apply_map(node['template'], item, budget) for item in items]
        _spend((), budget)
        return {k: apply_map(v, context, budget) for k, v in node.items()}
    _spend((), budget)
    return [apply_map(v, context, budget) for v in node] if isinstance(node, list) else node

def stage_of(schema):
    """scan/selection/red/blue from the invocation output schema; None when not exactly one matches."""
    props = schema.get('properties') if isinstance(schema, dict) else None
    if not isinstance(props, dict): return None
    found = [STAGE_KEYS[k] for k in props if k in STAGE_KEYS]
    return found[0] if len(found) == 1 else None

def transform_output(value, output, stage=None):
    """output.path, then stageMaps[stage] or map; identity when neither applies."""
    if 'path' in output: value = resolve_pointer(value, output['path'])
    maps = output.get('stageMaps', {})
    template = maps[stage] if stage in maps else output.get('map')
    if template is None: return value
    check_template(template)
    return json.loads(json.dumps(apply_map(template, value, [MAX_PRODUCED])))

def _reject_constant(_):
    raise ValueError('non-finite')

def _finite_float(text):
    value = float(text)
    if not math.isfinite(value): raise ValueError('non-finite')
    return value

def _finite_int(text):
    value = int(text)
    float(value)  # OverflowError beyond the double range, where JSON.parse yields Infinity
    return value

def parse_output(raw, fmt):
    if len(raw) > harness_adapter.MAX_OUTPUT_BYTES: raise ValueError('adapter 출력은 150,000바이트 이내입니다.')
    try:
        text = raw.decode('utf-8')  # a BOM is not JSON and is rejected, as in the browser
        if fmt == 'json-fence':
            # One whole fenced block; a second block, an embedded fence or surrounding prose fails.
            match = FENCE.fullmatch(text)
            if not match or '```' in match.group(1): raise ValueError('fence')
            text = match.group(1)
        return json.loads(text, parse_constant=_reject_constant, parse_float=_finite_float, parse_int=_finite_int)
    except Exception:
        raise ValueError('wrapper 출력이 선언한 형식(json/json-fence)이 아닙니다. 출력은 기록하지 않았습니다.') from None

def read_output_file(path):
    try: info = os.lstat(path)
    except FileNotFoundError: raise ValueError('wrapper 프로그램이 output.json을 만들지 않았습니다.') from None
    reparse = (getattr(info, 'st_file_attributes', 0) or 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0)
    if stat.S_ISLNK(info.st_mode) or reparse or not stat.S_ISREG(info.st_mode) or info.st_size > harness_adapter.MAX_OUTPUT_BYTES:
        raise ValueError('wrapper output.json은 150,000바이트 이하 일반 파일이어야 합니다(링크 불가).')
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode): raise ValueError('wrapper output.json은 일반 파일이어야 합니다.')
        return f.read(harness_adapter.MAX_OUTPUT_BYTES + 1)

class WrapperBackend:
    """AdapterBackend interface: one target call per infer, no automatic retry."""
    def __init__(self, harness, max_calls):
        validate_adapter(harness['adapter'])
        self.harness, self.max_calls, self.calls = harness, max_calls, 0
    def infer(self, prompt, schema):
        if self.calls >= self.max_calls: raise ValueError('adapter 호출 예산 초과')
        self.calls += 1
        adapter = self.harness['adapter']
        target, mode, output = adapter['target'], adapter['input']['mode'], adapter['output']
        invocation = harness_adapter.invocation(self.harness, prompt, schema, self.calls, self.max_calls)
        if mode == 'prompt': body = prompt.encode()
        elif mode == 'files': body = b''
        else:
            sent = apply_map(adapter['input']['template'], invocation, [MAX_PRODUCED]) if mode == 'template' else invocation
            body = json.dumps(sent, ensure_ascii=False).encode()
        if target['type'] == 'stdio':
            # Same trailing newline as the stdio AdapterBackend for JSON stdin; raw prompt text is sent as is.
            raw = self._run(target, mode, output, invocation, prompt, schema, body + b'\n' if mode in ('invocation', 'template') else body)
        else: raw = harness_adapter.post_https(target['url'], body, 'text/plain; charset=utf-8' if mode == 'prompt' else 'application/json')
        response = transform_output(parse_output(raw, output['format']), output, stage_of(schema))
        validate_shape(response, schema)
        return {'status': 'ok', 'response': response}
    def _run(self, target, mode, output, invocation, prompt, schema, body):
        with tempfile.TemporaryDirectory(prefix='falsify-wrapper-') as cwd:
            paths = {k: os.path.join(cwd, name) for k, name in PLACEHOLDERS.items()}
            if mode == 'files':
                for key, content in [('{input}', json.dumps(invocation, ensure_ascii=False)), ('{prompt}', prompt),
                                     ('{schema}', json.dumps(schema, ensure_ascii=False))]:
                    with open(paths[key], 'w', encoding='utf-8', newline='') as f: f.write(content)
            argv = [target['executable'], *(paths[a] if a in paths else a for a in target['args'])]
            with tempfile.TemporaryDirectory(prefix='falsify-wrapper-stdout-') as capture:
                raw = harness_adapter.run_stdio(argv, body, cwd, os.path.join(capture, 'stdout'))
            # Read before the temp dir is removed; stdout is ignored for file output.
            return read_output_file(paths['{output}']) if output['source'] == 'file' else raw
