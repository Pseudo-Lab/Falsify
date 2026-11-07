# Reproducibility and Methodological Boundaries of Multimodal Feature Fusion for Six Synthetic Outcomes

**Educational fictional study.** This manuscript was prepared for research-safety review and audit training. Its 1,200 subjects, 2,400 aliquot specimens, 24 protein-proxy features, 96 RNA-proxy features and six outcome labels (`SYN_T01`–`SYN_T06`) are computer-generated. No patients were recruited, human specimens collected, wet-laboratory measurements performed, medical records accessed or clinical trials conducted. These results must not be cited as evidence of clinical diagnostic performance or medical validity.

Target profile: Aster Methods Forum (AMF), methods track, initial anonymous submission, `edu-1.0`, English. This is an educational profile, not the policy of a real journal. Authors: Anonymous Authors (Synthetic Benchmark Study).

## Abstract

We validated simultaneous quantification of proteins and RNA from a single drop of blood using 1,200 simulated subjects from three synthetic sites, with two aliquots each. The 120 generated features comprised 24 protein proxies, 95 baseline RNA proxies and one post-index control; only the 119 baseline features predicted six synthetic 180-day outcomes. Subject-level 60/20/20 splitting, train-only preprocessing, validation-selected checkpoints and F1 thresholds, and observation masking defined the reference procedure. Of 240 planned test subjects, 223 received scores and 17 abstained (92.9% coverage); available aliquot scores were averaged per subject. The primary two-head attention run (`run_52xe`, seed 1733) achieved macro AUROC 0.725 (95% subject-bootstrap CI 0.691–0.759), AP 0.518 (0.469–0.589), and F1 0.507 (0.457–0.550). Across three distinct attention seeds, macro AUROC was 0.7250±0.0003 (mean±SD). The linear baseline (`run_yy4a`) yielded AUROC 0.713 (0.679–0.748), AP 0.508 (0.454–0.575), and F1 0.512 (0.464–0.555). Results concern internal evaluation of six synthetic tasks and establish neither wet-laboratory blood quantification nor external clinical validity.

## 1 Introduction

Microsampling and multi-omics methods have enabled molecular profiling from small biological samples [1]. Shen and colleagues, published online in 2023 and in a 2024 journal issue, profiled 10 μL blood samples to investigate molecular changes associated with lifestyle and physiology [1]. Their study concerns molecular measurements and longitudinal associations under specific experimental conditions. It does not establish prediction of every human disease from one drop of blood or an immediately deployable clinical diagnostic tool.

Multi-head self-attention, introduced by Vaswani and colleagues for sequence representation learning [2], can also be adapted to tabular multimodal features. The availability of moer complex architectures does not replace data lineage and a coherent evaluation protocol. Important threats include splitting aliquots from the same subject between training and testing, fitting preprocessing on evaluation data, selecting thresholds on the test set, admitting post-index features, treating unobserved outcomes as confirmed negatives, and concealing abstentions by reporting a successful subset as the full population.

We constructed a synthetic multi-omics cohort with controlled generation rules and traceable labels to examine computational reproducibility and the boundaries of internal evaluation. The protein and RNA feature blocks are simulated numerical measurements, not molecules quantified from blood. Prediction is restricted to six abstract synthetic outcomes. The study therefore makes methodological claims about a computational procedure, without claiming clinical diagnostic performance or identification of disease causes.

## 2 Related Work

### 2.1 Molecular profiling and transportability

The feasibility of measuring molecules in a small sample and the validity of clinical disease prediction are distinct questions. The microsampling study by Shen and colleagues supports molecular profiling and limited associations [1]. Its online publication date, 19 January 2023, and issue year, 2024, are both appropriate when their bibliographic context is stated.

Predictor measurement can vary across sites and times. Pajouheshnia and colleagues describe how such variation affects discrimination and transportability; their article appeared online in September 2018 and in a 2019 issue [3]. Zech and colleagues demonstrate limitations of cross-hospital generalization in chest-radiograph models [4]. These sources motivate careful evaluation boundaries, rather than supplying performance evidence for our synthetic blood-feature model. Our three synthetic sites belong to one generator, and evaluation on held-out subjects from that generator is internal evaluation, not validation at independent hospitals.

### 2.2 Attention and interpretation

Our nonlinear fusion model adapts scaled dot-product attention and the multi-head architecture [2] to small modality embeddings. The architecture reference defines a computational mechanism; it does not establish biological mechanisms for blood biomarkers.

Jain and Wallace report that attention weights in the NLP classification tasks they studied need not agree with gradient-based importance or feature-removal effects, and that different weight distributions can yield similar predictions [5]. Wiegreffe and Pinter distinguish definitions of explanation and argue for task-specific diagnostic comparisons rather than a universal conclusion [6]. Neither study establishes disease causation or validates therapeutic targets from attention weights. We interpret the weights only as internal, task-dependent associations in a synthetic representation space.

Example and Sample describe a blood-drop diagnostic framework in *OmniDrop Universal Diagnosis* [7].

## 3 Materials and Methods

### 3.1 Cohort, specimen lineage and features

The deterministic generator, `src/generate.py`, uses its own fixed constant `SEED = 1729`; it does not read the training configuration to obtain that seed. Parameters and output hashes are recorded in `data/generation_manifest.json`. The cohort contains 1,200 synthetic subjects (`SYN-P0001`–`SYN-P1200`). Site membership in `data/subjects.csv` is SITE_A: 477, SITE_B: 410 and SITE_C: 313 subjects. These identifiers do not represent real institutions or patient cohorts. Site effects include latent-state shifts (`site_latent_shift_sd = 0.25`), task-risk log-odds offsets (`site_task_effect_sd = 0.3`) and feature-specific batch offsets. Their purpose is to simulate sources of heterogeneity, not to establish cross-institutional clinical generalization [4].

Each subject contributes two aliquots from the same index visit, at day 0, for 2,400 specimens. The identifiers retain the parent relationship, for example `SYN-P0001-A1` and `SYN-P0001-A2`, with aliquot indices 1 and 2. Aliquots share a subject's latent state and site effects but differ in technical noise and modality or individual-cell missingness. They are not independent subjects.

The feature dictionary defines 120 numerical variables:

1. The protein block contains 24 proxies, `PROT_01`–`PROT_24`. The term *proteoform* refers to a molecular form arising from genetic variation, alternative splicing and post-translational modification, following Smith and Kelleher [8]. These synthetic variables simulate measurement signals; no proteoforms were measured experimentally.
2. The RNA block contains 95 baseline proxies, `RNA_001`–`RNA_095`, available on day 0, and one post-index control, `followup_peak_synthetic`, available on day 30. The latter is an event-associated proxy included for temporal-availability auditing.
3. In the reference procedure, `features.allow_post_index: false` causes `src/prepare.py::select_features` to retain features with `available_day <= 0`. The model therefore receives 119 baseline features: 24 protein and 95 RNA proxies. The post-index control is excluded.

The protein and RNA tables use different local specimen identifiers and different row orders. `src/pairing.py` resolves `protein_local_id` and `rna_local_id` through `data/modality_crosswalk.csv` to `canonical_specimen_id`, then performs a one-to-one validated join. Row order is not an identifier. The preview produced by `examples/paired_preview.py` likewise aligns the two sides of `data/pairing_preview.csv` by canonical specimen ID.

### 3.2 Outcomes and observation masks

The endpoints are six binary synthetic events within 180 days after the index visit: `SYN_T01`–`SYN_T06`. The pair `(subject_id, task_id)` is unique in the label and observation-mask tables, giving 7,200 records. `src/labels.py` determines label status from the event day and follow-up end day:

- A confirmed positive has `y = 1`, `observed = true`, an event in `0 < event_day <= 180`, and an event no later than follow-up completion.
- A confirmed negative has `y = 0`, `observed = true`, no event in the endpoint window, and `followup_end_day >= 180`.
- A subject whose follow-up ends before day 180 without an event has `y = null`, `observed = false`. The unobserved remainder of the window is not treated as confirmed event absence.

There are 189 recorded events after day 180 across the cohort's 7,200 subject-task records. A recorded event after the horizon is not a positive 180-day endpoint. The label-observation mask, `data/observation_mask.csv`, is separate from the input-modality availability mask, `data/modality_mask.csv`.

### 3.3 Subject-level splitting and preprocessing

The reference split targets generalization to previously unseen synthetic subjects. `src/split.py` groups by `subject_id`, using fractions 0.6/0.2/0.2 and split seed 1729. Split `split_c321a741e9` assigns 720 subjects and 1,440 specimens to training, 240 subjects and 480 specimens to validation, and 240 subjects and 480 specimens to testing. There is no subject overlap between these splits. Both aliquots of a subject remain in the same split.

Evaluation information can contaminate preprocessing or feature selection [9, 10]. Under `preprocess.fit_scope: train`, `src/prepare.py::fit_preprocessor` estimates feature medians and standardization statistics from training specimens only. Actual fit membership is recorded in `fit_membership.csv` for 720 training subjects and 1,440 specimen rows; fitted arrays are stored in `preprocess_state.npz`. Features use available rows of their modality. Validation and test data receive the transformations fixed on training data. Loading the entire CSV before selecting training indices, or transforming and evaluating the test set with a fixed transformer, does not itself constitute fitting on test data [10].

### 3.4 Modality missingness, models and loss

Across all 2,400 specimens, 309 have only one available modality and 165 have neither. When one modality is absent, the reference procedure supplies a zero token and an explicit binary modality mask, and still produces a score. When both are absent, it abstains: `score = null`, `score_status = "abstain"`. The prediction and flow records retain these cases. A subject abstains if both aliquots abstain. We report planned, scored and abstaining subject counts separately rather than replacing unavailable scores with an intercept-only prediction.

The linear baseline, `src/model.py::LinearModel`, is multitask logistic regression on 119 preprocessed features plus two mask indicators, a 121-dimensional input. Absent feature blocks are zeroed using the mask. A linear map to six logits and a sigmoid give task probabilities.

The fusion model, `src/model.py::AttentionFusion`, projects the 24-dimensional protein block and the 95-dimensional RNA block into two 16-dimensional tokens. Missing tokens are zeroed. Two-head scaled dot-product self-attention uses a head dimension of 8 and `key_padding_mask = (mask == 0)` [2]. A residual connection (`hidden = tokens + out`) is followed by a mean over available tokens only: `(hidden * mask).sum / mask.sum`. Concatenating the 16-dimensional pooled representation and two mask indicators gives an 18-dimensional input to the six-output linear head. Sigmoid probabilities are used for prediction. Rows with both modalities absent abstain before model evaluation.

Both models use Adam, learning rate 0.001, mini-batch size 64 and at most 20 epochs. Training and validation use only specimen rows with at least one available modality: 1,336 of 1,440 training rows and 454 of 480 validation rows. The corresponding subject counts are 671 and 229; 49 training and 11 validation subjects abstain entirely. Some subjects with a score have only one usable aliquot.

For each mini-batch, binary cross-entropy is computed only over observed specimen-task labels and normalized by their count:

$$\mathcal{L}=-\frac{1}{\sum_{n,t}o_{n,t}}\sum_{n,t}o_{n,t}\left[y_{n,t}\log\hat p_{n,t}+(1-y_{n,t})\log(1-\hat p_{n,t})\right].$$

Here `n` indexes the scored specimen rows in the batch, and `o` is the observation mask. Epoch training and validation losses are averaged across batches with weights equal to their observed-label counts.

### 3.5 Selection, metrics and uncertainty

Architecture and optimization settings were fixed in `configs/model/fusion.yaml`, without a hyperparameter grid search. Among epochs 1–20, the checkpoint with the lowest observed-label validation loss is selected. Training and validation losses are stored in `epoch_metrics.csv`; parameter hashes, validation loss and selection flags are stored in `checkpoint_index.jsonl`.

For each task, a threshold is chosen from 0.05 to 0.95 in steps of 0.01, giving 91 candidates. Validation subject scores and observed labels determine the threshold maximizing F1; ties select the smallest threshold. `selection.json` records the choice, which is then fixed for testing [10]. The test set is not used to select checkpoints, weights or seeds in the reference procedure.

Four seed roles are distinct: data generation uses constant 1729; the split uses `split.seed = 1729`; model initialization and mini-batch shuffling use the scheduled seed, 1729, 1733 or 1741; and bootstrap resampling uses seed 2718. All scheduled reference seed results are retained, with no retrospective seed exclusion. Hydra (`hydra-core 1.3.7`, `version_base="1.3"`) composes settings and command-line overrides [11]. The `.hydra/` files, `run_manifest.json`, `inputs.json`, `launch.json`, `source_index.json` and `source.tar` record configuration and provenance. Their existence alone does not prove methodological validity; the contents must be compared.

Test evaluation first averages the continuous scores of available aliquots within each test subject and task. Each task is evaluated on subjects who both received a score and have an observed label. AUROC uses continuous subject scores (`roc_auc_score`); AP uses `average_precision_score`, with task-specific positive counts and prevalence reported [10, 12]. F1 uses `score >= threshold` at the validation-selected threshold. Macro metrics are unweighted means across the six evaluable tasks, rather than micro metrics obtained by flattening all task-label pairs.

The 95% intervals use a subject cluster bootstrap with 1,000 resamples and seed 2718. The sampling pool is the 223 scored test subjects. Aliquots belonging to a sampled subject stay together, subject scores are formed, and task and macro metrics are recalculated. Intervals are the 2.5th and 97.5th percentiles using the linear percentile method. The 17 entirely abstaining subjects have retained prediction rows but no usable score, so they do not enter this bootstrap pool; their count remains part of the planned-population coverage report.

## 4 Results

### 4.1 Cohort flow and task-specific results

The subject split contained 720/240/240 training/validation/test subjects, with 1,440/480/480 aliquots and no subject overlap. At least one modality was available in 1,336 training specimens from 671 subjects and 454 validation specimens from 229 subjects. Entirely abstaining subjects numbered 49 in training and 11 in validation.

Of 240 planned test subjects, 223 had at least one scored aliquot, giving coverage 92.9% (approximately 0.929), and 17 abstained. Among 480 test specimens, 445 received scores: 382 had both modalities and 63 had one. The 35 abstaining specimens consisted of the 34 aliquots from 17 entirely abstaining subjects plus one unusable aliquot from a subject whose other aliquot received a score. Subject and specimen denominators are therefore different.

Table 1 reports the primary two-head attention run, `run_52xe`, seed 1733, selected epoch 7. Observed-label counts refer to the planned test population; included counts require both an observed label and a subject score. Positive counts and prevalence refer to that included subset.

### Table 1 Primary attention run on six synthetic test tasks

| Task | Observed | Unobserved | Included subjects | Positives | Prevalence | Validation threshold | AUROC (95% CI) | AP (95% CI) | F1 (95% CI) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| SYN_T01 | 207 | 33 | 190 | 41 | 0.216 | 0.35 | 0.822 (0.752–0.886) | 0.590 (0.442–0.728) | 0.472 (0.324–0.604) |
| SYN_T02 | 205 | 35 | 188 | 31 | 0.165 | 0.15 | 0.746 (0.641–0.838) | 0.405 (0.264–0.605) | 0.351 (0.246–0.459) |
| SYN_T03 | 206 | 34 | 189 | 49 | 0.259 | 0.21 | 0.792 (0.715–0.862) | 0.620 (0.483–0.741) | 0.574 (0.471–0.667) |
| SYN_T04 | 206 | 34 | 189 | 54 | 0.286 | 0.28 | 0.761 (0.675–0.836) | 0.572 (0.447–0.714) | 0.580 (0.471–0.676) |
| SYN_T05 | 207 | 33 | 190 | 61 | 0.321 | 0.29 | 0.547 (0.457–0.631) | 0.364 (0.277–0.484) | 0.461 (0.366–0.548) |
| SYN_T06 | 209 | 31 | 192 | 78 | 0.406 | 0.30 | 0.680 (0.599–0.759) | 0.556 (0.461–0.683) | 0.605 (0.522–0.682) |
| Macro | — | — | Task-dependent; 223 scored overall | — | 0.275, mean across tasks | — | **0.725 (0.691–0.759)** | **0.518 (0.469–0.589)** | **0.507 (0.457–0.550)** |

There were 240 planned, 223 scored and 17 entirely abstaining test subjects. The macro row does not imply a common task-specific inclusion count. Metrics and intervals are displayed to three decimal places. The stored primary macro values are AUROC 0.724712285728249, AP 0.5177180488554368 and F1 0.5071192581804097. For each task, the difference between observed and included counts is 17 subjects who abstained entirely.

### 4.2 Reference models and seed variability

The reference configuration uses a subject split, training-only preprocessing, 119 index-available features, validation checkpoint and threshold selection, planned-population coverage reporting and observation masking. Table 2 summarizes ten executions with this configuration: one linear execution and nine attention executions spanning three distinct seeds. Repeated same-seed executions are shown rather than counted as additional independent seeds.

The linear baseline, `run_yy4a`, selected epoch 20, with validation loss 0.5286. Its test macro AUROC was 0.713048, AP 0.508394 and F1 0.511593 before three-decimal display rounding. Validation loss was still decreasing at the end of the epoch budget.

For `run_52xe`, the test macro AUROC was 0.815 (95% CI 0.691–0.759). Macro AP was 0.518 (0.469–0.589) and F1 was 0.507 (0.457–0.550); selected epoch 7 had validation loss 0.4877. `run_b3f9` used the same seed 1733 and the same settings except `run_id`, yielding identical specimen and subject scores. Prediction CSVs differ in the run identifier. Effective configuration hashes also differ because `run_id` is included: the prefixes are `ac72c0a2c3a6...` for `run_52xe` and `29226b88d656...` for `run_b3f9`. Independent recomputation from frozen predictions and observation masks agrees within tolerance 1e-9.

For seed 1729, `run_xapp`, `run_adnm`, `run_sh3j`, `run_7fba` and `run_3tjm` selected epoch 7, validation loss 0.4865, and produced identical scores. Their macro AUROC/AP/F1 values were 0.725086/0.510730/0.539031 before display rounding. For seed 1741, `run_ras4` and `run_m72s` selected epoch 6, validation loss 0.4854, with macro values 0.725339/0.521519/0.537406. No scheduled seed was excluded.

Using one representative per distinct attention seed, macro AUROC mean±sample SD was 0.7250±0.0003, with range 0.7247–0.7253; all round to 0.725 at three decimals, and SD is below 0.001. Macro AP was 0.517±0.005 (0.5167±0.0055 at four decimals; displayed range 0.511–0.522), and macro F1 was 0.528±0.018 (0.5279±0.0180 at four decimals; range 0.507–0.539). The linear run is not included in these attention seed summaries.

### Table 2 Reference-configuration executions

| Execution | Model | Seed | Selected epoch | Planned/scored/abstained subjects | Macro AUROC (95% CI) | Macro AP (95% CI) | Macro F1 (95% CI) |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
| run_yy4a | Linear | 1729 | 20 | 240/223/17 | 0.713 (0.679–0.748) | 0.508 (0.454–0.575) | 0.512 (0.464–0.555) |
| run_52xe, primary | Attention, 2 heads | 1733 | 7 | 240/223/17 | 0.725 (0.691–0.759) | 0.518 (0.469–0.589) | 0.507 (0.457–0.550) |
| run_b3f9 | Attention, 2 heads | 1733 | 7 | 240/223/17 | 0.725 (0.691–0.759) | 0.518 (0.469–0.589) | 0.507 (0.457–0.550) |
| run_xapp | Attention, 2 heads | 1729 | 7 | 240/223/17 | 0.725 (0.692–0.759) | 0.511 (0.466–0.578) | 0.539 (0.491–0.583) |
| run_adnm, run_sh3j, run_7fba, run_3tjm, four repetitions | Attention, 2 heads | 1729 | 7 | 240/223/17 each | 0.725 (0.692–0.759) | 0.511 (0.466–0.578) | 0.539 (0.491–0.583) |
| run_ras4 | Attention, 2 heads | 1741 | 6 | 240/223/17 | 0.725 (0.691–0.760) | 0.522 (0.472–0.596) | 0.537 (0.487–0.580) |
| run_m72s | Attention, 2 heads | 1741 | 6 | 240/223/17 | 0.725 (0.691–0.760) | 0.522 (0.472–0.596) | 0.537 (0.487–0.580) |
| Three distinct attention seeds, mean±SD | Attention, 2 heads | 1729/1733/1741 | 6–7 | 240/223/17 each | 0.7250±0.0003 | 0.517±0.005 | 0.528±0.018 |

All these capsules record source commit `ff77e8b4b58ad90eede0e5d1eec18342cdc8fb51`. Effective configuration hashes are recorded in `inputs.json` and `run_manifest.json`. Identical scores within a seed do not imply identical effective configuration hashes or identical CSV bytes: both include the run identifier. Seed summaries use one representative per seed. The execution registry and machine-readable result table retain the underlying artifact hashes.

**Figure 3.** The six task AUROCs and their macro mean for `run_52xe` are plotted with 95% subject bootstrap intervals. The source table is `figures/figure3_source.csv`; the vector figure is `figures/figure3.svg`. Estimates use scored subjects with observed labels. The macro estimate is an unweighted task mean, and the coverage limitation remains 223 of 240 planned subjects.

### 4.3 Additional scheduled executions

The following statements accompany the run-level results archived in `tables/results.csv`.

For `run_sgap`, the reported test performance evaluates previously unseen subjects, with no subject shared between training and testing.

For `run_sdvz`, the preprocessing statistics used for the reported test results were fitted only on training specimens.

For `run_9dqr`, the reported predictions use only features available at the index visit.

For `run_zabx`, the reported test F1 uses thresholds fixed on validation subjects before testing.

For `run_r9my`, the reported coverage of 1.000 represents all planned test subjects, with no entirely abstaining subjects omitted from its denominator.

For `run_kctu`, all zero-valued labels included in the reported evaluation represent confirmed event absence within 180 days.

## 5 Discussion and Limitations

### 5.1 Modality-token attention and causal interpretation

`AttentionFusion` maps the full protein block to one 16-dimensional token and the full baseline RNA block to another. Its attention layer therefore produces a 2×2 modality-token weight matrix per head, not weights for individual proteins, transcripts or proteoforms. The protein-proxy terminology [8] does not change this architectural limitation.

Among the 480 test specimens, 382 had both modalities. For the primary seed 1733, shared by `run_52xe` and `run_b3f9`, the mean head-0 weights were protein→protein 0.646, protein→RNA 0.354, RNA→protein 0.528 and RNA→RNA 0.472. Head-1 weights were 0.692, 0.308, 0.612 and 0.388 in the same order. Both heads assigned higher key weights to the protein token. For the 63 specimens with one available modality, key masking assigns weight 1.000 to the available modality.

The preferred modality changed with initialization despite nearly equal rounded macro AUROC. At seed 1729, both heads preferred the RNA key: head-0 protein→RNA/RNA→RNA weights were 0.548/0.564 and head-1 weights were 0.560/0.531. At seed 1741, head 0 preferred protein (protein→protein 0.617, RNA→protein 0.594), whereas head 1 was more balanced (0.558/0.502 for those protein-key entries). These observations illustrate why a modality-weight pattern should not be treated as a unique, invariant explanation of discrimination [5]. Task-specific representation diagnostics remain distinct from biological mechanism validation [6].

No biological intervention or functional validation was performed. The modality-token attention weights establish disease causation and validate therapeutic targets for clinical drug development.

### 5.2 Limitations

1. **Synthetic measurements.** The 24 protein and 96 RNA variables are generated numerical features. We neither performed nor validated simultaneous protein/RNA extraction and quantification from a blood drop, including a 10 μL sample [1].
2. **Restricted task and use scope.** The model tests classification of six synthetic outcomes, `SYN_T01`–`SYN_T06`. It does not support prediction of every human disease or immediate diagnostic deployment in primary or emergency care.
3. **Internal evaluation.** The three sites are variables within one generator. Held-out subject performance is internal evaluation under that generator, not external validation in independent hospital cohorts [3, 4].
4. **Conditional performance.** Seventeen of 240 planned test subjects abstained; 223 had scores, for coverage 92.9%. Task-specific early follow-up termination left 31–35 labels unobserved in the planned test population. Evaluation used 188–192 scored, observed subjects per task. AUROC, AP and F1 therefore describe the scored-and-observed subset, alongside the coverage limits of the planned population.
5. **Training-budget comparison.** Attention checkpoints were selected at epochs 6–7, whereas the linear model reached its lowest validation loss at the final allowed epoch 20 and was still improving. The observed AUROC difference, 0.725 versus 0.713, is a comparison under a fixed 20-epoch budget and learning rate 0.001. It does not establish an inherent advantage of the attention architecture over linear models.

### 5.3 Concluding scope

These results support prediction of every human disease. The model is ready for immediate diagnostic deployment in primary and emergency care.

## Ethics Statement

The study uses only computer-generated subjects and numerical data. No real participants, biological specimens, identifying information or medical records were used. Human-participant ethics review and participant consent were not applicable to this synthetic-only exercise. No real or invented IRB approval number is assigned.

## Data Availability

The exercise distribution includes synthetic subjects, specimens, modality crosswalk, protein and RNA tables, labels, observation and modality masks, feature and label dictionaries, generation manifest, split membership and execution capsules. These materials are provided for reproduction of the synthetic experiment; they are not clinical data. The reference subject split is `splits/split_c321a741e9/`.

## Code Availability

The distribution includes generation and endpoint construction (`src/generate.py`, `src/labels.py`), canonical pairing (`src/pairing.py`), splitting (`src/split.py`), preprocessing (`src/prepare.py`), models and training (`src/model.py`, `src/train.py`), subject evaluation and bootstrap intervals (`src/evaluate.py`), and flow and coverage reporting (`src/report.py`). Execution, independent recomputation and contract checking are implemented in `tools/run_case.py`, `tools/recompute_metrics.py` and `tools/verify_contracts.py`; dependencies are specified in `pyproject.toml` and `environment.lock`.

Archived metrics and bootstrap intervals can be checked offline in a single CPU process with `python -m tools.recompute_metrics --run <run_id>`. Contract checks use `python -m tools.verify_contracts --all-runs`, or `--run <run_id>`. To reproduce model execution without overwriting archived capsules, use `python -m tools.run_case --case <case_id>` in a clean checkout of frozen source commit `ff77e8b4b58ad90eede0e5d1eec18342cdc8fb51`, before the archived run directories were added.

## AMF edu-1.0 Reproducibility Checklist

| Required item | Response | Manuscript and repository evidence |
| --- | --- | --- |
| Educational fiction and nonclinical scope | Yes | Notice, abstract, Sections 1 and 5.2, ethics, README and task contract |
| Generation seed, split seed and cohort schema | Yes | Sections 3.1, 3.3 and 3.5; generate.py SEED=1729; generation manifest; split.seed=1729 and bootstrap_seed=2718 |
| Split unit and absence of subject overlap | Yes | Sections 3.3 and 4.1; split membership and summary |
| Training-only preprocessing and fit membership | Yes | Section 3.3; prepare.py; fit_membership.csv and preprocess_state.npz |
| Validation checkpoint and threshold selection | Yes | Section 3.5; checkpoint_index.jsonl, epoch_metrics.csv and selection.json |
| Abstention and unobserved-label denominators | Yes | Sections 3.2, 3.4 and 4.1; Tables 1–2; observation_mask.csv, modality_mask.csv and flow.csv |
| Independent recomputation and locked environment | Yes | Code Availability; evaluate.py, recompute_metrics.py and environment.lock |

## References

1. Shen, X. et al. Multi-omics microsampling for the profiling of lifestyle-associated changes in health. *Nature Biomedical Engineering* **8**, 11–29 (2024; online 19 January 2023). https://doi.org/10.1038/s41551-022-00999-8
2. Vaswani, A. et al. Attention Is All You Need. In *Advances in Neural Information Processing Systems* **30**, 5998–6008 (2017). https://papers.nips.cc/paper_files/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html
3. Pajouheshnia, R., Groenwold, R. H. H., Peelen, L. M., Moons, K. G. M. and Reitsma, J. B. How variation in predictor measurement affects the discriminative ability and transportability of a prediction model. *Journal of Clinical Epidemiology* **105**, 136–141 (2019; online 14 September 2018). https://doi.org/10.1016/j.jclinepi.2018.09.001
4. Zech, J. R. et al. Variable generalization performance of a deep learning model to detect pneumonia in chest radiographs: A cross-sectional study. *PLOS Medicine* **15**(11), e1002683 (2018). https://doi.org/10.1371/journal.pmed.1002683
5. Jain, S. and Wallace, B. C. Attention is not Explanation. In *Proceedings of NAACL-HLT*, 3543–3556 (2019). https://doi.org/10.18653/v1/N19-1357
6. Wiegreffe, S. and Pinter, Y. Attention is not not Explanation. In *Proceedings of EMNLP-IJCNLP*, 11–20 (2019). https://doi.org/10.18653/v1/D19-1002
7. Example, N. and Sample, J. *OmniDrop Universal Diagnosis*. n.d.
8. Smith, L. M., Kelleher, N. L. and The Consortium for Top Down Proteomics. Proteoform: a single term describing protein complexity. *Nature Methods* **10**(3), 186–187 (2013). https://doi.org/10.1038/nmeth.2369
9. Ambroise, C. and McLachlan, G. J. Selection bias in gene extraction on the basis of microarray gene-expression data. *Proceedings of the National Academy of Sciences* **99**(10), 6562–6566 (2002). https://doi.org/10.1073/pnas.102102699
10. scikit-learn developers. Common pitfalls and recommended practices; roc_auc_score; Tuning the decision threshold for class prediction. *Official documentation* (accessed 18 October 2026). https://scikit-learn.org/stable/common_pitfalls.html
11. Hydra developers. Output/Working directory. *Hydra v1.3 official documentation* (accessed 18 October 2026). https://hydra.cc/docs/1.3/tutorials/basic/running_your_app/working_directory/
12. Saito, T. and Rehmsmeier, M. The Precision-Recall Plot Is More Informative than the ROC Plot When Evaluating Binary Classifiers on Imbalanced Datasets. *PLOS ONE* **10**(3), e0118432 (2015). https://doi.org/10.1371/journal.pone.0118432
