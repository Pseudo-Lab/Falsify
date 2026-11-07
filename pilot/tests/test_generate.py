from src.generate import generate_cohort


def test_generation_is_deterministic_and_sized():
    a = generate_cohort(1729)
    b = generate_cohort(1729)
    for name in a:
        assert a[name].equals(b[name]), name
    assert len(a["subjects"]) == 1200
    assert len(a["specimens"]) == 2400
    assert a["specimens"].groupby("subject_id").size().eq(2).all()


def test_different_seed_changes_values():
    a = generate_cohort(1729)
    b = generate_cohort(1730)
    assert not a["subjects"]["followup_end_day"].equals(b["subjects"]["followup_end_day"])
