"""Training loop, checkpoint selection and F1 threshold selection.

* The loss is binary cross-entropy over observed labels only, divided by the
  number of observed (row, task) entries.
* The checkpoint is the epoch with the lowest validation loss.
* The F1 threshold per task is chosen on subject-level scores of the split
  named by ``threshold_split``, using observed labels only.
"""

import copy
import hashlib

import numpy as np
import pandas as pd
import torch
from torch import nn


def set_determinism(seed: int) -> None:
    torch.manual_seed(seed)
    np.random.seed(seed)
    torch.use_deterministic_algorithms(True)
    torch.set_num_threads(1)


def masked_bce(logits, y, observed):
    """Mean BCE over entries with observed labels."""
    loss = nn.functional.binary_cross_entropy_with_logits(logits, y, reduction="none")
    denom = observed.sum()
    if denom == 0:
        raise ValueError("no observed labels in batch")
    return (loss * observed).sum() / denom


def params_sha256(model: nn.Module) -> str:
    h = hashlib.sha256()
    for name, tensor in sorted(model.state_dict().items()):
        h.update(name.encode())
        h.update(tensor.detach().cpu().contiguous().numpy().tobytes())
    return h.hexdigest()


def _forward(model, batch, return_attention=False):
    return model(batch["x_protein"], batch["x_rna"], batch["mask"], return_attention=return_attention)


def evaluate_loss(model, data) -> float:
    model.eval()
    with torch.no_grad():
        logits = _forward(model, data)
        return float(masked_bce(logits, data["y"], data["observed"]))


def train_model(model, train_data, val_data, max_epochs: int, learning_rate: float, batch_size: int, seed: int,
                on_epoch=None):
    """Train for ``max_epochs`` and keep every epoch's weights.

    Returns (ledger, states): ledger rows hold epoch, train_loss, val_loss and
    the parameter hash; states maps epoch -> state_dict. ``on_epoch`` is called
    with each ledger row as soon as the epoch ends.
    """
    optimizer = torch.optim.Adam(model.parameters(), lr=learning_rate)
    generator = torch.Generator().manual_seed(seed)
    n = train_data["y"].shape[0]
    ledger, states = [], {}
    for epoch in range(1, max_epochs + 1):
        model.train()
        order = torch.randperm(n, generator=generator)
        total, weight = 0.0, 0.0
        for start in range(0, n, batch_size):
            idx = order[start:start + batch_size]
            batch = {k: v[idx] for k, v in train_data.items()}
            optimizer.zero_grad()
            loss = masked_bce(_forward(model, batch), batch["y"], batch["observed"])
            loss.backward()
            optimizer.step()
            w = float(batch["observed"].sum())
            total += float(loss) * w
            weight += w
        val_loss = evaluate_loss(model, val_data)
        ledger.append({"epoch": epoch, "train_loss": total / weight, "val_loss": val_loss,
                       "params_sha256": params_sha256(model)})
        states[epoch] = copy.deepcopy(model.state_dict())
        if on_epoch is not None:
            on_epoch(ledger[-1])
    return ledger, states


def select_candidate(ledger: pd.DataFrame, key: str = "val_loss") -> pd.Series:
    """Pick the candidate (epoch, and seed if present) with the lowest validation loss.

    Columns describing the test split are dropped before selection so that
    they cannot influence the choice; the full ledger is kept by the caller.
    """
    usable = ledger[[c for c in ledger.columns if not c.startswith("test_")]]
    if key not in usable.columns:
        raise ValueError(f"selection key {key!r} is not a validation quantity")
    order = usable.sort_values([key] + [c for c in ("seed", "epoch") if c in usable.columns], kind="mergesort")
    return ledger.loc[order.index[0]]


def threshold_grid(start: float, stop: float, step: float) -> np.ndarray:
    n = int(round((stop - start) / step)) + 1
    return np.round(start + step * np.arange(n), 10)


def f1_at(y: np.ndarray, score: np.ndarray, threshold: float) -> float:
    pred = score >= threshold
    tp = int(np.sum(pred & (y == 1)))
    fp = int(np.sum(pred & (y == 0)))
    fn = int(np.sum(~pred & (y == 1)))
    return 0.0 if tp == 0 else 2 * tp / (2 * tp + fp + fn)


def choose_threshold(subject_scores: pd.DataFrame, labels: pd.DataFrame, grid: np.ndarray) -> dict:
    """Per task, the grid value with the highest F1 (ties -> smallest threshold).

    ``subject_scores`` has subject_id, task_id, score, score_status for the
    selection split; only scored subjects with observed labels are used.
    """
    merged = subject_scores.merge(labels[["subject_id", "task_id", "y", "observed"]],
                                  on=["subject_id", "task_id"], how="left", validate="one_to_one")
    usable = merged[(merged["score_status"] == "scored") & merged["observed"]]
    out = {}
    for task, grp in usable.groupby("task_id", sort=True):
        y = grp["y"].astype(int).to_numpy()
        s = grp["score"].to_numpy(dtype=float)
        f1s = np.array([f1_at(y, s, t) for t in grid])
        best = int(np.argmax(f1s))
        out[task] = {
            "threshold": float(grid[best]),
            "f1_at_threshold": float(f1s[best]),
            "n_subjects": int(len(grp)),
            "n_positive": int(y.sum()),
            "subject_ids": sorted(grp["subject_id"].tolist()),
        }
    return out
