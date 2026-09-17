import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { pathRecovery01Task } from "../src/evaluation/tasks/path-recovery-01.ts";
import { createDockerHarnessRunner, runHarnessAttempt } from "../src/index.ts";

describe("container harness runner", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("returns the local normalized result while applying restricted Docker execution", async () => {
		const testDirectory = path.dirname(fileURLToPath(import.meta.url));
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-container-runner-"));
		temporaryDirectories.push(rootDirectory);
		const localWorkspace = path.join(rootDirectory, "local-workspace");
		const containerWorkspace = path.join(rootDirectory, "container-workspace");
		const immutableInput = path.join(rootDirectory, "immutable-harness");
		const repositoryFixture = path.join(testDirectory, "fixtures/evaluation/path-recovery-01/repository");
		await Promise.all([
			cp(repositoryFixture, localWorkspace, { recursive: true }),
			cp(repositoryFixture, containerWorkspace, { recursive: true }),
			mkdir(immutableInput),
		]);
		await writeFile(path.join(containerWorkspace, "answer.txt"), "Configuration file: src/settings.ts\n", "utf8");
		const local = await runHarnessAttempt({
			command: process.execPath,
			args: [path.join(testDirectory, "fixtures/harness/fake-harness.mjs"), localWorkspace],
			workspaceDirectory: localWorkspace,
			task: pathRecovery01Task,
			timeoutMs: 5_000,
			environment: {},
		});
		const capturePath = path.join(rootDirectory, "docker-args.json");
		const runner = createDockerHarnessRunner({
			dockerCommand: process.execPath,
			baseArgs: [path.join(testDirectory, "fixtures/harness/fake-docker.mjs"), capturePath],
			hostEnvironment: {},
		});

		const contained = await runner.run({
			image: `selfpi-test@sha256:${"a".repeat(64)}`,
			command: "node",
			args: ["/inputs/harness/run.mjs"],
			workspaceDirectory: containerWorkspace,
			immutableInputs: [{ source: immutableInput, target: "/inputs/harness" }],
			task: pathRecovery01Task,
			timeoutMs: 5_000,
			resources: { cpuLimit: 1, memoryMb: 512 },
			networkPolicy: { mode: "none", digest: "sha256:no-network" },
			environment: { SELFPI_MODE: "evaluation" },
		});
		const dockerArgs = JSON.parse(await readFile(capturePath, "utf8")) as string[];

		expect(contained).toEqual(local);
		expect(dockerArgs).toContain("--read-only");
		expect(dockerArgs).toContain("--network");
		expect(dockerArgs).toContain("none");
		expect(dockerArgs).toContain("--cap-drop");
		expect(dockerArgs).toContain("ALL");
		expect(dockerArgs).toContain("no-new-privileges");
		expect(dockerArgs).toContain(`type=bind,src=${containerWorkspace},dst=/workspace`);
		expect(dockerArgs).toContain(`type=bind,src=${immutableInput},dst=/inputs/harness,readonly`);
		expect(dockerArgs.join(" ")).not.toContain(process.env.HOME ?? "unavailable-home");
		expect(dockerArgs.join(" ")).not.toContain("docker.sock");
		expect(dockerArgs.join(" ")).not.toMatch(/GITHUB|GH_TOKEN|SSH/i);
	});
});
