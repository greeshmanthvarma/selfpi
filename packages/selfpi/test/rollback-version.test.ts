import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSelfPiCli } from "../src/cli/run-selfpi-cli.ts";

describe("selfpi rollback", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("restores the recorded predecessor and refuses unrecorded or ambiguous versions before changing Git", async () => {
		const rootDirectory = await mkdtemp(join(tmpdir(), "selfpi-rollback-"));
		temporaryDirectories.push(rootDirectory);
		const promotionDirectory = join(rootDirectory, "promotion");
		const runDirectory = join(rootDirectory, "runs/run-promoted");
		await Promise.all([mkdir(promotionDirectory, { recursive: true }), mkdir(runDirectory, { recursive: true })]);
		const predecessorCommit = "1".repeat(40);
		const activeCommit = "2".repeat(40);
		const ambiguousCommit = "3".repeat(40);
		const predecessorDigest = `sha256:${"a".repeat(64)}`;
		const activeDigest = `sha256:${"b".repeat(64)}`;
		const ambiguousDigest = `sha256:${"c".repeat(64)}`;
		const promotedEvent = {
			version: 1,
			type: "promoted",
			runId: "run-promoted",
			at: "2026-09-17T21:00:00.000Z",
			reference: "refs/selfpi/active",
			activeCommit,
			predecessorCommit,
			imageDigest: activeDigest,
			predecessorImageDigest: predecessorDigest,
		};
		await Promise.all([
			writeFile(
				join(promotionDirectory, "active.json"),
				`${JSON.stringify({
					version: 1,
					reference: "refs/selfpi/active",
					current: { sourceCommit: activeCommit, imageDigest: activeDigest },
					predecessor: { sourceCommit: predecessorCommit, imageDigest: predecessorDigest },
					activatedByRunId: "run-promoted",
					activatedAt: promotedEvent.at,
				})}\n`,
				"utf8",
			),
			writeFile(
				join(promotionDirectory, "lineage.jsonl"),
				`${[
					promotedEvent,
					{ ...promotedEvent, runId: "ambiguous-a", activeCommit: ambiguousCommit, imageDigest: ambiguousDigest },
					{ ...promotedEvent, runId: "ambiguous-b", activeCommit: ambiguousCommit, imageDigest: ambiguousDigest },
				]
					.map((event) => JSON.stringify(event))
					.join("\n")}\n`,
				"utf8",
			),
			writeFile(
				join(runDirectory, "manifest.json"),
				`${JSON.stringify({
					version: 1,
					runId: "run-promoted",
					experimentId: "path-recovery-v0",
					state: "promoted",
					createdAt: "2026-09-17T20:00:00.000Z",
					updatedAt: "2026-09-17T21:00:00.000Z",
				})}\n`,
				"utf8",
			),
			writeFile(
				join(runDirectory, "events.jsonl"),
				`${JSON.stringify({
					version: 1,
					sequence: 1,
					at: "2026-09-17T20:00:00.000Z",
					type: "run_created",
					state: "created",
				})}\n${JSON.stringify({
					version: 1,
					sequence: 2,
					at: "2026-09-17T21:00:00.000Z",
					type: "state_transitioned",
					from: "promotion_recommended",
					state: "promoted",
				})}\n`,
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
			now: () => new Date("2026-09-17T22:00:00.000Z"),
			referenceAdapter: {
				read: async () => activeCommit,
				advance: async (input: unknown) => {
					advances.push(input);
				},
			},
		};

		expect(await runSelfPiCli(["rollback", "9".repeat(40)], options)).toBe(1);
		expect(await runSelfPiCli(["rollback", ambiguousCommit], options)).toBe(1);
		expect(advances).toEqual([]);
		expect(await runSelfPiCli(["rollback", activeCommit], options)).toBe(0);

		expect(terminal).toContain(`${"9".repeat(40)} is not a recorded harness version`);
		expect(terminal).toContain(`${ambiguousCommit} is an ambiguous harness version`);
		expect(advances).toEqual([
			{
				reference: "refs/selfpi/active",
				expectedCommit: activeCommit,
				nextCommit: predecessorCommit,
			},
		]);
		expect(JSON.parse(await readFile(join(promotionDirectory, "active.json"), "utf8"))).toEqual({
			version: 1,
			reference: "refs/selfpi/active",
			current: { sourceCommit: predecessorCommit, imageDigest: predecessorDigest },
			predecessor: { sourceCommit: activeCommit, imageDigest: activeDigest },
			activatedByRunId: "run-promoted",
			activatedAt: "2026-09-17T22:00:00.000Z",
		});
		const lineage = (await readFile(join(promotionDirectory, "lineage.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lineage).toEqual([
			promotedEvent,
			{ ...promotedEvent, runId: "ambiguous-a", activeCommit: ambiguousCommit, imageDigest: ambiguousDigest },
			{ ...promotedEvent, runId: "ambiguous-b", activeCommit: ambiguousCommit, imageDigest: ambiguousDigest },
			{
				version: 1,
				type: "rolled_back",
				runId: "run-promoted",
				at: "2026-09-17T22:00:00.000Z",
				reference: "refs/selfpi/active",
				rolledBackCommit: activeCommit,
				restoredCommit: predecessorCommit,
				rolledBackImageDigest: activeDigest,
				restoredImageDigest: predecessorDigest,
			},
		]);
		expect(JSON.parse(await readFile(join(runDirectory, "manifest.json"), "utf8"))).toMatchObject({
			state: "rolled_back",
			updatedAt: "2026-09-17T22:00:00.000Z",
		});
	});
});
