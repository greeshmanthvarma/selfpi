import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunRecordStore, type EvaluationFingerprintInputs, type HarnessAttemptComparison } from "../src/index.ts";

const fingerprint = (commit: string): EvaluationFingerprintInputs => ({
	version: 1,
	harness: { baselineCommit: commit, candidateParentCommit: commit },
	model: { provider: "fake", id: "deterministic-v1", parameters: { temperature: 0 } },
	systemInputsDigest: "sha256:system",
	task: { setVersion: "path-recovery-v0", repositoryCommits: { "path-recovery-01": "fixture" } },
	dependencies: { lockfileDigest: "sha256:lock" },
	evaluator: { version: "evaluator-v1" },
	verifier: { version: "verifier-v1" },
	container: {
		imageDigest: "sha256:container",
		networkPolicyDigest: "sha256:network",
		cpuLimit: 1,
		memoryMb: 512,
	},
	budget: { timeoutMs: 5_000, toolCalls: 20, turns: 10, tokens: 50_000, costUsd: 2 },
	repetitions: 1,
});

const attempt = (commit: string, verifiedCompletion: boolean) => ({
	fingerprintInputs: fingerprint(commit),
	result: {
		transcript: [],
		usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		termination: { reason: "completed" as const, exitCode: 0, signal: null },
		verifier: {
			taskId: "path-recovery-01",
			verifiedCompletion,
			reason: verifiedCompletion ? ("verified" as const) : ("artifact_missing" as const),
		},
		processOutput: { stdout: "", stderr: "" },
	},
});

describe("improvement run integrity", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("invalidates evaluation performed against a different commit than the proposal base", async () => {
		const rootDirectory = await mkdtemp(join(tmpdir(), "selfpi-integrity-"));
		temporaryDirectories.push(rootDirectory);
		const store = createRunRecordStore({ rootDirectory, now: () => new Date("2026-09-17T21:00:00.000Z") });
		await store.create({ runId: "run-001", experimentId: "path-recovery-v0" });
		await store.transition("run-001", "evidence_ready");
		await store.recordCandidateProposal("run-001", {
			ok: true,
			proposal: {
				version: 1,
				hypothesis: "Guide path recovery.",
				targetFailureSignature: "held-in-01:read-call",
				affectedEditableSurface: ["packages/selfpi-recovery-policy/src/index.ts"],
				unifiedDiff: "diff",
				expectedBehavioralMechanism: "Provide guidance.",
				predictedBenefit: "Recover one task.",
				regressionRisks: ["May distract."],
				changedPaths: ["packages/selfpi-recovery-policy/src/index.ts"],
			},
			provenance: {
				provider: "fake",
				model: "fixed",
				modelConfiguration: {},
				activeHarnessCommit: "active-commit",
				prompt: "propose",
				evidenceBundleDigest: "sha256:evidence",
				worktreeBase: "active-commit",
				unifiedDiff: "diff",
			},
		});
		await store.recordCandidatePolicy("run-001", {
			eligible: true,
			size: "expected",
			changedLines: 2,
			violations: [],
		});
		await store.recordCandidateReview("run-001", {
			proceed: true,
			candidate: {
				version: 1,
				hypothesis: "Guide path recovery.",
				targetFailureSignature: "held-in-01:read-call",
				affectedEditableSurface: ["packages/selfpi-recovery-policy/src/index.ts"],
				unifiedDiff: "diff",
				expectedBehavioralMechanism: "Provide guidance.",
				predictedBenefit: "Recover one task.",
				regressionRisks: ["May distract."],
				changedPaths: ["packages/selfpi-recovery-policy/src/index.ts"],
			},
			review: {
				version: 1,
				reviewerModel: "reviewer",
				reviewerProvider: "fake",
				promptVersion: "v1",
				prompt: "review",
				decision: "approve_for_evaluation",
				hypothesisAlignment: "aligned",
				risks: [],
				violations: [],
			},
		});
		await store.transition("run-001", "smoke_passed");
		const comparison: HarnessAttemptComparison = {
			baseline: attempt("different-commit", false),
			candidate: attempt("different-commit", true),
			baselineCompletions: 0,
			candidateCompletions: 1,
			completionGain: 1,
		};

		await expect(store.recordEvaluation("run-001", comparison)).rejects.toThrow("provenance");

		const run = await store.open("run-001");
		const integrity = JSON.parse(
			await readFile(join(rootDirectory, "runs/run-001/integrity-result.json"), "utf8"),
		) as unknown;
		expect(run.manifest.state).toBe("invalid");
		expect(integrity).toEqual({
			version: 1,
			valid: false,
			violation: "evaluation_provenance_mismatch",
		});
	});
});
