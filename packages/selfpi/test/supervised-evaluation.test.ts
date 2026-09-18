import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ProtectedTaskRegistry, SupervisedRuntime } from "../src/config/load-supervised-runtime.ts";
import type { EvaluationFingerprintInputs } from "../src/evaluation/baseline-cache.ts";
import type { DockerHarnessAttemptInput, DockerHarnessRunner } from "../src/evaluation/docker-harness-runner.ts";
import type { EvaluationTask } from "../src/evaluation/verify-task.ts";
import type { Experiment } from "../src/experiments/load-experiment.ts";
import type { ModelGateway, ModelGatewayRole } from "../src/gateway/model-gateway.ts";
import { runSupervisedEvaluation } from "../src/supervised/run-supervised-evaluation.ts";

const executeFile = promisify(execFile);

async function createMockRepository(rootDirectory: string, name: string): Promise<{ path: string; commit: string }> {
	const repositoryDirectory = path.join(rootDirectory, name);
	await mkdir(path.join(repositoryDirectory, "src"), { recursive: true });
	await writeFile(path.join(repositoryDirectory, "src/settings.ts"), `export const fixture = "${name}";\n`, "utf8");
	await executeFile("git", ["init", "--quiet"], { cwd: repositoryDirectory });
	await executeFile("git", ["add", "src/settings.ts"], { cwd: repositoryDirectory });
	await executeFile(
		"git",
		[
			"-c",
			"user.name=SelfPi Fixture",
			"-c",
			"user.email=selfpi-fixture@example.invalid",
			"commit",
			"--quiet",
			"-m",
			"fixture",
		],
		{ cwd: repositoryDirectory },
	);
	const commit = (await executeFile("git", ["rev-parse", "HEAD"], { cwd: repositoryDirectory })).stdout.trim();
	return { path: repositoryDirectory, commit };
}

describe("supervised evaluation", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("runs every registered task and repetition as comparable gateway-only container attempts", async () => {
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-supervised-evaluation-"));
		temporaryDirectories.push(rootDirectory);
		const heldInRepository = await createMockRepository(rootDirectory, "held-in-source");
		const heldOutRepository = await createMockRepository(rootDirectory, "held-out-source");
		const baselineHarnessDirectory = path.join(rootDirectory, "baseline-harness");
		const candidateHarnessDirectory = path.join(rootDirectory, "candidate-harness");
		await Promise.all([mkdir(baselineHarnessDirectory), mkdir(candidateHarnessDirectory)]);
		const activeCommit = "a".repeat(40);
		const verifierDigest = `sha256:${"b".repeat(64)}`;
		const registry: ProtectedTaskRegistry = {
			version: 1,
			id: "path-recovery-registry-v1",
			digest: `sha256:${"c".repeat(64)}`,
			heldIn: [
				{
					id: "held-in-01",
					set: "held_in",
					repository: { url: heldInRepository.path, commit: heldInRepository.commit },
					input: "Recover after the configured read fails.",
					verifier: { id: "held-in-verifier", digest: verifierDigest },
					perturbation: { version: 1, path: "src/config.ts", error: "ENOENT src/config.ts" },
				},
			],
			heldOut: [
				{
					id: "held-out-01",
					set: "held_out",
					repository: { url: heldOutRepository.path, commit: heldOutRepository.commit },
					input: "Complete the naturalistic configuration task.",
					verifier: { id: "held-out-verifier", digest: verifierDigest },
				},
			],
		};
		const experiment: Experiment = {
			version: 1,
			id: "path-recovery-v0",
			heldIn: ["held-in-01"],
			heldOut: ["held-out-01"],
			budget: { wallClockMs: 30_000, toolCalls: 20, turns: 10, tokens: 1_000, costUsd: 1 },
			editableSurface: ["packages/selfpi-recovery-policy/src/**"],
			protectedSurface: ["packages/selfpi/**", ".selfpi/**"],
			promotionPolicy: {
				minimumHeldInCompletionGain: 2,
				maximumHeldOutCompletionLoss: 0,
				requireRecoveryRateImprovement: true,
			},
		};
		const runtime: SupervisedRuntime = {
			version: 1,
			mode: "supervised_v0",
			activeVersion: { sourceCommit: activeCommit, imageDigest: `sha256:${"d".repeat(64)}` },
			proposer: { provider: "openai", model: "fixed-model", thinking: "low" },
			reviewer: { provider: "openai", model: "reviewer-model" },
			gateway: { identity: "gateway-v1", endpoint: "http://gateway.internal/v1" },
			container: { imageDigest: `sha256:${"e".repeat(64)}` },
			evaluation: { repetitions: 2 },
			taskRegistry: { id: registry.id, digest: registry.digest },
		};
		const fingerprintInputs: EvaluationFingerprintInputs = {
			version: 1,
			harness: { baselineCommit: activeCommit, candidateParentCommit: activeCommit },
			model: { provider: "openai", id: "fixed-model", parameters: { temperature: 0 } },
			systemInputsDigest: "sha256:system",
			task: {
				setVersion: registry.digest,
				repositoryCommits: {
					"held-in-01": heldInRepository.commit,
					"held-out-01": heldOutRepository.commit,
				},
			},
			dependencies: { lockfileDigest: "sha256:lock" },
			evaluator: { version: "supervised-evaluator-v1" },
			verifier: { version: "protected-verifier-v1" },
			container: {
				imageDigest: runtime.container.imageDigest,
				networkPolicyDigest: "sha256:gateway-only",
				cpuLimit: 1,
				memoryMb: 512,
			},
			budget: {
				timeoutMs: experiment.budget.wallClockMs,
				toolCalls: experiment.budget.toolCalls,
				turns: experiment.budget.turns,
				tokens: experiment.budget.tokens,
				costUsd: experiment.budget.costUsd,
			},
			repetitions: runtime.evaluation.repetitions,
		};
		const evaluationTasks: Readonly<Record<string, { readonly digest: string; readonly task: EvaluationTask }>> = {
			"held-in-verifier": {
				digest: verifierDigest,
				task: {
					id: "held-in-01",
					verifier: { type: "exact_file", path: "answer.txt", expectedContent: "held-in complete\n" },
				},
			},
			"held-out-verifier": {
				digest: verifierDigest,
				task: {
					id: "held-out-01",
					verifier: { type: "exact_file", path: "answer.txt", expectedContent: "held-out complete\n" },
				},
			},
		};
		const issuedRoles: ModelGatewayRole[] = [];
		const revokedSessions: string[] = [];
		const gateway: ModelGateway = {
			async issueSession(input) {
				issuedRoles.push(input.role);
				return {
					id: `${input.runId}-${issuedRoles.length}`,
					endpoint: "http://gateway.internal/v1",
					credential: `credential-${issuedRoles.length}`,
				};
			},
			async revokeSession(sessionId) {
				revokedSessions.push(sessionId);
			},
			async close() {},
		};
		const attempts: DockerHarnessAttemptInput[] = [];
		const runner: DockerHarnessRunner = {
			async run(input) {
				attempts.push(input);
				const variant = input.environment.SELFPI_VARIANT;
				const verifiedCompletion = input.task.id === "held-out-01" || variant === "candidate";
				return {
					transcript: [],
					usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
					termination: { reason: "completed", exitCode: 0, signal: null },
					verifier: {
						taskId: input.task.id,
						verifiedCompletion,
						reason: verifiedCompletion ? "verified" : "artifact_missing",
					},
					processOutput: { stdout: "", stderr: "" },
					perturbation:
						input.task.id === "held-in-01"
							? {
									version: 1,
									fired: true,
									toolCallSequence: 1,
									toolCallId: "read-1",
									path: "src/config.ts",
									error: "ENOENT src/config.ts",
									subsequentMatchingReadSuccesses: verifiedCompletion ? 1 : 0,
									repeatedIdenticalFailures: 0,
								}
							: { version: 1, fired: false },
				};
			},
		};

		const result = await runSupervisedEvaluation(
			{
				rootDirectory,
				runId: "run-28",
				experiment,
				runtime,
				taskRegistry: registry,
				evaluationTasks,
				fingerprintInputs,
				containerImage: `selfpi-evaluator@${runtime.container.imageDigest}`,
				baselineHarness: {
					sourceDirectory: baselineHarnessDirectory,
					command: "node",
					args: ["/inputs/harness/run.mjs"],
				},
				candidateHarness: {
					sourceDirectory: candidateHarnessDirectory,
					command: "node",
					args: ["/inputs/harness/run.mjs"],
				},
				gatewayNetwork: { name: "selfpi-run-28", digest: "sha256:gateway-only" },
				resources: { cpuLimit: 1, memoryMb: 512 },
				sessionExpiresAt: new Date("2026-09-17T20:30:00.000Z"),
			},
			{ gateway, runner },
		);

		expect(result.attempts).toHaveLength(4);
		expect(result.outcomes).toEqual({
			baselineRepetitions: 2,
			candidateRepetitions: 2,
			baselineHeldInCompletions: 0,
			candidateHeldInCompletions: 2,
			baselineHeldOutCompletions: 2,
			candidateHeldOutCompletions: 2,
			baselineRecoveryRate: 0,
			candidateRecoveryRate: 1,
		});
		expect(attempts).toHaveLength(8);
		expect(attempts.every((attempt) => attempt.networkPolicy.mode === "gateway_only")).toBe(true);
		expect(attempts.every((attempt) => attempt.immutableInputs[0]?.target === "/inputs/harness")).toBe(true);
		expect(new Set(attempts.map((attempt) => attempt.workspaceDirectory)).size).toBe(8);
		expect(issuedRoles).toEqual(Array.from({ length: 8 }, () => "evaluation"));
		expect(revokedSessions).toHaveLength(8);
		if (result.attempts === undefined) throw new Error("Expected supervised evaluation attempts.");
		expect(result.attempts.every((attempt) => attempt.baseline.fingerprintInputs === fingerprintInputs)).toBe(true);
		expect(result.attempts.every((attempt) => attempt.candidate.fingerprintInputs === fingerprintInputs)).toBe(true);
	});
});
