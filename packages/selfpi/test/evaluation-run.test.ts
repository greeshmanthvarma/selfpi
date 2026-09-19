import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { pathRecovery01Task } from "../src/evaluation/tasks/path-recovery-01.ts";
import { compareHarnessAttempts, createRunRecordStore, runHarnessAttempt } from "../src/index.ts";

describe("evaluation run", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("persists a failing baseline and passing candidate as evidence", async () => {
		const testDirectory = path.dirname(fileURLToPath(import.meta.url));
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-evaluation-run-"));
		temporaryDirectories.push(rootDirectory);
		const baselineWorkspace = path.join(rootDirectory, "baseline-workspace");
		const candidateWorkspace = path.join(rootDirectory, "candidate-workspace");
		const repositoryFixture = path.join(testDirectory, "fixtures/evaluation/path-recovery-01/repository");
		await Promise.all([
			cp(repositoryFixture, baselineWorkspace, { recursive: true }),
			cp(repositoryFixture, candidateWorkspace, { recursive: true }),
		]);
		const store = createRunRecordStore({
			rootDirectory,
			now: () => new Date("2026-09-16T20:00:00.000Z"),
		});
		await store.create({ runId: "run-001", experimentId: "path-recovery-v0" });
		const [baselineResult, candidateResult] = await Promise.all([
			runHarnessAttempt({
				command: process.execPath,
				args: [path.join(testDirectory, "fixtures/harness/failing-harness.mjs")],
				workspaceDirectory: baselineWorkspace,
				task: pathRecovery01Task,
				timeoutMs: 5_000,
				environment: {},
			}),
			runHarnessAttempt({
				command: process.execPath,
				args: [path.join(testDirectory, "fixtures/harness/fake-harness.mjs"), candidateWorkspace],
				workspaceDirectory: candidateWorkspace,
				task: pathRecovery01Task,
				timeoutMs: 5_000,
				environment: {},
			}),
		]);
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
		const comparison = compareHarnessAttempts({
			baseline: { fingerprintInputs, result: baselineResult },
			candidate: { fingerprintInputs, result: candidateResult },
		});

		await store.recordEvaluation("run-001", comparison);
		await store.transition("run-001", "evidence_ready");

		const runDirectory = path.join(rootDirectory, "runs", "run-001");
		const [record, baseline, candidate, persistedComparison] = await Promise.all([
			store.open("run-001"),
			readFile(path.join(runDirectory, "baseline-results.json"), "utf8").then((source) => JSON.parse(source)),
			readFile(path.join(runDirectory, "candidate-results.json"), "utf8").then((source) => JSON.parse(source)),
			readFile(path.join(runDirectory, "comparison.json"), "utf8").then((source) => JSON.parse(source)),
		]);

		expect({
			state: record.manifest.state,
			baselineVerified: baseline.result.verifier.verifiedCompletion,
			candidateVerified: candidate.result.verifier.verifiedCompletion,
			comparison: persistedComparison,
		}).toEqual({
			state: "evidence_ready",
			baselineVerified: false,
			candidateVerified: true,
			comparison: {
				version: 1,
				fingerprint: expect.stringMatching(/^selfpi-evaluation-v1:sha256:[0-9a-f]{64}$/),
				baselineCompletions: 0,
				candidateCompletions: 1,
				completionGain: 1,
			},
		});
	});
});
