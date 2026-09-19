import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { pathRecovery01Task } from "../src/evaluation/tasks/path-recovery-01.ts";
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

		const beforeChange = await verifyEvaluationTask(pathRecovery01Task, workspaceDirectory);
		await writeFile(path.join(workspaceDirectory, "answer.txt"), "Configuration file: src/settings.ts\n", "utf8");
		const afterChange = await verifyEvaluationTask(pathRecovery01Task, workspaceDirectory);

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

	it("adapts Terminal-Bench tests/test.sh into SelfPi shell_reward grading", async () => {
		const workspaceDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-shell-reward-"));
		temporaryDirectories.push(workspaceDirectory);
		await mkdir(path.join(workspaceDirectory, "tests"), { recursive: true });
		await writeFile(
			path.join(workspaceDirectory, "tests/test.sh"),
			[
				"#!/bin/bash",
				"mkdir -p /logs/verifier",
				'if [[ -f "$PWD/DONE" ]]; then',
				"  echo 1 > /logs/verifier/reward.txt",
				"else",
				"  echo 0 > /logs/verifier/reward.txt",
				"fi",
				"",
			].join("\n"),
			"utf8",
		);
		await chmod(path.join(workspaceDirectory, "tests/test.sh"), 0o755);

		const task = {
			id: "terminal-bench/example",
			verifier: {
				type: "shell_reward" as const,
				testScript: "tests/test.sh",
				rewardDirectory: "logs/verifier",
				rewardFileName: "reward.txt",
			},
		};

		const before = await verifyEvaluationTask(task, workspaceDirectory);
		expect(before).toEqual({
			taskId: "terminal-bench/example",
			verifiedCompletion: false,
			reason: "artifact_mismatch",
		});

		await writeFile(path.join(workspaceDirectory, "DONE"), "ok\n", "utf8");
		const after = await verifyEvaluationTask(task, workspaceDirectory);
		expect(after).toEqual({
			taskId: "terminal-bench/example",
			verifiedCompletion: true,
			reason: "verified",
		});
	});
});
