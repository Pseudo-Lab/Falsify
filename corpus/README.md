# Falsify Season 13 Corpus & Fact Cards

`corpus/` defines the canonical **Fact Card** schema and validator used by the Season 13 verification gates (`gates/`) and evaluation pipeline (`eval/`).

## License Policy

Only PMC Open Access papers allowing adaptation and redistribution are permitted:
- `CC BY`
- `CC BY 4.0`
- `CC0`

Restricted licenses such as `CC BY-NC`, `CC BY-ND`, `CC BY-NC-ND`, `CC BY-SA`, or `arXiv nonexclusive-distrib` are rejected by `corpus/validate_corpus.py`.

## Schema Overview (`corpus/schema.json`)

Each Fact Card JSON contains:
- **Metadata**: `paper_id`, `pmcid`, `doi`, `license`, `title`, `year`
- **`tables`**: Structured numeric anchors (`metric`, `group`, `mean`, `sd`, `percentage`, `ci`, `p_value`, `n`, `unit`) for **D1**
- **`citations`**: Structured reference metadata (`ref_id`, `raw`, `doi`, `first_author`, `year`, `title`) for **D2**
- **`claim_anchors`**: Outcome anchors (`primary_endpoint`, `design`, `subgroup_condition`, `effect_direction`, `p_value`, `ci`, `null_value`) for **D3**

## Validate

```bash
python -m corpus.validate_corpus corpus/examples
```
