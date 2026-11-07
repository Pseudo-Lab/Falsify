import pytest
import torch

from src.model import AttentionFusion, LinearModel


@pytest.mark.parametrize("cls", [LinearModel, AttentionFusion])
def test_output_shape(cls):
    torch.manual_seed(0)
    model = cls(3, 5, 6)
    out = model(torch.randn(4, 3), torch.randn(4, 5), torch.ones(4, 2))
    assert out.shape == (4, 6)


@pytest.mark.parametrize("cls", [LinearModel, AttentionFusion])
def test_absent_modality_values_do_not_matter(cls):
    torch.manual_seed(0)
    model = cls(3, 5, 6).eval()
    mask = torch.tensor([[1.0, 0.0]])
    xp = torch.randn(1, 3)
    a = model(xp, torch.zeros(1, 5), mask)
    b = model(xp, torch.randn(1, 5) * 100, mask)
    assert torch.allclose(a, b)


def test_attention_requires_a_modality():
    model = AttentionFusion(3, 5, 6)
    with pytest.raises(ValueError):
        model(torch.randn(1, 3), torch.randn(1, 5), torch.zeros(1, 2))
