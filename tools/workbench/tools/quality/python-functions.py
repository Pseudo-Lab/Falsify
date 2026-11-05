"""Emit per-function cyclomatic counts and source for the quality ratchet."""
import ast
import json
import sys

source = sys.stdin.buffer.read().decode('utf-8')
tree = ast.parse(source)
result = []

def visit_scope(node, prefix):
    names = {}
    def walk(node):
      for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            name = getattr(child, 'name', '<lambda>')
            names[name] = names.get(name, 0) + 1
            ident = f'{prefix}/{name}#{names[name]}'
            count = 1
            def decisions(n):
                nonlocal count
                for part in ast.iter_child_nodes(n):
                    if isinstance(part, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
                        continue
                    if isinstance(part, (ast.If, ast.For, ast.AsyncFor, ast.While, ast.IfExp, ast.ExceptHandler, ast.comprehension)):
                        count += 1
                    elif isinstance(part, ast.BoolOp):
                        count += len(part.values) - 1
                    elif isinstance(part, ast.match_case) and not (isinstance(part.pattern, ast.MatchAs) and part.pattern.pattern is None):
                        count += 1
                    decisions(part)
            decisions(child)
            result.append({'id': ident, 'ccn': count, 'source': ast.get_source_segment(source, child)})
            visit_scope(child, ident)
        elif isinstance(child, ast.ClassDef):
            visit_scope(child, f'{prefix}/{child.name}')
        else:
            walk(child)
    walk(node)

visit_scope(tree, '')
sys.stdout.buffer.write((json.dumps(result, ensure_ascii=False) + '\n').encode('utf-8'))
