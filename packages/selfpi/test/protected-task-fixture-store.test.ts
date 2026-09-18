import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { RegisteredTask } from "../src/config/load-supervised-runtime.ts";
import { materializeProtectedTaskFixture } from "../src/evaluation/protected-task-fixture-store.ts";

const executeFile = promisify(execFile);

describe("protected task fixture store", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("materializes the exact mock-repository commit beneath the supervisor-owned root", async () => {
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-task-fixture-store-"));
		temporaryDirectories.push(rootDirectory);
		const sourceDirectory = path.join(rootDirectory, "mock-source");
		const protectedRoot = path.join(rootDirectory, "protected-fixtures");
		await mkdir(path.join(sourceDirectory, "src"), { recursive: true });
		await Promise.all([
			writeFile(path.join(sourceDirectory, "README.md"), "Find the project configuration.\n", "utf8"),
			writeFile(path.join(sourceDirectory, "src/settings.ts"), "export const mode = 'fixture';\n", "utf8"),
		]);
		await executeFile("git", ["init", "--quiet"], { cwd: sourceDirectory });
		await executeFile("git", ["add", "README.md", "src/settings.ts"], { cwd: sourceDirectory });
		await executeFile(
			"git",
			[
				"-c",
				"user.name=SelfPi Fixture",
				"-c",
				"user.email=selfpi-fixture@example.invalid",
				"commit",
				"--quiet",
				"-m",
				"fixture",
			],
			{ cwd: sourceDirectory },
		);
		const commit = (await executeFile("git", ["rev-parse", "HEAD"], { cwd: sourceDirectory })).stdout.trim();
		const task: RegisteredTask = {
			id: "held-in-01",
			set: "held_in",
			repository: { url: sourceDirectory, commit },
			input: "Locate the configuration file.",
			verifier: { id: "exact-file-v1", digest: `sha256:${"a".repeat(64)}` },
		};

		const first = await materializeProtectedTaskFixture({
			protectedRoot,
			registryId: "path-recovery-v1",
			task,
		});
		const second = await materializeProtectedTaskFixture({
			protectedRoot,
			registryId: "path-recovery-v1",
			task,
		});

		expect(first).toEqual({
			registryId: "path-recovery-v1",
			taskId: "held-in-01",
			repositoryDirectory: path.join(protectedRoot, "path-recovery-v1", "held-in-01", "repository"),
			commit,
		});
		expect(second).toEqual(first);
		expect(await readFile(path.join(first.repositoryDirectory, "src/settings.ts"), "utf8")).toBe(
			"export const mode = 'fixture';\n",
		);
		expect((await executeFile("git", ["rev-parse", "HEAD"], { cwd: first.repositoryDirectory })).stdout.trim()).toBe(
			commit,
		);
		await expect(
			executeFile("git", ["remote", "get-url", "origin"], { cwd: first.repositoryDirectory }),
		).rejects.toThrow();
	});
});
