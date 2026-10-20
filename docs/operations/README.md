# Operating Folio

Folio is a library: it has no deployment of its own to operate, so this covers the two
things a maintainer does over time, keeping the model Folio names current and cutting a
release.

## Model lifecycle

Folio makes one kind of model call, `media.describe` (`anthropicDescriber`), and a host
pays for it. The task is registered in `src/server/llm-tasks.json` with its model, its
model line, the lines a candidate may come from, its prompt file and its eval suite.
`llm-prices.json` beside it prices those models for evals.

Folio is a library, so its consumers choose the model. The eval suite gates prompt
changes in Folio; consumers own model choice and the model watch. The registry has
`watch: false` (the reason is in its `watchReason` field), so the ops model watch raises
nothing for Folio. A host registers `media.describe` in its own registry, passes `model`
explicitly and runs Folio's suite in its own eval.

1. **Eval.** On a pull request that changes a prompt or the default model, the `evals`
   job in `ci.yml` runs the suite with the registry's model and compares it with
   `evals/media.describe/baseline.json`. The `llm-eval.yml` workflow stays for a manual
   dispatch that compares two models: pass rate, cost per case, latency and contract
   failures.
2. **Change the default.** Changing `model` in `llm-tasks.json` is a pull request that
   updates `baseline.json` with it and ships as a minor release, because
   `DEFAULT_DESCRIBE_MODEL` changes what a host that sets no `model` pays for. The
   `UPGRADING.md` entry names the old and new model and quotes the eval deltas.

Hosts that pass their own `model` are unaffected by any of this.

## Releasing

See "Releasing" in `CLAUDE.md`: bump `package.json` in a PR, dry-run `release.yml` with
the tag, then push an annotated tag on the merged commit. The release notes are the
`UPGRADING.md` entries whose heading names the tag.
