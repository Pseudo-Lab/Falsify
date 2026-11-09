"""Boundary example for the 180-day endpoint rule.

Reads ``horizon_input.csv`` and writes ``horizon_output.csv`` with the
endpoint status that ``src.labels.endpoint_status`` assigns to each case.

Usage: ``python -m examples.contracts.horizon_example``
"""

from pathlib import Path

import pandas as pd

from src.io_utils import read_csv, write_csv
from src.labels import endpoint_status

HERE = Path(__file__).parent


def build() -> pd.DataFrame:
    cases = read_csv(HERE / "horizon_input.csv", int_cols=["event_day"])
    rows = []
    for rec in cases.itertuples(index=False):
        y, observed = endpoint_status(rec.event_day, rec.followup_end_day)
        rows.append({"case": rec.case, "event_day": rec.event_day, "followup_end_day": rec.followup_end_day,
                     "y": y, "observed": observed})
    out = pd.DataFrame(rows)
    out["event_day"] = out["event_day"].astype("Int64")
    out["y"] = out["y"].astype("Int64")
    return out


if __name__ == "__main__":
    out = build()
    write_csv(out, HERE / "horizon_output.csv")
    print(out.to_string(index=False))
