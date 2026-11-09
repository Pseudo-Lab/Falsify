"""Linear baseline and a small two-head attention fusion model.

Both models take the protein block, the RNA block and a binary modality mask
``m`` of shape (batch, 2) and return six task logits. An absent modality is a
zero token and is also excluded from attention keys. Rows with both
modalities absent must not reach the model (they abstain upstream).
"""

import torch
from torch import nn


class LinearModel(nn.Module):
    """Multi-task logistic regression on [protein, rna, m]."""

    def __init__(self, n_protein: int, n_rna: int, n_tasks: int):
        super().__init__()
        self.linear = nn.Linear(n_protein + n_rna + 2, n_tasks)

    def forward(self, x_protein, x_rna, mask, return_attention: bool = False):
        x = torch.cat([x_protein * mask[:, :1], x_rna * mask[:, 1:], mask], dim=1)
        logits = self.linear(x)
        return (logits, None) if return_attention else logits


class AttentionFusion(nn.Module):
    """Two modality tokens, multi-head self-attention with a residual, masked mean pooling."""

    def __init__(self, n_protein: int, n_rna: int, n_tasks: int, width: int = 16, heads: int = 2):
        super().__init__()
        self.proj_protein = nn.Linear(n_protein, width)
        self.proj_rna = nn.Linear(n_rna, width)
        self.attn = nn.MultiheadAttention(width, heads, batch_first=True)
        self.head = nn.Linear(width + 2, n_tasks)

    def forward(self, x_protein, x_rna, mask, return_attention: bool = False):
        if (mask.sum(dim=1) == 0).any():
            raise ValueError("rows with no available modality must abstain before the model")
        tokens = torch.stack([self.proj_protein(x_protein), self.proj_rna(x_rna)], dim=1)
        tokens = tokens * mask.unsqueeze(-1)  # zero token for an absent modality
        out, weights = self.attn(tokens, tokens, tokens, key_padding_mask=mask == 0,
                                 need_weights=True, average_attn_weights=False)
        hidden = tokens + out
        pooled = (hidden * mask.unsqueeze(-1)).sum(dim=1) / mask.sum(dim=1, keepdim=True)
        logits = self.head(torch.cat([pooled, mask], dim=1))
        return (logits, weights) if return_attention else logits


def build_model(kind: str, n_protein: int, n_rna: int, n_tasks: int, width: int, heads: int) -> nn.Module:
    if kind == "linear":
        return LinearModel(n_protein, n_rna, n_tasks)
    if kind == "attention":
        return AttentionFusion(n_protein, n_rna, n_tasks, width=width, heads=heads)
    raise ValueError(f"unknown model kind {kind!r}")
