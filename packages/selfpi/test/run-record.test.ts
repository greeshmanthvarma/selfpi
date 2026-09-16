import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunRecordStore } from "../src/index.ts";

describe("run record", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("reopens a run at its last completed state with its transition events", async () => {
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-run-record-"));
		temporaryDirectories.push(rootDirectory);
		const timestamps = ["2026-09-16T20:00:00.000Z", "2026-09-16T20:01:00.000Z"];
		const store = createRunRecordStore({
			rootDirectory,
			now: () => new Date(timestamps.shift() ?? "unexpected clock read"),
		});

		await store.create({ runId: "run-001", experimentId: "path-recovery-v0" });
		await store.transition("run-001", "evidence_ready");
		const reopened = await createRunRecordStore({
			rootDirectory,
			now: () => new Date("2026-09-16T21:00:00.000Z"),
		}).open("run-001");

		expect(reopened).toEqual({
			manifest: {
				version: 1,
				runId: "run-001",
				experimentId: "path-recovery-v0",
				state: "evidence_ready",
				createdAt: "2026-09-16T20:00:00.000Z",
				updatedAt: "2026-09-16T20:01:00.000Z",
			},
			events: [
				{
					version: 1,
					sequence: 1,
					at: "2026-09-16T20:00:00.000Z",
					type: "run_created",
					state: "created",
				},
				{
					version: 1,
					sequence: 2,
					at: "2026-09-16T20:01:00.000Z",
					type: "state_transitioned",
					from: "created",
					state: "evidence_ready",
				},
			],
		});
	});
});
