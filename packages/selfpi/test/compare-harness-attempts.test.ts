import { describe, expect, it } from "vitest";
import { compareHarnessAttempts } from "../src/index.ts";

describe("behavioral evaluation", () => {
	it("reports a candidate completion gain under identical controlled inputs", () => {
		const controlledInputs = {
			experimentId: "path-recovery-v0",
			taskId: "path-recovery-01",
			model: { provider: "fake", id: "deterministic-v1" },
			limits: { timeoutMs: 5_000, toolCalls: 20, turns: 10 },
		};
		const baseline = {
			controlledInputs,
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
			controlledInputs,
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
});
