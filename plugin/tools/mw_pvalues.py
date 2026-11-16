"""Exact achievable two-sided p-values for the Mann-Whitney U test (no ties).

Usage: python tools/mw_pvalues.py <n1> <n2>

Builds the exact null distribution of U by dynamic programming and prints the
minimum achievable two-sided p-value and the sorted list of achievable ones.
Two-sided p = min(1, 2 * min(P(U <= u), P(U >= u))), as in exact tests.
"""
import sys
from fractions import Fraction

MAX_LISTED = 50
MAX_CELLS = 250_000  # n1 * n2 bound keeps the DP fast


def u_counts(n1, n2):
    """counts[u] = number of rank arrangements giving U = u."""
    # f[j][u] for the current i: arrangements of i x's and j y's with U = u,
    # where U counts (x, y) pairs with y < x. Recurrence on the largest element.
    prev = [[1] for _ in range(n2 + 1)]  # i = 0: U is always 0
    for i in range(1, n1 + 1):
        cur = [[1]]  # j = 0: U is always 0
        for j in range(1, n2 + 1):
            size = i * j + 1
            row = [0] * size
            # largest is an x: it beats all j y's
            for u, c in enumerate(prev[j]):
                row[u + j] += c
            # largest is a y: it adds nothing
            for u, c in enumerate(cur[j - 1]):
                row[u] += c
            cur.append(row)
        prev = cur
    return prev[n2]


def achievable_pvalues(n1, n2):
    counts = u_counts(n1, n2)
    total = sum(counts)
    cdf, acc = [], 0
    for c in counts:
        acc += c
        cdf.append(acc)
    pvals = set()
    for u in range(len(counts)):
        lower = Fraction(cdf[u], total)
        upper = Fraction(total - (cdf[u - 1] if u else 0), total)
        pvals.add(min(Fraction(1), 2 * min(lower, upper)))
    return sorted(pvals)


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    try:
        n1, n2 = int(sys.argv[1]), int(sys.argv[2])
    except ValueError:
        sys.exit("ERROR: n1 and n2 must be integers")
    if n1 < 1 or n2 < 1:
        sys.exit("ERROR: n1 and n2 must be >= 1")
    if n1 * n2 > MAX_CELLS:
        sys.exit(f"ERROR: n1*n2 = {n1 * n2} exceeds {MAX_CELLS}; use the normal approximation")

    pvals = achievable_pvalues(n1, n2)
    print(f"n1={n1}, n2={n2}, exact two-sided Mann-Whitney (no ties)")
    print(f"minimum achievable two-sided p = {float(pvals[0]):.6g} ({pvals[0]})")
    shown = pvals[:MAX_LISTED]
    print(f"achievable two-sided p-values ({len(pvals)} total"
          + (f", first {MAX_LISTED} shown" if len(pvals) > MAX_LISTED else "") + "):")
    print(", ".join(f"{float(p):.6g}" for p in shown))


if __name__ == "__main__":
    main()
