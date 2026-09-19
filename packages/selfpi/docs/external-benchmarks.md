# External benchmarks

## Principle

**Do not regress to fit.** Eval difficulty stays at real Terminal-Bench **tasks**,
run under the **SelfPi harness** — not a softened synthetic corpus, a weaker
model, or a second eval harness (Harbor) in the promote path.

See **[terminal-bench-eval.md](./terminal-bench-eval.md)** for the SelfPi split:

- **tool-code-v0** = editable tools pack (propose / gate)
- **SelfPi harness** = A/B evaluation runner
- **Terminal-Bench tasks** = hard instructions + `tests/test.sh` grading
- **Harbor** = optional task download / side calibration only
- **Recovery-Bench** = optional recovery calibration

`tool-code-corpus-v1` remains for sealed-loop plumbing only.

## Registry

`src/benchmarks/external-benchmarks.ts` — pinned upstreams, licenses, smoke task ids
(`role: evaluation` for Terminal-Bench).

## Adapter

`src/benchmarks/terminal-bench-task-adapter.ts` — TB task refs → SelfPi
`shell_reward` evaluation tasks, held-in/out split, reward parsing, completion gain.

## Plan

```bash
node packages/selfpi/scripts/run-terminal-bench-eval.mjs plan
```
