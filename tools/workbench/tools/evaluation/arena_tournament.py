"""N by M RED-vs-BLUE tournament with Bradley-Terry and Elo ratings.

Pairwise duels reuse ``arena_duel.run_duel``. Inject ``duel_fn`` in tests.
Only sanitized numeric metrics are kept. The public document must pass
``arena_round._scrub`` and carries no gold quotes, paths, or answer keys.
"""
from __future__ import annotations

import math
from pathlib import Path
import re
import sys
import time

_EVAL_DIR = Path(__file__).resolve().parent
if str(_EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(_EVAL_DIR))

import arena_duel  # noqa: E402
import arena_round  # noqa: E402

SCHEMA = 'falsify.arena-tournament.v1'
WORLDS = ('W1', 'W2', 'W3', 'W4', 'W5')
LEVELS = ('L1', 'L2', 'L3', 'L4')
_ID_RE = re.compile(r'^[A-Za-z0-9_.-]{1,64}$')
_PSEUDO_WINS = 0.5
_MM_STEPS = 80
_BLUE_SPECS = (
    ('meanRecall', True),
    ('totalHoldoutPureFp', False),
    ('meanElapsedMs', False),
)
_RED_SPECS = (
    ('meanEvasionRate', True),
    ('meanStealthYield', True),
)


def _finite(value) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(float(value))


def _number(value, default: float = 0.0) -> float:
    if not _finite(value):
        return default
    return float(value)


def _require_positive(value, code: str) -> float:
    if not _finite(value) or float(value) <= 0:
        raise ValueError(code)
    return float(value)


def _require_finite(value, code: str) -> float:
    if not _finite(value):
        raise ValueError(code)
    return float(value)


def _require_bool(value, code: str) -> bool:
    if type(value) is not bool:
        raise ValueError(code)
    return value


def _require_timeout(value) -> int:
    if isinstance(value, bool) or type(value) is not int or value < 1:
        raise ValueError('invalid_timeout')
    return value


def _require_participants(participant_ids) -> list[str]:
    if not isinstance(participant_ids, list) or not participant_ids:
        raise ValueError('invalid_participants')
    seen: set[str] = set()
    cleaned = []
    for ident in participant_ids:
        if not isinstance(ident, str) or not ident.strip() or ident in seen:
            raise ValueError('invalid_participants')
        seen.add(ident)
        cleaned.append(ident)
    return cleaned


def _score(value) -> float:
    number = _require_finite(value, 'invalid_matchup')
    if number < 0.0 or number > 1.0:
        raise ValueError('invalid_matchup')
    return number


def _one_matchup(item, known: set[str]) -> tuple[str, str, float]:
    if not isinstance(item, dict):
        raise ValueError('invalid_matchup')
    left = item.get('a')
    right = item.get('b')
    if left not in known or right not in known or left == right:
        raise ValueError('invalid_matchup')
    return left, right, _score(item.get('scoreA'))


def _parse_matchups(matchups, allowed: list[str]) -> list[tuple[str, str, float]]:
    if not isinstance(matchups, list):
        raise ValueError('invalid_matchup')
    known = set(allowed)
    return [_one_matchup(item, known) for item in matchups]


def _wins_and_games(ids: list[str], games: list[tuple[str, str, float]]):
    wins = {ident: _PSEUDO_WINS for ident in ids}
    played = {ident: {other: 0.0 for other in ids if other != ident} for ident in ids}
    for left, right, score in games:
        wins[left] += score
        wins[right] += 1.0 - score
        played[left][right] += 1.0
        played[right][left] += 1.0
    return wins, played


def _mm_step(ids, wins, played, strength) -> dict:
    updated = {}
    for ident in ids:
        denom = 0.0
        for other, count in played[ident].items():
            if count:
                denom += count / (strength[ident] + strength[other])
        updated[ident] = wins[ident] if denom == 0.0 else wins[ident] / denom
    return updated


def _scale(weights: dict) -> dict:
    total = sum(weights.values())
    if total <= 0:
        share = 1.0 / len(weights)
        return {key: share for key in weights}
    return {key: value / total for key, value in weights.items()}


def _converged(previous: dict, updated: dict) -> bool:
    gap = max(abs(updated[key] - previous[key]) for key in previous)
    return gap < 1e-12


def _normalize_strengths(ids: list[str], weights: dict) -> dict:
    ordered = sorted(ids)
    total = sum(weights[item] for item in ordered)
    rounded = [round(weights[item] / total, 6) for item in ordered]
    drift = round(1.0 - sum(rounded), 6)
    rounded[-1] = round(rounded[-1] + drift, 6)
    by_id = {ident: value for ident, value in zip(ordered, rounded)}
    return {ident: by_id[ident] for ident in ids}


def _mm(ids: list[str], wins: dict, played: dict) -> dict:
    strength = {ident: 1.0 / len(ids) for ident in ids}
    for _step in range(_MM_STEPS):
        updated = _scale(_mm_step(ids, wins, played, strength))
        if _converged(strength, updated):
            return _normalize_strengths(ids, updated)
        strength = updated
    return _normalize_strengths(ids, strength)


def _expected(left: float, right: float) -> float:
    return 1.0 / (1.0 + 10 ** ((right - left) / 400.0))


def _batch_elo(ids: list[str], games, base: float, factor: float) -> dict:
    ratings = {ident: base for ident in ids}
    actual = {ident: 0.0 for ident in ids}
    expected = {ident: 0.0 for ident in ids}
    for left, right, score in games:
        chance = _expected(ratings[left], ratings[right])
        actual[left] += score
        actual[right] += 1.0 - score
        expected[left] += chance
        expected[right] += 1.0 - chance
    return {
        ident: base + factor * (actual[ident] - expected[ident])
        for ident in ids
    }


def compute_bradley_terry_and_elo(
    matchups: list[dict],
    participant_ids: list[str],
    *,
    base_elo: float = 1500.0,
    k_factor: float = 32.0,
) -> dict:
    """Order-invariant Bradley-Terry MM (Laplace 0.5) and batch Elo."""
    ids = _require_participants(participant_ids)
    base = _require_finite(base_elo, 'invalid_elo')
    factor = _require_positive(k_factor, 'invalid_elo')
    games = _parse_matchups(matchups, ids)
    wins, played = _wins_and_games(ids, games)
    return {
        'bradleyTerry': _mm(ids, wins, played),
        'elo': _batch_elo(ids, games, base, factor),
    }


def _require_sources(source_pdfs) -> list[Path]:
    if not isinstance(source_pdfs, list) or not 1 <= len(source_pdfs) <= 16:
        raise ValueError('invalid_source_pdfs')
    sources = []
    for item in source_pdfs:
        if not isinstance(item, (str, Path)) or not str(item).strip():
            raise ValueError('invalid_source_pdfs')
        sources.append(Path(item))
    return sources


def _optional_paths(values, code: str) -> list[Path]:
    if values is None:
        return []
    if not isinstance(values, list):
        raise ValueError(code)
    paths = []
    for item in values:
        if not isinstance(item, (str, Path)) or not str(item).strip():
            raise ValueError(code)
        paths.append(Path(item))
    return paths


def _valid_argv(argv) -> bool:
    if not isinstance(argv, list) or not argv:
        return False
    return all(isinstance(item, str) and item.strip() for item in argv)


def _require_entry(entry, seen: set[str], need_argv: bool) -> dict:
    if not isinstance(entry, dict):
        raise ValueError('invalid_contender')
    ident = entry.get('id')
    if not isinstance(ident, str) or _ID_RE.fullmatch(ident) is None or ident in seen:
        raise ValueError('invalid_contender_id')
    argv = entry.get('argv')
    if need_argv and not _valid_argv(argv):
        raise ValueError('invalid_argv')
    seen.add(ident)
    return {'id': ident, 'argv': list(argv or [])}


def _require_entries(entries, code: str, need_argv: bool, seen: set[str]) -> list[dict]:
    if not isinstance(entries, list) or not 1 <= len(entries) <= 8:
        raise ValueError(code)
    return [_require_entry(entry, seen, need_argv) for entry in entries]


def _read_bytes(path: Path, code: str) -> bytes:
    try:
        return path.read_bytes()
    except OSError as error:
        raise ValueError(code) from error


def _read_pdf(path: Path) -> bytes:
    raw = _read_bytes(path, 'invalid_source_pdfs')
    if not raw.startswith(b'%PDF-'):
        raise ValueError('invalid_source_pdfs')
    return raw


def _named_bytes(paths: list[Path], code: str) -> list[dict]:
    rows = []
    for path in paths:
        rows.append({'name': path.name, 'bytes': _read_bytes(path, code)})
    return rows


def _builtin_duel(source: Path, red: dict, blue: dict, settings: dict) -> dict:
    return arena_duel.run_duel(
        _read_pdf(source),
        red_argv=list(red['argv']),
        blue_argv=list(blue['argv']),
        supplements=_named_bytes(settings['supplements'], 'invalid_supplements'),
        holdout_pdfs=_named_bytes(settings['holdouts'], 'invalid_holdouts'),
        min_difficulty=settings['min_difficulty'],
        timeout=settings['timeout'],
        validate_quotes=settings['validate_quotes'],
    )


def _dig(node, path: tuple[str, ...]) -> dict:
    for key in path:
        if not isinstance(node, dict):
            return {}
        node = node.get(key)
    if isinstance(node, dict):
        return node
    return {}


def _aggregate(duel: dict) -> dict:
    paths = (
        ('round', 'evaluation', 'aggregate'),
        ('evaluation', 'aggregate'),
        ('aggregate',),
    )
    for path in paths:
        found = _dig(duel, path)
        if found:
            return found
    return {}


def _aurc_value(duel: dict, aggregate: dict) -> float:
    nodes = (
        aggregate.get('selectivePrediction'),
        aggregate.get('selective'),
        duel.get('selectivePrediction'),
    )
    for node in nodes:
        if isinstance(node, dict) and _finite(node.get('aurc')):
            return float(node['aurc'])
    return 0.0


def _holdout_value(duel: dict) -> float:
    summary = duel.get('holdoutSummary')
    if isinstance(summary, dict) and _finite(summary.get('totalPureFp')):
        return float(summary['totalPureFp'])
    return _number(duel.get('holdoutPureFp'))


def _pull_metric(duel: dict, key: str) -> float:
    if key in duel and _finite(duel.get(key)):
        return float(duel[key])
    aggregate = _aggregate(duel)
    if key == 'holdoutPureFp':
        return _holdout_value(duel)
    if key == 'aurc':
        return _aurc_value(duel, aggregate)
    return _number(aggregate.get(key))


def _paper_metrics(duel, elapsed_ms: float) -> dict:
    if not isinstance(duel, dict):
        raise ValueError('invalid_duel')
    metrics = {
        'recall': _pull_metric(duel, 'recall'),
        'stealthYield': _pull_metric(duel, 'stealthYield'),
        'holdoutPureFp': _pull_metric(duel, 'holdoutPureFp'),
        'aurc': _pull_metric(duel, 'aurc'),
        'elapsedMs': _pull_metric(duel, 'elapsedMs'),
    }
    if not ( 'elapsedMs' in duel and _finite(duel.get('elapsedMs'))):
        metrics['elapsedMs'] = elapsed_ms
    return metrics


def _invoke(duel_fn, source: Path, red: dict, blue: dict, settings: dict):
    started = time.perf_counter()
    if duel_fn is None:
        result = _builtin_duel(source, red, blue, settings)
    else:
        result = duel_fn(source, red, blue)
    elapsed = round((time.perf_counter() - started) * 1000.0, 3)
    return _paper_metrics(result, elapsed), result if isinstance(result, dict) else {}


def _empty_world() -> dict:
    matrix = {}
    for world in WORLDS:
        matrix[world] = {level: {'total': 0, 'detected': 0} for level in LEVELS}
    return matrix


def _axis_counts(item: dict) -> tuple[int, int]:
    if _finite(item.get('total')):
        total = int(item['total'])
        detected = int(item['detected']) if _finite(item.get('detected')) else 0
        if total < 0 or detected < 0:
            return 0, 0
        return total, min(detected, total)
    if item.get('detected') is True:
        return 1, 1
    if item.get('detected') is False:
        return 1, 0
    return 0, 0


def _absorb_item(matrix: dict, item) -> None:
    if not isinstance(item, dict):
        return
    world = item.get('world')
    level = item.get('difficulty')
    if not isinstance(level, str):
        level = item.get('level')
    if world not in WORLDS or level not in LEVELS:
        return
    total, detected = _axis_counts(item)
    if total <= 0:
        return
    cell = matrix[world][level]
    cell['total'] += total
    cell['detected'] += detected


def _absorb_world_dict(matrix: dict, payload: dict) -> None:
    for world, levels in payload.items():
        if not isinstance(levels, dict):
            continue
        for level, cell in levels.items():
            if isinstance(cell, dict):
                merged = {'world': world, 'difficulty': level}
                merged.update(cell)
                _absorb_item(matrix, merged)


def _absorb_world(matrix: dict, duel: dict) -> None:
    payload = duel.get('worldDifficulty') if isinstance(duel, dict) else None
    if isinstance(payload, dict):
        _absorb_world_dict(matrix, payload)
        return
    if isinstance(payload, list):
        for item in payload:
            _absorb_item(matrix, item)


def _collect(sources, reds, blues, duel_fn, settings):
    rows = []
    matrix = _empty_world()
    for source_index, source in enumerate(sources):
        for red in reds:
            for blue in blues:
                metrics, raw = _invoke(duel_fn, source, red, blue, settings)
                rows.append({
                    'source': source_index,
                    'red': red['id'],
                    'blue': blue['id'],
                    'metrics': metrics,
                })
                _absorb_world(matrix, raw)
    return rows, matrix


def _public_world(matrix: dict) -> dict:
    public = {}
    for world in WORLDS:
        row = {}
        for level in LEVELS:
            cell = matrix[world][level]
            if cell['total'] <= 0:
                row[level] = None
            else:
                row[level] = round(cell['detected'] / cell['total'], 6)
        public[world] = row
    return public


def _mean(values: list[float]) -> float:
    if not values:
        return 0.0
    return round(sum(values) / len(values), 6)


def _total(cells: list[dict], key: str):
    total = sum(cell[key] for cell in cells)
    if isinstance(total, float) and total.is_integer():
        return int(total)
    return total


def _cells_for(rows, field: str, ident: str) -> list[dict]:
    return [row['metrics'] for row in rows if row[field] == ident]


def _pair_cells(rows, red_id: str, blue_id: str) -> list[dict]:
    chosen = []
    for row in rows:
        if row['red'] == red_id and row['blue'] == blue_id:
            chosen.append(row['metrics'])
    return chosen


def _better_score(left: float, right: float) -> float:
    if left > right:
        return 1.0
    if left < right:
        return 0.0
    return 0.5


def _pairs(member_ids: list[str], scores: dict) -> list[dict]:
    matchups = []
    for index, left in enumerate(member_ids):
        for right in member_ids[index + 1:]:
            matchups.append({
                'a': left,
                'b': right,
                'scoreA': _better_score(scores[left], scores[right]),
            })
    return matchups


def _grouped_scores(rows, key_fields: tuple[str, str], member: str, score_of) -> list[dict]:
    grouped: dict = {}
    for row in rows:
        key = (row[key_fields[0]], row[key_fields[1]])
        grouped.setdefault(key, {})[row[member]] = score_of(row)
    return list(grouped.values())


def _matchups_for(rows, ids: list[str], key_fields: tuple[str, str], member: str, score_of):
    matchups = []
    for scores in _grouped_scores(rows, key_fields, member, score_of):
        matchups.extend(_pairs(ids, scores))
    return matchups


def _blue_score(row) -> float:
    return row['metrics']['recall']


def _red_score(row) -> float:
    return 1.0 - row['metrics']['recall']


def _blue_row(ident: str, cells: list[dict], ratings: dict) -> dict:
    return {
        'id': ident,
        'meanRecall': _mean([cell['recall'] for cell in cells]),
        'totalHoldoutPureFp': _total(cells, 'holdoutPureFp'),
        'meanAurc': _mean([cell['aurc'] for cell in cells]),
        'meanElapsedMs': _mean([cell['elapsedMs'] for cell in cells]),
        'elo': ratings['elo'][ident],
        'bradleyTerry': ratings['bradleyTerry'][ident],
    }


def _red_row(ident: str, cells: list[dict], ratings: dict) -> dict:
    recall = _mean([cell['recall'] for cell in cells])
    return {
        'id': ident,
        'meanEvasionRate': round(1.0 - recall, 6),
        'meanStealthYield': _mean([cell['stealthYield'] for cell in cells]),
        'elo': ratings['elo'][ident],
        'bradleyTerry': ratings['bradleyTerry'][ident],
    }


def _matrix_cell(red_id: str, blue_id: str, cells: list[dict]) -> dict:
    return {
        'redId': red_id,
        'blueId': blue_id,
        'paperCount': len(cells),
        'recall': _mean([cell['recall'] for cell in cells]),
        'stealthYield': _mean([cell['stealthYield'] for cell in cells]),
        'holdoutPureFp': _total(cells, 'holdoutPureFp'),
    }


def _worse(left, right, higher: bool) -> bool:
    if higher:
        return left < right
    return left > right


def _better(left, right, higher: bool) -> bool:
    if higher:
        return left > right
    return left < right


def _dominates(left: dict, right: dict, specs) -> bool:
    strict = False
    for key, higher in specs:
        if _worse(left[key], right[key], higher):
            return False
        if _better(left[key], right[key], higher):
            strict = True
    return strict


def _mark_pareto(rows: list[dict], specs) -> list[dict]:
    for row in rows:
        dominated = False
        for other in rows:
            if other is not row and _dominates(other, row, specs):
                dominated = True
        row['paretoOptimal'] = not dominated
    return rows


def _sort_blue(rows: list[dict]) -> list[dict]:
    rows.sort(key=lambda row: (-row['meanRecall'], row['totalHoldoutPureFp'], -row['elo'], row['id']))
    return rows


def _sort_red(rows: list[dict]) -> list[dict]:
    rows.sort(key=lambda row: (-row['meanEvasionRate'], -row['meanStealthYield'], -row['elo'], row['id']))
    return rows


def _leaderboard_blue(ids, rows, ratings) -> list[dict]:
    board = [_blue_row(ident, _cells_for(rows, 'blue', ident), ratings) for ident in ids]
    return _sort_blue(_mark_pareto(board, _BLUE_SPECS))


def _leaderboard_red(ids, rows, ratings) -> list[dict]:
    board = [_red_row(ident, _cells_for(rows, 'red', ident), ratings) for ident in ids]
    return _sort_red(_mark_pareto(board, _RED_SPECS))


def _public_matrix(red_ids, blue_ids, rows) -> list[dict]:
    cells = []
    for red_id in red_ids:
        for blue_id in blue_ids:
            cells.append(_matrix_cell(red_id, blue_id, _pair_cells(rows, red_id, blue_id)))
    return cells


def _document(source_count: int, blues, reds, matrix, world) -> dict:
    return {
        'schema': SCHEMA,
        'ok': True,
        'answerKeyFree': True,
        'scrubbed': True,
        'summary': {'axes': {}},
        'rules': [],
        'sourceCount': source_count,
        'blueLeaderboard': blues,
        'redLeaderboard': reds,
        'matrix': matrix,
        'worldDifficultyMatrix': world,
    }


def _guard_document(document: dict) -> dict:
    try:
        arena_round._scrub(document, [], set())
    except arena_round.DistillScrubError as error:
        raise ValueError('tournament_scrub_failed') from error
    return document


def run_arena_tournament(
    *,
    source_pdfs: list[str | Path],
    red_entries: list[dict],
    blue_entries: list[dict],
    supplements: list[str | Path] | None = None,
    holdout_pdfs: list[str | Path] | None = None,
    min_difficulty: str = 'L2',
    agent_timeout: int = 180,
    validate_quotes: bool = True,
    duel_fn=None,
) -> dict:
    """Run an N by M tournament and return a scrubbed leaderboard document."""
    sources = _require_sources(source_pdfs)
    need_argv = duel_fn is None
    seen: set[str] = set()
    reds = _require_entries(red_entries, 'invalid_red_entries', need_argv, seen)
    blues = _require_entries(blue_entries, 'invalid_blue_entries', need_argv, seen)
    settings = {
        'supplements': _optional_paths(supplements, 'invalid_supplements'),
        'holdouts': _optional_paths(holdout_pdfs, 'invalid_holdouts'),
        'min_difficulty': min_difficulty,
        'timeout': _require_timeout(agent_timeout),
        'validate_quotes': _require_bool(validate_quotes, 'invalid_validate_quotes'),
    }
    rows, counts = _collect(sources, reds, blues, duel_fn, settings)
    blue_ids = [entry['id'] for entry in blues]
    red_ids = [entry['id'] for entry in reds]
    blue_ratings = compute_bradley_terry_and_elo(
        _matchups_for(rows, blue_ids, ('source', 'red'), 'blue', _blue_score),
        blue_ids,
    )
    red_ratings = compute_bradley_terry_and_elo(
        _matchups_for(rows, red_ids, ('source', 'blue'), 'red', _red_score),
        red_ids,
    )
    document = _document(
        len(sources),
        _leaderboard_blue(blue_ids, rows, blue_ratings),
        _leaderboard_red(red_ids, rows, red_ratings),
        _public_matrix(red_ids, blue_ids, rows),
        _public_world(counts),
    )
    return _guard_document(document)
