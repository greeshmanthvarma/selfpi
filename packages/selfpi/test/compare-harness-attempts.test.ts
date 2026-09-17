import { describe, expect, it } from "vitest";
import { compareHarnessAttempts } from "../src/index.ts";

describe("behavioral evaluation", () => {
	it("reports a candidate completion gain under identical controlled inputs", () => {
		const fingerprintInputs = {
			version: 1 as const,
			harness: { baselineCommit: "baseline-commit", candidateParentCommit: "baseline-commit" },
			model: { provider: "fake", id: "deterministic-v1", parameters: { temperature: 0 } },
			systemInputsDigest: "sha256:system-a",
			task: { setVersion: "path-recovery-v0", repositoryCommits: { "path-recovery-01": "fixture-commit" } },
			dependencies: { lockfileDigest: "sha256:lock-a" },
			evaluator: { version: "evaluator-v1" },
			verifier: { version: "verifier-v1" },
			container: {
				imageDigest: "sha256:container-a",
				networkPolicyDigest: "sha256:network-a",
				cpuLimit: 1,
				memoryMb: 512,
			},
			budget: { timeoutMs: 5_000, toolCalls: 20, turns: 10, tokens: 50_000, costUsd: 2 },
			repetitions: 1,
		};
		const baseline = {
			fingerprintInputs,
			result: {
				transcript: [
					{
						type: "tool_result" as const,
						toolName: "read",
						isError: true,
						content: "src/config.ts does not exist",
					},
				],
				usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
				termination: { reason: "completed" as const, exitCode: 0, signal: null },
				verifier: {
					taskId: "path-recovery-01",
					verifiedCompletion: false,
					reason: "artifact_missing" as const,
				},
				processOutput: { stdout: "baseline", stderr: "" },
			},
		};
		const candidate = {
			fingerprintInputs,
			result: {
				transcript: [
					{
						type: "tool_result" as const,
						toolName: "read",
						isError: true,
						content: "src/config.ts does not exist",
					},
					{ type: "assistant" as const, content: "I found src/settings.ts." },
				],
				usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
				termination: { reason: "completed" as const, exitCode: 0, signal: null },
				verifier: {
					taskId: "path-recovery-01",
					verifiedCompletion: true,
					reason: "verified" as const,
				},
				processOutput: { stdout: "candidate", stderr: "" },
			},
		};

		const comparison = compareHarnessAttempts({ baseline, candidate });

		expect(comparison).toEqual({
			baseline,
			candidate,
			baselineCompletions: 0,
			candidateCompletions: 1,
			completionGain: 1,
		});
	});

	it("refuses attempts with different verifier versions", () => {
		const sharedInputs = {
			version: 1 as const,
			harness: { baselineCommit: "baseline-commit", candidateParentCommit: "baseline-commit" },
			model: { provider: "fake", id: "deterministic-v1", parameters: { temperature: 0 } },
			systemInputsDigest: "sha256:system-a",
			task: { setVersion: "path-recovery-v0", repositoryCommits: { "path-recovery-01": "fixture-commit" } },
			dependencies: { lockfileDigest: "sha256:lock-a" },
			evaluator: { version: "evaluator-v1" },
			verifier: { version: "verifier-v1" },
			container: {
				imageDigest: "sha256:container-a",
				networkPolicyDigest: "sha256:network-a",
				cpuLimit: 1,
				memoryMb: 512,
			},
			budget: { timeoutMs: 5_000, toolCalls: 20, turns: 10, tokens: 50_000, costUsd: 2 },
			repetitions: 1,
		};
		const result = {
			transcript: [],
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			termination: { reason: "completed" as const, exitCode: 0, signal: null },
			verifier: {
				taskId: "path-recovery-01",
				verifiedCompletion: true,
				reason: "verified" as const,
			},
			processOutput: { stdout: "", stderr: "" },
		};
		const candidateInputs = { ...sharedInputs, verifier: { version: "verifier-v2" } };

		expect(() =>
			compareHarnessAttempts({
				baseline: { fingerprintInputs: sharedInputs, result },
				candidate: { fingerprintInputs: candidateInputs, result },
			}),
		).toThrow("Cannot compare harness attempts with different controlled inputs.");
	});
});
