"""Chart-to-table estimates from a PNG figure. Schema falsify.chart-data.v1.

Public API:
  extract_chart(png_bytes: bytes, engine=None, options=None) -> dict
  DeplotEngine().generate(png_bytes, prompt, options) -> str
  default_engine() -> DeplotEngine

Injection protocol:
  engine=None uses the process-wide lazy DeplotEngine. torch, transformers and
  PIL are imported only inside the first DeplotEngine.generate call. The engine
  does not download weights (local_files_only=True).
  An object with callable generate(png_bytes, prompt, options) is used as-is.
  Otherwise a callable with that same signature is used. generate wins when both
  exist. Either form must return the raw model string. Optional attributes read
  after the call, when present:
    provenance: dict with engine, model, revision, device, method
    generation_truncated: bool
    generation_token_limit: int
  DeplotEngine sets those itself. Injected callables without provenance are
  recorded as engine='injected'. Exceptions become status unavailable and are
  not retried. This module never calls a hosted chart API and has no credentials.

Default model:
  google/deplot revision 6e76d62430da16986be3426bae32301fb9115397
  AutoProcessor + Pix2StructForConditionalGeneration
  trust_remote_code=False, use_safetensors=True
  prompt: Generate underlying data table of the figure below:
  device: cuda when torch.cuda.is_available(), otherwise cpu

Parse:
  <0x0A> and newlines separate rows. | separates cells. Markdown ruler rows are
  ignored. The first row is column labels. Later rows are data. Empty cells are
  null. rawOutput is the engine string unchanged. Numeric values are finite
  floats copied out of a cell, with the cell text kept in raw. Percent is not
  divided by 100. origin is always model-estimate. There is no confidence and
  no ground-truth label. Axis scale is never read from the table text. title,
  chartType and axes change only when options supplies them.

Limits:
  30MB encoded PNG, 12M pixels, 1024 new tokens, 500 data rows.
  options max_new_tokens and max_rows may only lower those caps.
"""
import hashlib
import math
import re
import struct
import threading
from pathlib import Path

SCHEMA = 'falsify.chart-data.v1'
MODEL_ID = 'google/deplot'
MODEL_REVISION = '6e76d62430da16986be3426bae32301fb9115397'
PROMPT = 'Generate underlying data table of the figure below:'
MAX_NEW_TOKENS = 1024
MAX_ROWS = 500
MAX_ENCODED_BYTES = 30 * 1024 * 1024
MAX_PIXELS = 12_000_000
ORIGIN = 'model-estimate'
_PNG = b'\x89PNG\r\n\x1a\n'
_RESULT_KEYS = ('schema', 'status', 'image', 'columns', 'rows', 'numericCells', 'title',
    'chartType', 'axes', 'provenance', 'issues', 'rawOutput')
_TRANS = str.maketrans({
    '−': '-', '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5',
    '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+',
})
_NONFINITE = re.compile(
    r'^(?:[\$£€¥₩]\s*)?(?:nan|[-+]?inf(?:inity)?|[-+]?\u221e)'
    r'(?:\s*(?:%|\u00b0[CFK]?|[A-Za-z\u00b5\u03bc][A-Za-z0-9\u00b5\u03bc\u00b0/^*+\-]*))?$',
    re.IGNORECASE)
_NUMBER = re.compile(
    r'^(?P<prefix>[\$£€¥₩])?\s*'
    r'(?P<body>[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?'
    r'(?:[eE][+-]?\d+|\s*[×xX]\s*10\s*\^?\s*[+-]?\d+)?)'
    r'\s*(?P<suffix>%|\u00b0[CFK]?|[A-Za-z\u00b5\u03bc][A-Za-z0-9\u00b5\u03bc\u00b0/^*+\-]*)?$')
_TIMES_TEN = re.compile(r'\s*[×xX]\s*10\s*\^?\s*')
_ROW_SPLIT = re.compile(r'<0x0[aA]>')
_SCALES = ('unknown', 'linear', 'log')
_default_engine = None
_engine_lock = threading.Lock()


def _load_deplot_stack():
    import torch
    from transformers import AutoProcessor, Pix2StructForConditionalGeneration
    return torch, AutoProcessor, Pix2StructForConditionalGeneration


def _open_rgb(png_bytes):
    import io
    from PIL import Image
    with Image.open(io.BytesIO(png_bytes)) as image:
        return image.convert('RGB')


def _configure_header_font(processor):
    image_processor = getattr(processor, 'image_processor', None)
    render = getattr(image_processor, 'render_header', None)
    if not callable(render): return
    font = Path(__file__).resolve().parents[1] / 'dist/vendor/standard_fonts/LiberationSans-Regular.ttf'
    # Transformers 5.16 exposes font_path in render_header but rejects it in
    # preprocess's TypedDict. Bind the font on this owned processor instance.
    def local_header(image, header, **kwargs):
        kwargs['font_path'] = str(font)
        return render(image, header, **kwargs)
    image_processor.render_header = local_header


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _blank_image():
    return {'sha256': None, 'width': None, 'height': None}


def _axes():
    return {
        'x': {'label': None, 'scale': 'unknown', 'unit': None},
        'y': {'label': None, 'scale': 'unknown', 'unit': None},
    }


def _cap(value, default, upper):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    if number < 1:
        return 1
    return min(number, upper)


def _token_limit(options):
    if not isinstance(options, dict):
        return MAX_NEW_TOKENS
    return _cap(options.get('max_new_tokens', MAX_NEW_TOKENS), MAX_NEW_TOKENS, MAX_NEW_TOKENS)


def _row_limit(options):
    if not isinstance(options, dict):
        return MAX_ROWS
    return _cap(options.get('max_rows', MAX_ROWS), MAX_ROWS, MAX_ROWS)


def _image_info(png_bytes):
    if type(png_bytes) is not bytes:
        return _blank_image(), 'png_bytes must be bytes'
    image = {'sha256': _sha(png_bytes), 'width': None, 'height': None}
    if len(png_bytes) > MAX_ENCODED_BYTES:
        return image, 'input exceeds 30MB'
    if len(png_bytes) < 24 or not png_bytes.startswith(_PNG):
        return image, 'invalid png'
    length = struct.unpack('>I', png_bytes[8:12])[0]
    if length != 13 or png_bytes[12:16] != b'IHDR':
        return image, 'invalid png'
    width, height = struct.unpack('>II', png_bytes[16:24])
    if width < 1 or height < 1:
        return image, 'invalid png'
    image['width'] = int(width)
    image['height'] = int(height)
    if width * height > MAX_PIXELS:
        return image, 'input exceeds 12M pixels'
    return image, None


def _grounding(options):
    title = None
    chart_type = 'unknown'
    axes = _axes()
    issues = []
    raw_title = options.get('title')
    if type(raw_title) is str and raw_title.strip():
        title = raw_title.strip()
    raw_type = options.get('chartType')
    if type(raw_type) is str and raw_type.strip():
        chart_type = raw_type.strip()
    given = options.get('axes')
    if given is None:
        return title, chart_type, axes, issues
    if type(given) is not dict:
        issues.append('invalid grounded axes')
        return title, chart_type, axes, issues
    for name in ('x', 'y'):
        source = given.get(name)
        if source is None:
            continue
        if type(source) is not dict:
            issues.append('invalid grounded %s axis' % name)
            continue
        label, unit = source.get('label'), source.get('unit')
        scale = source.get('scale', 'unknown')
        if label is not None and type(label) is not str:
            issues.append('invalid grounded %s axis label' % name)
            label = None
        if unit is not None and type(unit) is not str:
            issues.append('invalid grounded %s axis unit' % name)
            unit = None
        if scale not in _SCALES:
            issues.append('invalid axis scale for %s' % name)
            scale = 'unknown'
        axes[name] = {'label': label, 'scale': scale, 'unit': unit}
    return title, chart_type, axes, issues


def _is_rule(line):
    if '|' not in line or '-' not in line:
        return False
    return line.replace('|', '').replace(':', '').replace('-', '').strip() == ''


def _lines(raw):
    text = _ROW_SPLIT.sub('\n', raw.replace('\r\n', '\n').replace('\r', '\n'))
    lines = []
    for line in text.split('\n'):
        stripped = line.strip()
        if stripped and not _is_rule(stripped):
            lines.append(stripped)
    return lines


def _is_prose(lines):
    if any('|' in line for line in lines):
        return False
    return any(len(line.split()) >= 5 for line in lines)


def _cells(line):
    parts = [part.strip() for part in line.split('|')]
    if len(parts) >= 3 and parts[0] == '' and parts[-1] == '':
        parts = parts[1:-1]
    return [part if part else None for part in parts]


def _labels(columns):
    issues = []
    seen = {}
    for index, name in enumerate(columns):
        if name == '':
            issues.append('missing label at column %d' % index)
        elif name in seen:
            issues.append('duplicate label at column %d: %s' % (index, name))
        else:
            seen[name] = index
    return issues


def _parse_table(raw):
    lines = _lines(raw)
    if not lines:
        return None
    if _is_prose(lines):
        return 'unsupported'
    parsed_rows = [_cells(line) for line in lines]
    header = parsed_rows[0]
    header_width = len(header)
    data = parsed_rows[1:]
    width = max([header_width, *[len(row) for row in data]])
    columns = ['' if cell is None else cell for cell in header]
    if len(columns) < width:
        columns.extend([''] * (width - len(columns)))
    rows = []
    malformed = []
    for index, row in enumerate(data):
        actual = len(row)
        if actual != header_width:
            malformed.append('malformed width at row %d: expected %d, got %d' % (index, header_width, actual))
        if actual < width:
            row = row + [None] * (width - actual)
        rows.append(row)
    issues = _labels(columns) + malformed
    if not rows:
        issues.append('no data rows')
    return columns, rows, issues


def _parse_number(text):
    translated = text.translate(_TRANS)
    if _NONFINITE.match(translated):
        return 'nonfinite'
    match = _NUMBER.match(translated)
    if match is None:
        return None
    body = _TIMES_TEN.sub('e', match.group('body').replace(',', '').replace(' ', ''))
    try:
        value = float(body)
    except ValueError:
        return None
    if not math.isfinite(value):
        return 'nonfinite'
    suffix, prefix = match.group('suffix'), match.group('prefix')
    return value, suffix if suffix else prefix


def _numeric_cells(rows):
    cells, issues = [], []
    for row_index, row in enumerate(rows):
        for column, text in enumerate(row):
            if text is None:
                continue
            parsed = _parse_number(text)
            if parsed == 'nonfinite':
                issues.append('nonfinite value at row %d column %d' % (row_index, column))
            elif parsed is not None:
                value, unit = parsed
                cells.append({'row': row_index, 'column': column, 'raw': text, 'value': value,
                    'unit': unit, 'origin': ORIGIN})
    return cells, issues


def _provenance(engine):
    raw = getattr(engine, 'provenance', None)
    if type(raw) is dict:
        return {key: raw.get(key) for key in ('engine', 'model', 'revision', 'device', 'method')}
    return {'engine': 'injected', 'model': None, 'revision': None, 'device': None, 'method': 'injected'}


def _result(status, image, issues, raw, provenance, columns=None, rows=None, numeric=None,
        title=None, chart_type='unknown', axes=None):
    return {
        'schema': SCHEMA,
        'status': status,
        'image': image,
        'columns': [] if columns is None else columns,
        'rows': [] if rows is None else rows,
        'numericCells': [] if numeric is None else numeric,
        'title': title,
        'chartType': chart_type,
        'axes': _axes() if axes is None else axes,
        'provenance': provenance,
        'issues': list(issues),
        'rawOutput': raw,
    }


def _unavailable(image, issues, raw, provenance, title=None, chart_type='unknown', axes=None):
    return _result('unavailable', image, issues, raw, provenance, title=title,
        chart_type=chart_type, axes=axes)


def _invoke(engine, png_bytes, options):
    generate = getattr(engine, 'generate', None)
    if callable(generate):
        return generate(png_bytes, PROMPT, options)
    if callable(engine):
        return engine(png_bytes, PROMPT, options)
    raise TypeError('engine must be callable or provide generate')


class DeplotEngine:
    """Lazy native DePlot. Safe to construct at import; weights load on generate."""

    def __init__(self):
        self.device = None
        self.generation_truncated = False
        self.generation_token_limit = MAX_NEW_TOKENS
        self._lock = threading.Lock()
        self._processor = None
        self._model = None

    @property
    def provenance(self):
        return {
            'engine': 'transformers',
            'model': MODEL_ID,
            'revision': MODEL_REVISION,
            'device': self.device,
            'method': 'pix2struct-deplot',
        }

    def generate(self, png_bytes, prompt, options=None):
        with self._lock:
            return self._generate(png_bytes, prompt, options)

    def _generate(self, png_bytes, prompt, options):
        torch, auto_processor, model_cls = _load_deplot_stack()
        if self._model is None:
            self.device = 'cuda' if torch.cuda.is_available() else 'cpu'
            self._processor = auto_processor.from_pretrained(
                MODEL_ID, revision=MODEL_REVISION, trust_remote_code=False, local_files_only=True)
            _configure_header_font(self._processor)
            self._model = model_cls.from_pretrained(
                MODEL_ID, revision=MODEL_REVISION, trust_remote_code=False,
                use_safetensors=True, local_files_only=True)
            self._model.to(self.device)
            self._model.eval()
        image = _open_rgb(png_bytes)
        limit = _token_limit(options)
        self.generation_token_limit = limit
        # Reuse the bundled OFL font instead of Transformers' implicit network
        # download of an unrelated Arial font repository during preprocessing.
        inputs = self._processor(images=image, text=prompt, return_tensors='pt')
        moved = {key: value.to(self.device) if hasattr(value, 'to') else value
            for key, value in dict(inputs).items()}
        with torch.inference_mode():
            output = self._model.generate(**moved, max_new_tokens=limit)
        tokens = output.sequences if hasattr(output, 'sequences') else output
        self.generation_truncated = int(tokens.shape[-1]) >= limit
        return self._processor.decode(tokens[0], skip_special_tokens=True)


def default_engine():
    global _default_engine
    with _engine_lock:
        if _default_engine is None:
            _default_engine = DeplotEngine()
        return _default_engine


def _geometry_result(geometry,image):
    from paper_chart_vectors import rows_from_geometry
    columns,rows,numeric=rows_from_geometry(geometry)
    axes=geometry['axes']
    yaxes=[side for side in ('left','right') if side in axes]
    result=_result(geometry['status'],image,geometry['issues'],'',
        {'engine':geometry.get('provenance',{}).get('engine','opencv+rapidocr'),'model':None if geometry.get('provenance') else 'en_PP-OCRv5_rec_mobile','revision':geometry.get('provenance',{}).get('revision','geometry-2'),
         'device':'cpu','method':geometry.get('provenance',{}).get('method','ocr-tick-pixel-calibration')},columns,rows,numeric,
        None,'xy',{'x':{'label':None,'scale':axes['x']['scale'],'unit':None},
                   'y':{'label':None,'scale':axes[yaxes[0]]['scale'] if len(yaxes)==1 else 'multiple','unit':None}})
    result['geometry']=geometry
    result['pointKind']=geometry.get('pointKind','curve-sample')
    return result


def _extract_geometry(png_bytes, options, image, title, axes):
    try:
        from paper_plottracer import trace_geometry
        geometry=trace_geometry(png_bytes,manual=options.get('chartOptions'))
        if geometry['status'] in ('ready','partial') and geometry['series']:
            return _geometry_result(geometry,image)
    except (ImportError,OSError):
        geometry={'status':'unavailable','issues':['plottracer-runtime-missing'],'series':[],'axes':{}}
    # A model's parseable table is not an alternative axis calibration.
    # Keep the source image available so callers can supply ticks/colors.
    result=_result('partial',image,geometry.get('issues',[]),'',
        {'engine':'plottracer','model':None,'revision':'dcc28a5da453ff5c4e7cadd4478523560d15c0dc','device':'cpu','method':'calibration-required'},
        ['series','axis','x','y'],[],[],title,'xy',axes)
    result['geometry']=geometry
    result['pointKind']='curve-sample'
    return result


def _table_lines_and_title(raw, title):
    # DePlot emits an optional TITLE metadata row before the actual header.
    # Keep rawOutput byte-for-byte, while presenting the real series columns.
    table_lines = _lines(raw)
    if len(table_lines) >= 2:
        first = _cells(table_lines[0])
        if len(first) == 2 and first[0] == 'TITLE':
            if title is None: title = first[1]
            table_lines = table_lines[1:]
    return table_lines, title


def extract_chart(png_bytes, engine=None, options=None):
    """Return a falsify.chart-data.v1 dict. See the module docstring for injection."""
    image, image_issue = _image_info(png_bytes)
    if image_issue:
        return _unavailable(image, [image_issue], '', {'engine': None, 'model': None,
            'revision': None, 'device': None, 'method': None})
    if options is None:
        options = {}
    elif type(options) is not dict:
        return _unavailable(image, ['options must be a dict'], '', {'engine': None, 'model': None,
            'revision': None, 'device': None, 'method': None})
    title, chart_type, axes, issues = _grounding(options)
    geometry=None
    if engine is None:
        return _extract_geometry(png_bytes, options, image, title, axes)
    selected = default_engine() if engine is None else engine
    try:
        raw = _invoke(selected, png_bytes, options)
    except Exception as exc:
        issues.append('engine failure: %s: %s' % (type(exc).__name__, exc))
        return _unavailable(image, issues, '', _provenance(selected), title, chart_type, axes)
    provenance = _provenance(selected)
    if type(raw) is not str:
        issues.append('engine returned non-string output')
        return _unavailable(image, issues, '', provenance, title, chart_type, axes)
    if getattr(selected, 'generation_truncated', False):
        limit = getattr(selected, 'generation_token_limit', MAX_NEW_TOKENS)
        issues.append('generation truncated at %d tokens' % int(limit))
    table_lines, title = _table_lines_and_title(raw, title)
    parsed = _parse_table('\n'.join(table_lines))
    if parsed is None:
        issues.append('empty output')
        return _unavailable(image, issues, raw, provenance, title, chart_type, axes)
    if parsed == 'unsupported':
        issues.append('unsupported output')
        return _unavailable(image, issues, raw, provenance, title, chart_type, axes)
    columns, rows, parse_issues = parsed
    issues.extend(parse_issues)
    limit = _row_limit(options)
    if len(rows) > limit:
        rows = rows[:limit]
        issues.append('truncated to %d rows' % limit)
    numeric, numeric_issues = _numeric_cells(rows)
    issues.extend(numeric_issues)
    status = 'partial' if issues else 'ready'
    result=_result(status, image, issues, raw, provenance, columns, rows, numeric, title, chart_type, axes)
    if geometry is not None:result['geometry']=geometry
    return result


def result_keys():
    return _RESULT_KEYS
