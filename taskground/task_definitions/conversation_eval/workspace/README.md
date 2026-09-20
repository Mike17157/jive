# Conversation grading calibration

Judge assistant responses against human ratings using a small, fixed subset of NVIDIA HelpSteer2 (CC-BY-4.0). This preserves the original task's three-round calibration process, with 20 dev responses (10 pairs) and 40 test responses (20 pairs).

## Inputs and ratings

`data/dev.jsonl` contains response records with `id`, `pair_id`, `turns`, `response`, and human `labels`. `data/test.jsonl` omits the labels. `data/dev_pairs.jsonl` contains `pair_id`, `a`, `b`, and `preferred`; test pairs omit the preference. All inputs are local.

Predict all five integer attributes from 0 to 4:

| Attribute | 0 | 4 |
| --- | --- | --- |
| helpfulness | Does not help with the request | Fully satisfies the request |
| correctness | Mostly incorrect | No factual errors or material omissions |
| coherence | Incoherent | Clear and well organized |
| complexity | No expertise required | Requires deep expertise |
| verbosity | Far too terse | Far too long |

For verbosity, 2 means an appropriate amount of detail. Complexity and verbosity are descriptive, not qualities to maximize. Prefer `a`, `b`, or `tie` for each response pair, based on helpfulness. Preserve legitimate ties.

## Calibration and outputs

1. Create a rubric and executable workflow. Produce all five ratings together per response, plus pair preferences. Score on dev with `python3 scripts/score.py --predictions work/dev_predictions-r1.jsonl --pairs work/dev_pair_predictions-r1.jsonl --out work/score-dev-r1.json`.
2. Inspect dev errors, explain the next change, and refine twice, producing rounds `r2` and `r3` using the same scorer and matching file suffixes.
3. Freeze after r3. Evaluate each test response and pair once. Write `work/predictions.jsonl` and `work/pair_predictions.jsonl`. The runner performs held-out scoring after your run; do not seek test labels or tune on test scores.

Response format: `{"id":"test-p012-a","helpfulness":3,"correctness":4,"coherence":4,"complexity":1,"verbosity":2}`.
Pair format: `{"pair_id":"test-p012","preferred":"b"}`.

Preserve these files for **each** round `r1`, `r2`, `r3`: `dev_predictions-rN.jsonl`, `dev_pair_predictions-rN.jsonl`, `rubric-rN.md`, `evidence-rN.jsonl`, and `score-dev-rN.json`, all under `work/`. Include the final rubric, dev tables, reasons for each refinement, model/settings, and reproduction command in `work/report.md`. Preserve a rerunnable workflow and reuse completed evidence when recovering from errors.

The complete process involves 150 response-and-pair judgments: three rounds of 20 responses + 10 pairs, then 40 responses + 20 pairs. Each response judgment covers all five attributes. Batching is optional.

## Success criteria

Predictions must come from model calls or executable code over conversation text, not per-item answers assigned in the main agent's reasoning. Dev labels can inform rubric calibration but must remain separate from judgment inputs. Do not modify supplied inputs/scripts or inspect verifier files, other runs, original datasets, or held-out labels.

Provisional test targets: complete coverage for every attribute and pair, helpfulness quadratic-weighted kappa at least 0.45, helpfulness within-one agreement at least 0.80, and pair accuracy on human-decisive pairs at least 0.65. Abstaining on a decisive pair counts as wrong. The runner also checks that all three rounds' artifacts exist and contain complete predictions. Method, evidence quality, and replayability need separate trace review.

This is a development adaptation, not an official HelpSteer2 benchmark score. The larger original task remains in the source repository; use only this run's inputs.
