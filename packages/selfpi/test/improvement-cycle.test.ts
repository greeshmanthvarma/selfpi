import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type EvaluationFingerprintInputs,
	type ImprovementCycleAdapters,
	type ImprovementCycleInput,
	runImprovementCycle,
} from "../src/index.ts";

const candidatePath = "packages/selfpi-recovery-policy/src/index.ts";
const unifiedDiff = `diff --git a/${candidatePath} b/${candidatePath}
--- a/${candidatePath}
+++ b/${candidatePath}
@@ -1 +1 @@
-return undefined;
+return guidance;
`;

const fingerprintInputs: EvaluationFingerprintInputs = {
	version: 1,
	harness: { baselineCommit: "active-commit", candidateParentCommit: "active-commit" },
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
	repetitions: 3,
};

const attempt = (verifiedCompletion: boolean) => ({
	fingerprintInputs,
	result: {
		transcript: [],
		usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
		termination: { reason: "completed" as const, exitCode: 0, signal: null },
		verifier: {
			taskId: "path-recovery-01",
			verifiedCompletion,
			reason: verifiedCompletion ? ("verified" as const) : ("artifact_missing" as const),
		},
		processOutput: { stdout: "", stderr: "" },
	},
});

describe("improvement cycle orchestration", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("persists one bounded candidate cycle and stops at rejection", async () => {
		const rootDirectory = await mkdtemp(join(tmpdir(), "selfpi-cycle-"));
		temporaryDirectories.push(rootDirectory);
		const input: ImprovementCycleInput = {
			rootDirectory,
			runId: "run-001",
			now: () => new Date("2026-09-17T22:00:00.000Z"),
			experiment: {
				version: 1,
				id: "path-recovery-v0",
				heldIn: ["held-in-01"],
				heldOut: ["held-out-01"],
				budget: { wallClockMs: 60_000, toolCalls: 20, turns: 10, tokens: 50_000, costUsd: 2 },
				editableSurface: ["packages/selfpi-recovery-policy/src/**"],
				protectedSurface: ["packages/selfpi/**", ".selfpi/**"],
				promotionPolicy: {
					minimumHeldInCompletionGain: 2,
					maximumHeldOutCompletionLoss: 0,
					requireRecoveryRateImprovement: true,
				},
			},
			proposal: {
				baselineCommit: "active-commit",
				activeHarnessCommit: "active-commit",
				prompt: "Propose one bounded recovery improvement.",
				model: { provider: "fake", id: "fixed-model", configuration: { thinking: "low" } },
				evidence: {
					bundle: {
						version: 1,
						heldInFailures: [],
						redactedRepresentativeTraces: [],
						heldInVerifierOutcomes: [],
						preservedSuccesses: [],
						editableSource: [],
						rejectedHypotheses: [],
						proposalSchema: { version: 1, requiredFields: [] },
						editableSurface: ["packages/selfpi-recovery-policy/src/**"],
						changeBudget: {
							expectedMaximumChangedLines: 100,
							justificationRequiredAbove: 100,
							humanApprovalAbove: 250,
						},
					},
					digest: "sha256:evidence",
				},
			},
			review: {
				relevantSource: "export function applyPathRecoveryPolicy() {}",
				repositoryInstructions: "Keep changes inside the editable surface.",
				reviewer: {
					provider: "fake-reviewer",
					model: "review-model",
					promptVersion: "review-v1",
					prompt: "Review without rewriting.",
				},
			},
			humanApproval: false,
		};
		const externalStages: string[] = [];
		const adapters: ImprovementCycleAdapters = {
			git: {
				async createWorktree() {
					return { directory: "/disposable-worktree" };
				},
				async collectDiff() {
					return unifiedDiff;
				},
				async removeWorktree() {},
			},
			proposer: {
				async run() {
					return {
						version: 1,
						hypothesis: "Recovery guidance improves failed reads.",
						targetFailureSignature: "held-in-01:read-call",
						affectedEditableSurface: [candidatePath],
						unifiedDiff,
						expectedBehavioralMechanism: "Provide a search strategy.",
						predictedBenefit: "Recover one task.",
						regressionRisks: ["Guidance may distract."],
					};
				},
			},
			checks: {
				async run() {
					externalStages.push("checks");
					return {
						appliesCleanly: true,
						formatting: true,
						typeChecking: true,
						targetedTestsPassed: true,
					};
				},
			},
			reviewer: {
				async review() {
					externalStages.push("review");
					return {
						decision: "approve_for_evaluation",
						hypothesisAlignment: "aligned",
						risks: [],
						violations: [],
					};
				},
			},
			smoke: {
				async run() {
					externalStages.push("smoke");
					return { buildPassed: true, smokePassed: true };
				},
			},
			evaluator: {
				async run() {
					externalStages.push("evaluation");
					return {
						comparison: {
							baseline: attempt(false),
							candidate: attempt(true),
							baselineCompletions: 0,
							candidateCompletions: 1,
							completionGain: 1,
						},
						outcomes: {
							baselineRepetitions: 3,
							candidateRepetitions: 3,
							baselineHeldInCompletions: 0,
							candidateHeldInCompletions: 1,
							baselineHeldOutCompletions: 3,
							candidateHeldOutCompletions: 3,
							baselineRecoveryRate: 0,
							candidateRecoveryRate: 1,
						},
						efficiency: {
							baselineTokens: 100,
							candidateTokens: 120,
							baselineCostUsd: 0.1,
							candidateCostUsd: 0.12,
						},
						integrityViolation: false,
					};
				},
			},
		};

		const run = await runImprovementCycle(input, adapters);

		expect(run.manifest.state).toBe("rejected");
		expect(externalStages).toEqual(["checks", "review", "smoke", "evaluation"]);
		expect(run.events.map((event) => event.state)).toEqual([
			"created",
			"evidence_ready",
			"proposal_generated",
			"policy_passed",
			"review_passed",
			"smoke_passed",
			"evaluation_complete",
			"rejected",
		]);
		const runDirectory = join(rootDirectory, "runs/run-001");
		expect(JSON.parse(await readFile(join(runDirectory, "decision.json"), "utf8"))).toMatchObject({
			decision: "rejected",
			metrics: { heldInCompletionGain: 1 },
		});
		expect(JSON.parse(await readFile(join(runDirectory, "smoke-result.json"), "utf8"))).toEqual({
			version: 1,
			buildPassed: true,
			targetedTestsPassed: true,
			smokePassed: true,
		});
	});
});
