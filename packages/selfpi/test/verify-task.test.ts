import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { verifyEvaluationTask } from "../src/index.ts";

describe("evaluation task verifier", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("reports verified completion only after the exact requested artifact change", async () => {
		const workspaceDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-verifier-"));
		temporaryDirectories.push(workspaceDirectory);
		const fixtureDirectory = path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			"fixtures/evaluation/path-recovery-01/repository",
		);
		await cp(fixtureDirectory, workspaceDirectory, { recursive: true });
		const task = {
			id: "path-recovery-01",
			verifier: {
				type: "exact_file" as const,
				path: "answer.txt",
				expectedContent: "Configuration file: src/settings.ts\n",
			},
		};

		const beforeChange = await verifyEvaluationTask(task, workspaceDirectory);
		await writeFile(path.join(workspaceDirectory, "answer.txt"), "Configuration file: src/settings.ts\n", "utf8");
		const afterChange = await verifyEvaluationTask(task, workspaceDirectory);

		expect([beforeChange, afterChange]).toEqual([
			{
				taskId: "path-recovery-01",
				verifiedCompletion: false,
				reason: "artifact_missing",
			},
			{
				taskId: "path-recovery-01",
				verifiedCompletion: true,
				reason: "verified",
			},
		]);
	});
});
