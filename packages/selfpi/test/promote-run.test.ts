import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSelfPiCli } from "../src/index.ts";

describe("selfpi promote", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("refuses a non-recommended run and activates the immutable version of an eligible run", async () => {
		const rootDirectory = await mkdtemp(join(tmpdir(), "selfpi-promote-"));
		temporaryDirectories.push(rootDirectory);
		const promotionDirectory = join(rootDirectory, "promotion");
		const rejectedDirectory = join(rootDirectory, "runs/run-rejected");
		const eligibleDirectory = join(rootDirectory, "runs/run-eligible");
		await Promise.all([
			mkdir(promotionDirectory, { recursive: true }),
			mkdir(rejectedDirectory, { recursive: true }),
			mkdir(eligibleDirectory, { recursive: true }),
		]);
		const baselineCommit = "1".repeat(40);
		const candidateCommit = "2".repeat(40);
		const baselineDigest = `sha256:${"a".repeat(64)}`;
		const candidateDigest = `sha256:${"b".repeat(64)}`;
		await Promise.all([
			writeFile(
				join(promotionDirectory, "active.json"),
				`${JSON.stringify({
					version: 1,
					reference: "refs/selfpi/active",
					current: { sourceCommit: baselineCommit, imageDigest: baselineDigest },
				})}\n`,
				"utf8",
			),
			writeFile(
				join(rejectedDirectory, "manifest.json"),
				`${JSON.stringify({
					version: 1,
					runId: "run-rejected",
					experimentId: "path-recovery-v0",
					state: "rejected",
					createdAt: "2026-09-17T20:00:00.000Z",
					updatedAt: "2026-09-17T20:01:00.000Z",
				})}\n`,
				"utf8",
			),
			writeFile(
				join(rejectedDirectory, "events.jsonl"),
				`${JSON.stringify({
					version: 1,
					sequence: 1,
					at: "2026-09-17T20:00:00.000Z",
					type: "run_created",
					state: "created",
				})}\n`,
				"utf8",
			),
			writeFile(
				join(eligibleDirectory, "manifest.json"),
				`${JSON.stringify({
					version: 1,
					runId: "run-eligible",
					experimentId: "path-recovery-v0",
					state: "promotion_recommended",
					createdAt: "2026-09-17T20:00:00.000Z",
					updatedAt: "2026-09-17T20:01:00.000Z",
				})}\n`,
				"utf8",
			),
			writeFile(
				join(eligibleDirectory, "events.jsonl"),
				`${[
					{
						version: 1,
						sequence: 1,
						at: "2026-09-17T20:00:00.000Z",
						type: "run_created",
						state: "created",
					},
					{
						version: 1,
						sequence: 2,
						at: "2026-09-17T20:01:00.000Z",
						type: "state_transitioned",
						from: "evaluation_complete",
						state: "promotion_recommended",
					},
				]
					.map((event) => JSON.stringify(event))
					.join("\n")}\n`,
				"utf8",
			),
			writeFile(
				join(eligibleDirectory, "candidate-version.json"),
				`${JSON.stringify({ version: 1, sourceCommit: candidateCommit, imageDigest: candidateDigest })}\n`,
				"utf8",
			),
		]);
		const advances: unknown[] = [];
		let terminal = "";
		const options = {
			rootDirectory,
			write: (text: string) => {
				terminal += text;
			},
			now: () => new Date("2026-09-17T21:00:00.000Z"),
			referenceAdapter: {
				read: async () => baselineCommit,
				advance: async (input: unknown) => {
					advances.push(input);
				},
			},
		};

		expect(await runSelfPiCli(["promote", "run-rejected"], options)).toBe(1);
		expect(await runSelfPiCli(["promote", "run-eligible"], options)).toBe(0);

		expect(terminal).toContain("run-rejected is not eligible for promotion");
		expect(advances).toEqual([
			{
				reference: "refs/selfpi/active",
				expectedCommit: baselineCommit,
				nextCommit: candidateCommit,
			},
		]);
		expect(JSON.parse(await readFile(join(promotionDirectory, "active.json"), "utf8"))).toEqual({
			version: 1,
			reference: "refs/selfpi/active",
			current: { sourceCommit: candidateCommit, imageDigest: candidateDigest },
			predecessor: { sourceCommit: baselineCommit, imageDigest: baselineDigest },
			activatedByRunId: "run-eligible",
			activatedAt: "2026-09-17T21:00:00.000Z",
		});
		const lineage = (await readFile(join(promotionDirectory, "lineage.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lineage).toEqual([
			{
				version: 1,
				type: "promoted",
				runId: "run-eligible",
				at: "2026-09-17T21:00:00.000Z",
				reference: "refs/selfpi/active",
				activeCommit: candidateCommit,
				predecessorCommit: baselineCommit,
				imageDigest: candidateDigest,
				predecessorImageDigest: baselineDigest,
			},
		]);
	});
});
