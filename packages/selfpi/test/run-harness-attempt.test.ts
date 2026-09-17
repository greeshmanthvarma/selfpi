import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { pathRecovery01Task } from "../src/evaluation/tasks/path-recovery-01.ts";
import { runHarnessAttempt } from "../src/index.ts";

describe("harness runner", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("returns one normalized attempt from a deterministic local harness", async () => {
		const testDirectory = path.dirname(fileURLToPath(import.meta.url));
		const workspaceDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-harness-"));
		temporaryDirectories.push(workspaceDirectory);
		await cp(path.join(testDirectory, "fixtures/evaluation/path-recovery-01/repository"), workspaceDirectory, {
			recursive: true,
		});

		const result = await runHarnessAttempt({
			command: process.execPath,
			args: [path.join(testDirectory, "fixtures/harness/fake-harness.mjs"), workspaceDirectory],
			workspaceDirectory,
			task: pathRecovery01Task,
			timeoutMs: 5_000,
			environment: {},
		});

		expect(result).toEqual({
			transcript: [
				{ type: "assistant", content: "I will inspect the repository settings." },
				{
					type: "tool_result",
					toolName: "read",
					isError: true,
					content: "src/config.ts does not exist",
				},
				{ type: "assistant", content: "The configuration is in src/settings.ts." },
			],
			usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
			termination: { reason: "completed", exitCode: 0, signal: null },
			verifier: {
				taskId: "path-recovery-01",
				verifiedCompletion: true,
				reason: "verified",
			},
			processOutput: {
				stdout: expect.any(String),
				stderr: "fake harness completed\n",
			},
		});
	});

	it("returns a timed-out result when the harness produces no output", async () => {
		const testDirectory = path.dirname(fileURLToPath(import.meta.url));
		const workspaceDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-harness-timeout-"));
		temporaryDirectories.push(workspaceDirectory);
		await cp(path.join(testDirectory, "fixtures/evaluation/path-recovery-01/repository"), workspaceDirectory, {
			recursive: true,
		});

		const result = await runHarnessAttempt({
			command: process.execPath,
			args: [path.join(testDirectory, "fixtures/harness/hanging-harness.mjs")],
			workspaceDirectory,
			task: pathRecovery01Task,
			timeoutMs: 25,
			environment: {},
		});

		expect(result).toEqual({
			transcript: [],
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			termination: { reason: "timed_out", exitCode: null, signal: "SIGKILL" },
			verifier: {
				taskId: "path-recovery-01",
				verifiedCompletion: false,
				reason: "artifact_missing",
			},
			processOutput: { stdout: "", stderr: "" },
		});
	});
});
