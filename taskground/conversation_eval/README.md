# conversation_eval

A self-contained loop for one job: **judge AI assistant responses the way human annotators
did, and prove it.** The data is NVIDIA's HelpSteer2 (CC-BY-4.0): real user prompts, some
multi-turn, each with two candidate assistant responses that humans rated on five attributes.
You design the grading rubric and a rerunnable evaluation workflow. The scorer measures how
well its judgments agree with the humans. The dataset splits are checked in, so no dataset
download is needed after `scripts/prepare.py` has run once. Model calls may use the network.

```
conversation_eval/
  data/            what you read
    dev.jsonl          100 conversations WITH human labels — calibrate your rubric here
    dev_pairs.jsonl    the 50 dev response pairs, with the human preference
    test.jsonl         200 conversations WITHOUT labels — the exam
    test_pairs.jsonl   the 100 test pairs, without the preference
  golden/          held-out labels. Read-only. Reading golden/test_* is cheating; the scorer reads it for you.
  work/            your outputs: predictions, rubric drafts, per-item evidence, score reports
  scripts/         prepare.py (regenerate splits), score.py (agreement metrics + pass/fail gates)
  .cache/          the downloaded HelpSteer2 file
```

## The data

Every line of `data/*.jsonl` is one conversation to judge:

```json
{"id": "dev-p003-a", "pair_id": "dev-p003",
 "turns": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}, {"role": "user", "content": "..."}],
 "response": "the final assistant reply that is being rated",
 "labels": {"helpfulness": 3, "correctness": 4, "coherence": 4, "complexity": 1, "verbosity": 2}}
```

- `turns` is the context that precedes the response: always ends with a user turn. About a quarter
  of conversations have more than one turn.
- `response` is the reply under judgment. Two records share each `pair_id` (`-a` and `-b`): same
  `turns`, different `response`. Their order is shuffled and carries no information.
- `labels` appears only in `dev.jsonl`. Every attribute is an integer 0–4, averaged over at least
  three annotators and rounded. HelpSteer2's attribute definitions, paraphrased from its annotation guidelines:

| attribute | 0 | 4 | notes |
| --- | --- | --- | --- |
| helpfulness | not at all useful for the request | completely covers what the user asked, accurately | the headline score; drives the pair preference |
| correctness | mostly wrong or misleading | no factual errors, nothing relevant omitted | includes hallucinated facts and omissions |
| coherence | incoherent, contradictory, hard to follow | clear, consistent, well organised | independent of whether it is helpful |
| complexity | anyone could have written it | needs deep domain expertise to write | describes the response, not the prompt |
| verbosity | far too terse for the request | far too long for the request | 2 is "about right"; not a quality score |

  Helpfulness, correctness and coherence are quality scores where higher is better. Complexity
  and verbosity are descriptive: the human distribution centres on 2 and neither extreme is "good".
  On dev the majority values are 4, 4, 4, 2, 2 respectively.

- `data/*_pairs.jsonl`: `{"pair_id", "a", "b"}` and, in dev only, `"preferred": "a" | "b" | "tie"`.
  The preference is derived from the helpfulness labels: the higher-rated response wins; equal
  ratings are a tie. Between a quarter and a third of pairs are ties.
- Sizes: no conversation exceeds 12 000 characters (prompt plus response).
  Median is about 2 000 characters.

## Predictions

Write JSON lines to `work/`. Any subset of attributes and items is scored; missing items count
against coverage.

```
work/predictions.jsonl        {"id": "test-p012-a", "helpfulness": 3, "correctness": 4, "coherence": 4, "complexity": 1, "verbosity": 2}
work/pair_predictions.jsonl   {"pair_id": "test-p012", "preferred": "b"}       # "a" | "b" | "tie"
```

For dev calibration runs use `work/dev_predictions.jsonl` and `work/dev_pair_predictions.jsonl`
(or pass `--predictions` / `--pairs` explicitly). Keep each attempt's files; the scorer overwrites
only its own report.

## Scoring

```sh
scripts/score.py --split dev      # against the visible dev labels; never fails the exit code
scripts/score.py                  # against golden/test_*; exit 0 only when every gate passes
```

Per attribute the scorer prints `exact` agreement, `within1` (|pred − human| ≤ 1), `mae`,
Spearman `rho`, and `qwk`, the quadratic-weighted kappa, which is the metric that matters: it is
chance-corrected, so a judge that answers the majority value for everything scores 0.0 no matter
how often that value happens to be right. The baseline column shows exactly that constant judge.
For pairs it prints `accuracy_all` (ties included), `decisive_accuracy` (human said a or b, and the
judge picked a side), how often the judge abstained with `tie` on a decisive pair, and `tie_recall`.
The full breakdown, including predicted-vs-human distributions per attribute, goes to
`work/score-<split>.json`.

## Definition of done

The scoring target is `SCORE PASS` from `scripts/score.py` on the test split, meaning all
four gates hold:

| gate | threshold | what a constant judge gets |
| --- | --- | --- |
| coverage | 1.0 on both files | — |
| helpfulness `qwk` | ≥ 0.45 | 0.00 |
| helpfulness `within1` | ≥ 0.80 | ≈ 0.72 |
| pairs `decisive_accuracy` | ≥ 0.65 | ≈ 0.47 (always "a") |

The other four attributes are reported but not gated; a good rubric still moves them, and a
report that shows correctness and coherence kappa alongside helpfulness is more convincing than
one that does not. The thresholds are provisional calibration targets, not the ceiling.

Rules:

1. Predictions must be produced by model calls or executable code over the conversation text.
   Do not assign individual ratings or preferences in your own reasoning. Preserve the rubric,
   configuration, and evidence needed to reproduce the workflow. Dev labels may inform calibration;
   keep reference labels separate from the inputs used to judge each item.
2. `golden/test_labels.jsonl` and `golden/test_pairs.jsonl` are never read, grepped, copied or
   diffed by anything you run. `golden/dev_*` is the same information as `data/dev.jsonl` and is
   fine to use.
3. Ties are legitimate answers, but abstaining on every pair is not a strategy: the pair gate only
   counts pairs where you picked a side, and the report shows how many decisive pairs you dodged.

## Calibration and deliverables

Score the first workflow on dev, then do exactly two rounds of refinement. After each of the
first two dev reports, inspect the errors and distributions, state the reason for the next
change, change the workflow, and re-score. Preserve each round's rubric, predictions, evidence,
and report under `work/` with `-r1`, `-r2`, and `-r3` suffixes.

Freeze the final version after r3. Grade every test response on all five attributes and every
test pair once, writing `work/predictions.jsonl` and `work/pair_predictions.jsonl`, then run
`scripts/score.py`. Report the result even if a gate fails; do not tune against test results or
repeat the test evaluation to chase a pass.

Deliver the rerunnable workflow and a short report containing dev scores for all three rounds,
the final test score table, the actual final rubric text, and what changed between rounds and
why. Document the command that reproduces the final predictions from scratch. Model judgments
may vary between executions; record the model and settings used. Preserve completed evidence
when recovering from execution errors.

## Example task statement

> Build an evaluation workflow for the HelpSteer2 conversations in this folder. Follow the
> calibration and deliverable requirements above: three dev rounds with documented refinements,
> then one final test evaluation. Do not rate items in your own reasoning or read held-out labels.
> Deliver the workflow, score tables, final rubric, and explanation of the refinements.

## Regenerating the splits (maintainers only)

`scripts/prepare.py` downloads HelpSteer2's validation split (1 038 responses, 519 prompts,
about 600 KB) into `.cache/`, drops nothing at the default 12 000-character cap, shuffles with
`--seed 2026`, and writes the splits above. Change `--dev`, `--test` or `--seed` for a different
exam; `golden/MANIFEST.json` records the parameters used. If Hugging Face starts requiring a
login for the download, place `validation.jsonl.gz` at `.cache/helpsteer2-validation.jsonl.gz`
by hand and rerun with `--offline`.
