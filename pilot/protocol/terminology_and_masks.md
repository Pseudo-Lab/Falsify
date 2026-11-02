# Terminology and masks

Educational fiction: the terms below name parts of a synthetic study. They do not describe
measurements made on people.

## Terms

| Term | Meaning in this repository |
| --- | --- |
| subject | one synthetic participant, `SYN-P0001`-`SYN-P1200`; the independent unit for splitting and resampling |
| specimen / aliquot | one of two portions from the same index visit of a subject, `SYN-P0001-A1`, `SYN-P0001-A2`; aliquots of a subject are not independent |
| canonical specimen id | the specimen identifier every modality maps to through `data/modality_crosswalk.csv` |
| local id | a modality file's own row identifier (`PL-…`, `RL-…`); it differs between files by design |
| proteoform | a distinct molecular form of the protein products of one gene (Smith & Kelleher, *Nature Methods* 10:186-187, 2013, doi:10.1038/nmeth.2369). Here it only names the simulated feature family `PROT_01`-`PROT_24`; it is not evidence of an assay or of diagnostic value |
| abstain | no score is produced because neither modality is available |

## Two masks that are never merged

* **Observation mask** (`data/observation_mask.csv`): whether a subject's 180-day label is
  known. Follow-up that ends before day 180 without an event leaves `y` null and
  `observed=false`. Such labels are left out of the loss and of evaluation; they are not
  negatives.
* **Modality mask** (`data/modality_mask.csv`): whether a specimen has protein and/or RNA
  measurements. It describes inputs, not outcomes.

A label can be observed for a subject whose specimens lack a modality, and a fully measured
specimen can belong to a subject with an unobserved label. Keeping the two tables apart keeps
those cases distinct.

## Missing inputs

* One modality absent: its block is set to zero (a zero token) and the modality mask tells the
  model it is absent. A specimen with one absent modality carries no moer information about that
  modality than its mask bit; the zero token only keeps tensor shapes fixed.
* Both modalities absent: the specimen abstains. A subject abstains when all of its aliquots
  abstain, and abstaining subjects stay in `flow.csv` with their reason.
* Sporadic missing cells inside an available modality are filled with the median fitted on the
  training specimens.

## What is and is not leakage

* Reading every CSV into memory before splitting is normal; what matters is which rows the
  preprocessing statistics are fitted on (`fit_membership.csv`).
* Applying already-fitted statistics to validation and test rows, and scoring those rows, is
  normal evaluation.
* Fitting statistics, choosing a checkpoint, a threshold or a seed with test rows is not.
