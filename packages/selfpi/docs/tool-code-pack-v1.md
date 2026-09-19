# Tool-code pack v1 (SelfPi)

Widened-but-bounded editable surface: **coding-agent tool implementation code**, not prompts/skills and not the SelfPi controller.

Path-recovery-v0 remains available as a legacy probe. New supervised work targets this pack.

## Goals

- Differentiate from Prime/Pi “improve prompts” modes by editing **real harness code**.
- Keep a sealed propose → gate → Docker A/B → promote loop.
- Use **natural** tool failures (no path bait). Strong eval models must still hit the failure mode often enough to learn.

## Editable surface

| Pattern | Notes |
|---|---|
| `packages/coding-agent/src/core/tools/**` | Tool implementations and shared helpers (`truncate`, wrappers, etc.) |
| Exclude (still under tree but discouraged): `**/renderers/**` | Prefer not changing TUI/render output in v1; policy may still allow if paths match `tools/**` — reviewers should reject renderer-only churn |

Exact experiment globs:

```text
packages/coding-agent/src/core/tools/**
```

## Protected surface

Must not overlap editable roots:

```text
packages/selfpi/**
packages/selfpi-recovery-policy/**
.selfpi/**
packages/coding-agent/src/core/extensions/**
packages/coding-agent/src/core/auth-storage.ts
packages/coding-agent/src/core/model-runtime.ts
packages/coding-agent/src/core/agent-session.ts
packages/coding-agent/src/core/agent-session-runtime.ts
packages/coding-agent/src/core/session-manager.ts
packages/ai/**
```

Protected = measurement integrity + session/auth + SelfPi loop. Editable tools code must not be covered by a broad `packages/coding-agent/**` protect pattern.

## Out of scope (v1)

- System prompt, skills, prompt templates, compaction prompts
- SelfPi gateway / promotion / verifiers / sealed evidence builders
- Whole-monorepo edits

## Failure sources (natural)

Corpus: `packages/selfpi/protected/tool-code-corpus-v1` (registry `tool-code-registry-v1`, 4 held-in / 4 held-out).
No path-bait perturbations. Failure catalog (held-in only for sealed evidence) lives beside the registry.

Families (hardened with patterns mined from Terminal-Bench / Recovery-Bench; still natural, no path bait; does **not** replace those benches):

- Stale docs → `read` ENOENT, then a **fat + decoy-saturated** `active_config=` index past byte/line truncation (`-01`)
- Bash non-zero with **same-shaped** `ERROR_CODE=dyn-*` flood; sole `AUTH_MARK` marks the real mid-stream code (`-02`)
- Needle past default read truncation amid **≥100 same-key decoys** that fill grep’s default match window (`-03`)
- Non-unique `edit` oldText across **many near-duplicate MODE / *production* alias blocks** (`-04`)

Pattern sources / **evaluation bar**: Terminal-Bench **tasks** under the SelfPi harness (primary); Recovery-Bench optional side calibration.
See `docs/terminal-bench-eval.md`. Do **not** regress synthetic corpus or eval model to fit luna; do **not** replace SelfPi A/B with Harbor.

Success for **learning** requires Terminal-Bench (or equally hard) evaluation — not saturation of `tool-code-corpus-v1`.

## Metrics

| Gate | Rule |
|---|---|
| Held-in completion gain | `minimumHeldInCompletionGain` ≥ 1 for smoke, ≥ 2 for full (configurable) |
| Held-out non-regression | `maximumHeldOutCompletionLoss` = 0 |
| Recovery-rate improvement | **off** for tool-code-v0 unless a separate tool-error recovery definition is added later |
| Cost (optional later) | non-worse tokens/cost at equal quality |

## Change budget

Reuse SelfPi proposal change budget defaults (expected ≤ 100 lines; justification above; human approval above 250) until pack-specific budgets are tuned.

## Phased delivery

1. **This doc + pack constants + experiment scaffold** (surfaces, promotion flags) — done.
2. **Natural-failure corpus + evidence extractor** — done (`tool-code-corpus-v1`, `extractToolFailureSignatures`, `buildToolCodeHeldInEvidence`).
3. **Supervised lifecycle** — done: pack profile routes `buildEvidence` / checks / smoke / propose+review prompts; tool-code uses coding-agent tool tests; CLI passes `experimentId`.
4. **Default hero** — done: when experiments/ is scanned without an id, `tool-code-v0.json` is preferred; `path-recovery-v0` remains an optional legacy experiment.

## Example runtime

- Default pack: `examples/supervised-v0/tool-code-v0.json` + `runtime.tool-code.json` (install `tool-code-corpus-v1` into the SelfPi root as `task-registry.json`).
- Legacy: `path-recovery-v0.json` + `runtime.json` with the path-recovery registry.

## Interview one-liner

> SelfPi runs a sealed improve loop over a bounded coding-agent **tools code pack** (not prompts), with held-in/out Docker eval and promote/rollback — after path-bait recovery proved too weak a learning problem for strong eval models.
