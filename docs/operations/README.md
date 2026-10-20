# Operating Folio

Folio is a library: it has no deployment of its own to operate, so this covers the two
things a maintainer does over time, keeping the model Folio names current and cutting a
release.

## Model lifecycle

Folio makes one kind of model call, `media.describe` (`anthropicDescriber`), and a host
pays for it. The task is registered in `src/server/llm-tasks.json` with its model, its
model line, the lines a candidate may come from, its prompt file and its eval suite.
`llm-prices.json` beside it prices those models for evals.

1. **Watch.** The ops model watch reads the registry (once `watch` is `true`) and files
   an issue labelled `source:llm-watch` when a newer model exists in a candidate line.
   A task with no eval suite gets `eval-gap` instead.
2. **Eval.** The `llm-eval` workflow runs the task's suite against the current model and
   the candidate and comments the comparison on the issue: pass rate, cost per case,
   latency and contract failures. On a pull request the `evals` job in `ci.yml` runs the
   suite with the registry's model and compares it with `evals/media.describe/baseline.json`.
3. **Adopt.** Adoption is a pull request that changes `model` in `llm-tasks.json` and
   `baseline.json` together. It ships as a minor release, because `DEFAULT_DESCRIBE_MODEL`
   changes what a host that sets no `model` pays for. The `UPGRADING.md` entry names the
   old and new model and quotes the eval deltas.
4. **Hold.** A model that should not move yet gets a `hold` on its registry entry with a
   reason and a date, so the watch stops raising it.

Hosts that pass their own `model` are unaffected by any of this.

## Releasing

See "Releasing" in `CLAUDE.md`: bump `package.json` in a PR, dry-run `release.yml` with
the tag, then push an annotated tag on the merged commit. The release notes are the
`UPGRADING.md` entries whose heading names the tag.
