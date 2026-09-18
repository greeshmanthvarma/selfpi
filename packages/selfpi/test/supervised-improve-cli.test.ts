import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSelfPiCli } from "../src/cli/run-selfpi-cli.ts";
import type { EvaluatedHarnessAttempt } from "../src/evaluation/compare-harness-attempts.ts";
import type { SupervisedImprovementAdapters } from "../src/supervised/run-supervised-improvement.ts";

const activeCommit = "a".repeat(40);
const candidateCommit = "b".repeat(40);
const activeImageDigest = `sha256:${"c".repeat(64)}`;
const containerDigest = `sha256:${"d".repeat(64)}`;
const candidateImageDigest = `sha256:${"e".repeat(64)}`;
const verifierDigest = `sha256:${"f".repeat(64)}`;
const repositoryCommit = "1".repeat(40);
const candidateDiff = [
	"diff --git a/packages/selfpi-recovery-policy/src/index.ts b/packages/selfpi-recovery-policy/src/index.ts",
	"--- a/packages/selfpi-recovery-policy/src/index.ts",
	"+++ b/packages/selfpi-recovery-policy/src/index.ts",
	"@@ -1 +1 @@",
	"-return undefined;",
	"+return guidance;",
	"",
].join("\n");

describe("supervised selfpi improve", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("runs one supervised cycle and materializes only promotion-eligible real evidence", async () => {
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-supervised-cli-"));
		temporaryDirectories.push(rootDirectory);
		await mkdir(path.join(rootDirectory, "experiments"), { recursive: true });
		await mkdir(path.join(rootDirectory, "promotion"), { recursive: true });
		const registry = {
			version: 1,
			id: "registry-v1",
			tasks: [
				{
					id: "held-in-1",
					set: "held_in",
					repository: { url: "https://example.invalid/held-in.git", commit: repositoryCommit },
					input: "Recover the missing path.",
					verifier: { id: "held-in-verifier", digest: verifierDigest },
					perturbation: { version: 1, path: "src/config.ts", error: "ENOENT src/config.ts" },
				},
				{
					id: "held-out-1",
					set: "held_out",
					repository: { url: "https://example.invalid/held-out.git", commit: repositoryCommit },
					input: "Complete the sealed task.",
					verifier: { id: "held-out-verifier", digest: verifierDigest },
				},
			],
		};
		const registrySource = `${JSON.stringify(registry, null, 2)}\n`;
		const registryDigest = `sha256:${createHash("sha256").update(registrySource).digest("hex")}`;
		await Promise.all([
			writeFile(
				path.join(rootDirectory, "experiments/path-recovery-v0.json"),
				`${JSON.stringify({
					version: 1,
					id: "path-recovery-v0",
					heldIn: ["held-in-1"],
					heldOut: ["held-out-1"],
					budget: { wallClockMs: 60_000, toolCalls: 20, turns: 10, tokens: 50_000, costUsd: 2 },
					editableSurface: ["packages/selfpi-recovery-policy/src/**"],
					protectedSurface: ["packages/selfpi/**", ".selfpi/**"],
					promotionPolicy: {
						minimumHeldInCompletionGain: 2,
						maximumHeldOutCompletionLoss: 0,
						requireRecoveryRateImprovement: true,
					},
				})}\n`,
				"utf8",
			),
			writeFile(
				path.join(rootDirectory, "runtime.json"),
				`${JSON.stringify({
					version: 1,
					mode: "supervised_v0",
					proposer: { provider: "fake-provider", model: "proposer-model", thinking: "low" },
					reviewer: { provider: "independent-provider", model: "reviewer-model" },
					gateway: { identity: "gateway-v1", endpoint: "http://gateway.internal/v1" },
					container: { imageDigest: containerDigest },
					evaluation: { repetitions: 2 },
					taskRegistry: { id: registry.id, digest: registryDigest },
				})}\n`,
				"utf8",
			),
			writeFile(path.join(rootDirectory, "task-registry.json"), registrySource, "utf8"),
			writeFile(
				path.join(rootDirectory, "promotion/active.json"),
				`${JSON.stringify({
					version: 1,
					reference: "refs/selfpi/active",
					current: { sourceCommit: activeCommit, imageDigest: activeImageDigest },
				})}\n`,
				"utf8",
			),
		]);

		const attempts = [
			attempt("held-in-1", "held_in", 0, false, true, registryDigest),
			attempt("held-in-1", "held_in", 1, false, true, registryDigest),
			attempt("held-out-1", "held_out", 0, true, true, registryDigest),
			attempt("held-out-1", "held_out", 1, true, true, registryDigest),
		];
		const first = attempts[0];
		if (first === undefined) throw new Error("Missing test attempt.");
		const adapters: SupervisedImprovementAdapters = {
			gateway: {
				baseEndpoint: "http://gateway.internal",
				async issueSession(input) {
					return {
						id: `${input.role}-session`,
						endpoint: `http://gateway.internal/runs/run-supervised-001/roles/${input.role}/v1`,
						credential: `${input.role}-credential`,
					};
				},
				async revokeSession() {},
				async close() {},
			},
			proposalGit: {
				async createWorktree() {
					return { directory: "/pinned-active-worktree" };
				},
				async collectDiff() {
					return candidateDiff;
				},
				async removeWorktree() {},
			},
			createProposer() {
				return {
					async run() {
						return {
							version: 1,
							hypothesis: "Path guidance enables recovery.",
							targetFailureSignature: "held-in-1:read",
							affectedEditableSurface: ["packages/selfpi-recovery-policy/src/index.ts"],
							unifiedDiff: candidateDiff,
							expectedBehavioralMechanism: "The model receives a usable sibling path.",
							predictedBenefit: "Held-in completion improves.",
							regressionRisks: ["A suggestion may be irrelevant."],
						};
					},
				};
			},
			checks: {
				async run() {
					return { appliesCleanly: true, formatting: true, typeChecking: true, targetedTestsPassed: true };
				},
			},
			createReviewer() {
				return {
					async review() {
						return {
							decision: "approve_for_evaluation",
							hypothesisAlignment: "aligned",
							risks: [],
							violations: [],
						};
					},
				};
			},
			async buildEvidence(input) {
				expect(JSON.stringify(input.proposerView)).not.toContain("held-out-1");
				return {
					digest: "sha256:supervised-evidence",
					bundle: {
						version: 1,
						heldInFailures: [],
						redactedRepresentativeTraces: [],
						heldInVerifierOutcomes: [],
						preservedSuccesses: [],
						editableSource: [],
						rejectedHypotheses: [],
						proposalSchema: { version: 1, requiredFields: [] },
						editableSurface: input.experiment.editableSurface,
						changeBudget: {
							expectedMaximumChangedLines: 100,
							justificationRequiredAbove: 100,
							humanApprovalAbove: 250,
						},
					},
				};
			},
			smoke: {
				async run() {
					return { buildPassed: true, smokePassed: true };
				},
			},
			evaluator: {
				async run(input) {
					expect(input.taskRegistry.digest).toBe(registryDigest);
					return {
						comparison: {
							baseline: first.baseline,
							candidate: first.candidate,
							baselineCompletions: 0,
							candidateCompletions: 1,
							completionGain: 1,
						},
						outcomes: {
							baselineRepetitions: 2,
							candidateRepetitions: 2,
							baselineHeldInCompletions: 0,
							candidateHeldInCompletions: 2,
							baselineHeldOutCompletions: 2,
							candidateHeldOutCompletions: 2,
							baselineRecoveryRate: 0,
							candidateRecoveryRate: 1,
						},
						efficiency: {
							baselineTokens: 40,
							candidateTokens: 40,
							baselineCostUsd: 0.01,
							candidateCostUsd: 0.01,
						},
						integrityViolation: false,
						attempts,
					};
				},
			},
			candidateSource: {
				async materialize(input) {
					return {
						directory: "/candidate",
						sourceCommit: candidateCommit,
						candidateReference: input.candidateReference,
					};
				},
				async release() {},
			},
			candidateImage: {
				async build(input) {
					return { imageDigest: candidateImageDigest, labels: input.labels };
				},
			},
		};
		let terminal = "";
		const exitCode = await runSelfPiCli(["improve", "path-recovery-v0"], {
			rootDirectory,
			repositoryDirectory: rootDirectory,
			write: (text) => {
				terminal += text;
			},
			now: () => new Date("2026-09-17T23:00:00.000Z"),
			createRunId: () => "run-supervised-001",
			referenceAdapter: { read: async () => activeCommit, advance: async () => undefined },
			supervisedAdapters: adapters,
		});

		expect(exitCode).toBe(0);
		expect(terminal).toContain("Run run-supervised-001: promotion_recommended (supervised real evidence)");
		const runDirectory = path.join(rootDirectory, "runs/run-supervised-001");
		expect(JSON.parse(await readFile(path.join(runDirectory, "manifest.json"), "utf8"))).toMatchObject({
			state: "promotion_recommended",
			evidenceClass: "supervised_real",
		});
		expect(JSON.parse(await readFile(path.join(runDirectory, "candidate-version.json"), "utf8"))).toMatchObject({
			runId: "run-supervised-001",
			sourceCommit: candidateCommit,
			predecessorCommit: activeCommit,
			imageDigest: candidateImageDigest,
		});
		expect(
			JSON.parse(await readFile(path.join(runDirectory, "evaluation-attempts.json"), "utf8")).attempts,
		).toHaveLength(4);
		terminal = "";
		expect(
			await runSelfPiCli(["inspect", "run-supervised-001"], {
				rootDirectory,
				write: (text) => {
					terminal += text;
				},
			}),
		).toBe(0);
		expect(terminal).toContain("Gateway: gateway-v1");
		expect(terminal).toContain("Proposer model: proposer-model");
		expect(terminal).toContain("Reviewer model: reviewer-model");
		expect(terminal).toContain(`Task registry: ${registryDigest}`);
		expect(terminal).toContain(`Candidate version: ${candidateCommit} (${candidateImageDigest})`);
	});
});

function attempt(
	taskId: string,
	set: "held_in" | "held_out",
	repetition: number,
	baselineComplete: boolean,
	candidateComplete: boolean,
	registryDigest: string,
) {
	const fingerprintInputs = {
		version: 1 as const,
		harness: { baselineCommit: activeCommit, candidateParentCommit: activeCommit },
		model: { provider: "fake-provider", id: "proposer-model", parameters: { temperature: 0 } },
		systemInputsDigest: "sha256:system",
		task: {
			setVersion: registryDigest,
			repositoryCommits: { "held-in-1": repositoryCommit, "held-out-1": repositoryCommit },
		},
		dependencies: { lockfileDigest: "sha256:lock" },
		evaluator: { version: "evaluator-v1" },
		verifier: { version: "verifier-v1" },
		container: { imageDigest: containerDigest, networkPolicyDigest: "sha256:network", cpuLimit: 1, memoryMb: 512 },
		budget: { timeoutMs: 60_000, toolCalls: 20, turns: 10, tokens: 50_000, costUsd: 2 },
		repetitions: 2,
	};
	const evaluated = (verifiedCompletion: boolean): EvaluatedHarnessAttempt => ({
		fingerprintInputs,
		result: {
			transcript: [],
			usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
			termination: { reason: "completed", exitCode: 0, signal: null },
			verifier: { taskId, verifiedCompletion, reason: verifiedCompletion ? "verified" : "artifact_missing" },
			processOutput: { stdout: "", stderr: "" },
		},
	});
	return {
		taskId,
		set,
		repetition,
		baseline: evaluated(baselineComplete),
		candidate: evaluated(candidateComplete),
		baselineRecovered: baselineComplete,
		candidateRecovered: candidateComplete,
		baselineCostUsd: 0.005,
		candidateCostUsd: 0.005,
	};
}
