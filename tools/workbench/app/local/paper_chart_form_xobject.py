"""Nested PDF Form XObject traversal and occurrence-isolated rewriting."""

import io
import paper_chart_paint as paint

MAX_FORM_DEPTH = 4


def effective_resources(pk, obj):
    """Return inherited or direct /Resources dictionary for a page or Form."""
    node = obj
    seen = set()
    while node is not None and id(node) not in seen:
        seen.add(id(node))
        res = node.get('/Resources')
        if isinstance(res, pk.Dictionary):
            return res
        node = node.get('/Parent')
    return None


def _lookup_form(pk, res_chain, name):
    for res in res_chain:
        found = paint._lookup(res, name)
        if found is not None:
            return found
    return None


def _do_operand_name(pk, operands):
    if not operands:
        return None, None
    kind, tok_index, raw = operands[0]
    if kind != 'name':
        return None, None
    text = raw.decode('latin1').strip() if isinstance(raw, (bytes, bytearray)) else str(raw).strip()
    if not text.startswith('/'):
        return None, None
    return tok_index, text[1:]


def _resource_chain_for_form(pk, form_obj, fallback_chain):
    own = form_obj.get('/Resources')
    if isinstance(own, pk.Dictionary):
        return (own, *fallback_chain)
    return fallback_chain


def maybe_parse_form_do(
    pk,
    operands,
    state,
    res_chain,
    display_tm,
    content_index,
    form_path,
    visited,
    depth,
    forms_tokens,
    parse_fn,
    out_marks,
    out_strokes,
):
    """Recurse into a /Subtype /Form XObject invoked by `Do` up to MAX_FORM_DEPTH."""
    if depth >= MAX_FORM_DEPTH:
        return
    tok_index, name = _do_operand_name(pk, operands)
    if name is None:
        return
    target = _lookup_form(pk, res_chain, name)
    if target is None or not hasattr(target, 'read_bytes'):
        return
    if str(target.get('/Subtype')) != '/Form':
        return
    objgen = tuple(target.objgen)
    if objgen in visited:
        return
    child_tokens = forms_tokens.get(objgen)
    if child_tokens is None:
        child_tokens = paint._tokens(pk, target.read_bytes())
        forms_tokens[objgen] = child_tokens
    child_state = {**state, 'ctm': paint._mul(paint._matrix_of(target), state['ctm'])}
    child_res = _resource_chain_for_form(pk, target, res_chain)
    child_path = (*form_path, (name, int(tok_index), objgen))
    found, lines = parse_fn(
        pk,
        child_tokens,
        display_tm,
        content_index,
        res_chain=child_res,
        init_state=child_state,
        form_path=child_path,
        visited=visited | {objgen},
        depth=depth + 1,
        forms_tokens=forms_tokens,
    )
    out_marks.extend(found)
    out_strokes.extend(lines)


def path_key(mark):
    """Canonical hashable key for a mark's Form XObject invocation path."""
    steps = mark.get('formPath') or ()
    return tuple((str(s['name']), int(s['nameTokIndex']), tuple(int(v) for v in s['objgen'])) for s in steps)


def collect_form_tokens(pk, page):
    """Collect tokenized streams for all reachable Form XObjects on a page."""
    forms = {}
    visited = set()

    def walk_res(res_obj, depth):
        if depth > MAX_FORM_DEPTH or not isinstance(res_obj, pk.Dictionary):
            return
        xobjs = res_obj.get('/XObject')
        if not isinstance(xobjs, pk.Dictionary):
            return
        for key in xobjs.keys():
            obj = xobjs.get(key)
            if obj is None or not hasattr(obj, 'read_bytes') or str(obj.get('/Subtype')) != '/Form':
                continue
            og = tuple(obj.objgen)
            if og in visited:
                continue
            visited.add(og)
            forms[og] = paint._tokens(pk, obj.read_bytes())
            walk_res(obj.get('/Resources'), depth + 1)

    walk_res(effective_resources(pk, page.obj), 1)
    return forms


def _isolate_with_fallback(pk, owner, fallback_res, additions):
    if not additions:
        return
    base_res = owner.get('/Resources') if isinstance(owner.get('/Resources'), pk.Dictionary) else fallback_res
    base_res = base_res if isinstance(base_res, pk.Dictionary) else pk.Dictionary()
    xobjects = base_res.get('/XObject')
    xobjects = xobjects if isinstance(xobjects, pk.Dictionary) else pk.Dictionary()
    copied_x = pk.Dictionary({key: xobjects.get(key) for key in xobjects.keys()})
    for name, stream in additions:
        copied_x[pk.Name('/' + name)] = stream
    copied = pk.Dictionary({key: base_res.get(key) for key in base_res.keys()})
    copied.XObject = copied_x
    owner.Resources = copied


def _collect_existing_names(pk, pdf, page, res_obj, existing, blobs, visited):
    if isinstance(res_obj, pk.Dictionary):
        xobjs = res_obj.get('/XObject')
        if isinstance(xobjs, pk.Dictionary):
            for key in xobjs.keys():
                skey = str(key)
                existing.add(skey if skey.startswith('/') else '/' + skey)
                child = xobjs.get(key)
                _collect_form_blob(pk, child, existing, blobs, visited)


def _collect_form_blob(pk, child, existing, blobs, visited):
    if child is None or not hasattr(child, 'read_bytes'):
        return
    og = tuple(child.objgen)
    if og in visited or str(child.get('/Subtype')) != '/Form':
        return
    visited.add(og)
    blobs.append(child.read_bytes())
    _collect_existing_names(pk, None, None, child.get('/Resources'), existing, blobs, visited)


def _split_node_edits(items):
    direct = {'replacements': {}, 'drops': set()}
    children = {}
    for subpath, replacements, drops in items:
        if not subpath:
            direct['replacements'].update(replacements)
            direct['drops'].update(drops)
        else:
            children.setdefault(subpath[0], []).append((subpath[1:], replacements, drops))
    return direct, children


def _rewrite_node(pk, pdf, fallback_res, raw_tokens, items, existing, blobs):
    direct, children = _split_node_edits(items)
    rep = dict(direct['replacements'])
    drops = set(direct['drops'])
    additions = []
    for (child_name, tok_idx, child_objgen), sub_items in children.items():
        child_form = paint._object(pdf, child_objgen)
        child_tokens = paint._tokens(pk, child_form.read_bytes())
        own_res = child_form.get('/Resources')
        child_fallback = own_res if isinstance(own_res, pk.Dictionary) else fallback_res
        new_child_bytes, child_additions = _rewrite_node(pk, pdf, child_fallback, child_tokens, sub_items, existing, blobs)
        cloned_child = paint._copy_stream(pk, pdf, child_form, new_child_bytes)
        _isolate_with_fallback(pk, cloned_child, child_fallback, child_additions)
        base_prefix = '%s_falsify' % child_name.lstrip('/')
        fresh_name = paint._fresh_name(existing, blobs, base_prefix)
        blobs.append(new_child_bytes)
        additions.append((fresh_name, cloned_child))
        rep[int(tok_idx)] = '/' + fresh_name
    return paint._join(raw_tokens, rep, drops), additions


def apply_tree_edits(raw, page_index, streams_bundle, edits):
    """Apply top-level and Form-nested edits while isolating shared Form XObjects."""
    pk, _mu = paint._deps()
    pdf = pk.open(io.BytesIO(raw))
    try:
        page = pdf.pages[page_index]
        page_res = effective_resources(pk, page.obj)
        existing = set()
        blobs = [s.read_bytes() for s in paint._contents(pk, page)]
        _collect_existing_names(pk, pdf, page, page_res, existing, blobs, set())
        by_content = {}
        for (content_index, fpath), edit in edits.items():
            if not edit['replacements'] and not edit['drops']:
                continue
            by_content.setdefault(content_index, []).append((fpath, edit['replacements'], edit['drops']))
        for content_index, items in by_content.items():
            new_bytes, additions = _rewrite_node(
                pk, pdf, page_res, streams_bundle['contents'][content_index], items, existing, blobs
            )
            paint._write_content(pk, pdf, page, content_index, new_bytes)
            _isolate_with_fallback(pk, page.obj, page_res, additions)
        return paint._save(pk, pdf)
    finally:
        pdf.close()
