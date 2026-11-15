# Falsify Season 13 Submissions & Validators

`submissions/` defines the validation rules for both Red attack submissions (`.json`) and Blue prediction outputs (`.csv`).

## Red Attack Packages (`submissions/schema.json`)

- Required fields: `paper_id`, `team`, `defect_type`, `location`, `patch`, `target_quote`, `intended_label`
- `defect_type`: `D1`, `D2`, `D3`, or a custom defect type accompanied by a non-empty `detector_spec` / `custom_detector`
- Leakage guard: `target_quote` and `blind_input` must not contain answer-key fields (`Falsify-keys`, `intended_label`, `answer_key`, `ground_truth`, etc.)

## Blue Prediction CSVs

- Must match `tools/score.py` `REQUIRED_COLUMNS`:
  `paper_id, team, judge_type, model, iteration, location, defect_type, label, evidence, time_sec, tokens, is_holdout`
- Labels must be Season 13 labels (`맞음`, `아님`, `확인필요`) or supported `tools/score.py` aliases
- Rejects duplicate `case_id`s (when column is present) and duplicate `(paper_id, team, iteration, location, defect_type)` entries

## Validate

```bash
python -m submissions.validate_submission submissions/examples
```
