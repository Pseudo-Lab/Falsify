"""180-day endpoint construction for the synthetic outcomes SYN_T01-SYN_T06.

Rules, for one (subject, task) pair:

* an observed event with ``0 < event_day <= horizon`` -> ``y = 1``, observed;
* no such event and ``followup_end_day >= horizon`` -> ``y = 0``, observed;
* no such event and follow-up ended before the horizon -> ``y = null``,
  not observed (right-censored; never treated as a confirmed negative).

``event_day`` is recorded only for events seen during follow-up, so an event
day beyond ``followup_end_day`` is rejected as inconsistent input.
"""

import pandas as pd

from src.schema import HORIZON_DAYS


def within_horizon(event_day, horizon: int = HORIZON_DAYS) -> bool:
    """True when an observed event day falls inside ``(0, horizon]``."""
    if event_day is None or pd.isna(event_day):
        return False
    return 0 < event_day <= horizon


def endpoint_status(event_day, followup_end_day, horizon: int = HORIZON_DAYS):
    """Return ``(y, observed)`` for one (subject, task) pair."""
    if event_day is not None and not pd.isna(event_day) and event_day > followup_end_day:
        raise ValueError("event_day after followup_end_day: event could not have been observed")
    if within_horizon(event_day, horizon):
        return 1, True
    if followup_end_day >= horizon:
        return 0, True
    return None, False


def build_labels(events: pd.DataFrame, horizon: int = HORIZON_DAYS) -> pd.DataFrame:
    """Derive ``y`` and ``observed`` from recorded event and follow-up days.

    ``events`` has columns subject_id, task_id, event_day (nullable),
    followup_end_day. The output keeps those columns and adds y and observed.
    """
    rows = []
    for rec in events.itertuples(index=False):
        y, observed = endpoint_status(rec.event_day, rec.followup_end_day, horizon)
        rows.append((rec.subject_id, rec.task_id, rec.event_day, rec.followup_end_day, y, observed))
    out = pd.DataFrame(rows, columns=["subject_id", "task_id", "event_day", "followup_end_day", "y", "observed"])
    out["event_day"] = out["event_day"].astype("Int64")
    out["followup_end_day"] = out["followup_end_day"].astype(int)
    out["y"] = out["y"].astype("Int64")
    out["observed"] = out["observed"].astype(bool)
    return out


def observation_mask(labels: pd.DataFrame) -> pd.DataFrame:
    """Label-observation table, kept separate from modality availability."""
    return labels[["subject_id", "task_id", "observed"]].copy()
