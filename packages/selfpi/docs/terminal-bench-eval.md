# Terminal-Bench tasks on the SelfPi harness

## Principle

Do **not** regress to fit luna. The improve loop’s promotion signal must come from
**real Terminal-Bench task difficulty**, graded under **SelfPi’s own eval harness**
(baseline vs candidate coding-agent).

Harbor is **not** the improve-loop evaluator. It may still help download TB tasks
or run side calibration; it does not replace SelfPi A/B.

| Layer | Owns | Does not own |
|---|---|---|
| **tool-code pack** (`tool-code-v0`) | Editable surface; propose → policy → review → smoke | Soft synthetic held-in that luna already saturates |
| **SelfPi eval harness** | Docker A/B, coding-agent baseline vs candidate, promote metrics | External Harbor agent stacks (terminus-2, etc.) |
| **Terminal-Bench tasks** | Hard instructions + `tests/test.sh` reward grading | Replacing the SelfPi harness |
| **Recovery-Bench** | Optional recovery calibration (side channel) | Primary promote metric |

`tool-code-corpus-v1` remains for sealed-loop plumbing. It is **not** the learning bar.

## Target architecture

1. **Propose / gate** stay on the tools-code pack.
2. **A/B evaluation** runs SelfPi’s harness on **Terminal-Bench tasks** (instruction as task input; workspace from the task tree).
3. **Promote** on held-in completion gain from adapted `tests/test.sh` → workspace `logs/verifier/reward.txt` (`shell_reward` verifier), not `exact_file` toys.

## SelfPi verifier adaptation

TB scripts write `/logs/verifier/reward.txt`. SelfPi remaps that to the eval
workspace and runs the script host-side after the agent attempt:

- Verifier type: `shell_reward`
- `testScript`: `tests/test.sh`
- `rewardDirectory`: `logs/verifier`

See `toSelfPiEvaluationTask` in `src/benchmarks/terminal-bench-task-adapter.ts`.

## Smoke subset

Pinned in `src/benchmarks/external-benchmarks.ts` (real TB 2.1 task names; SelfPi ids omit the `terminal-bench/` prefix for fixture safety):

- Dataset pin: `terminal-bench/terminal-bench-2-1`
- Tasks: `sqlite-db-truncate`, `db-wal-recovery`, `large-scale-text-editing`
- Default split: first N−1 held-in, last held-out
- Packaged corpus: `protected/terminal-bench-smoke-v1` (vendored trees + `shell_reward` verifiers)
- Tool-code improve A/B evaluates this corpus under SelfPi; sealed evidence still uses `tool-code-corpus-v1`

```bash
node packages/selfpi/scripts/run-terminal-bench-eval.mjs plan
# Rebuild from a local Harbor export / cache flatten:
# node packages/selfpi/scripts/generate-terminal-bench-smoke-corpus.mjs --source <dir>
```

## Explicit non-goals

- Using Harbor (or any other harness) as the SelfPi promote A/B runner
- Tuning synthetic corpus until baseline fails
- Dropping eval model class to unlock promotes
- Vendoring full TB trees into `protected/tool-code-corpus-v1` as fake SelfPi fixtures
