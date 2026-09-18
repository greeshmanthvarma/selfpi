import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRejectedHypothesesFromRuns } from "../src/index.ts";

describe("loadRejectedHypothesesFromRuns", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("loads unique rejected hypotheses for the matching experiment", async () => {
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-rejected-"));
		temporaryDirectories.push(rootDirectory);
		const runs = path.join(rootDirectory, "runs");
		await mkdir(path.join(runs, "run-a"), { recursive: true });
		await mkdir(path.join(runs, "run-b"), { recursive: true });
		await mkdir(path.join(runs, "run-c"), { recursive: true });

		await writeFile(
			path.join(runs, "run-a", "manifest.json"),
			`${JSON.stringify({ version: 1, runId: "run-a", experimentId: "path-recovery-smoke-v0", state: "rejected" })}\n`,
			"utf8",
		);
		await writeFile(
			path.join(runs, "run-a", "candidate-proposal.json"),
			`${JSON.stringify({ version: 1, hypothesis: "return empty content" })}\n`,
			"utf8",
		);
		await writeFile(
			path.join(runs, "run-a", "decision.json"),
			`${JSON.stringify({
				version: 1,
				decision: "rejected",
				reasons: [
					{ code: "held_in_completion_gain", passed: false },
					{ code: "recovery_rate_improvement", passed: false },
				],
			})}\n`,
			"utf8",
		);

		await writeFile(
			path.join(runs, "run-b", "manifest.json"),
			`${JSON.stringify({ version: 1, runId: "run-b", experimentId: "path-recovery-smoke-v0", state: "rejected" })}\n`,
			"utf8",
		);
		await writeFile(
			path.join(runs, "run-b", "candidate-proposal.json"),
			`${JSON.stringify({ version: 1, hypothesis: "return empty content" })}\n`,
			"utf8",
		);

		await writeFile(
			path.join(runs, "run-c", "manifest.json"),
			`${JSON.stringify({ version: 1, runId: "run-c", experimentId: "other-experiment", state: "rejected" })}\n`,
			"utf8",
		);
		await writeFile(
			path.join(runs, "run-c", "candidate-proposal.json"),
			`${JSON.stringify({ version: 1, hypothesis: "other idea" })}\n`,
			"utf8",
		);

		await expect(loadRejectedHypothesesFromRuns(rootDirectory, "path-recovery-smoke-v0")).resolves.toEqual([
			{
				hypothesis: "return empty content",
				reason: "held_in_completion_gain,recovery_rate_improvement",
			},
		]);
	});
});
