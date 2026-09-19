import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createDockerHarnessRunner } from "../src/evaluation/docker-harness-runner.ts";
import { runHarnessAttempt } from "../src/evaluation/run-harness-attempt.ts";
import { pathRecovery01Task } from "../src/evaluation/tasks/path-recovery-01.ts";

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
			allowedHostRoot: rootDirectory,
		});

		const attempt = {
			image: `selfpi-test@sha256:${"a".repeat(64)}`,
			command: "node",
			args: ["/inputs/harness/run.mjs"],
			workspaceDirectory: containerWorkspace,
			immutableInputs: [{ source: immutableInput, target: "/inputs/harness" }],
			task: pathRecovery01Task,
			timeoutMs: 5_000,
			resources: { cpuLimit: 1, memoryMb: 512 },
			networkPolicy: { mode: "none" as const, digest: "sha256:no-network" },
			environment: { SELFPI_MODE: "evaluation" },
		};
		const contained = await runner.run(attempt);
		const dockerArgs = JSON.parse(await readFile(capturePath, "utf8")) as string[];
		const [resolvedWorkspace, resolvedImmutableInput] = await Promise.all([
			realpath(containerWorkspace),
			realpath(immutableInput),
		]);

		expect(contained).toEqual(local);
		expect(dockerArgs).toContain("--read-only");
		expect(dockerArgs).toContain("--network");
		expect(dockerArgs).toContain("none");
		expect(dockerArgs).toContain("--cap-drop");
		expect(dockerArgs).toContain("ALL");
		expect(dockerArgs).toContain("no-new-privileges");
		expect(dockerArgs).toContain("--entrypoint");
		expect(dockerArgs).toContain("node");
		expect(dockerArgs).toContain(`type=bind,src=${resolvedWorkspace},dst=/workspace`);
		expect(dockerArgs).toContain(`type=bind,src=${resolvedImmutableInput},dst=/inputs/harness,readonly`);
		expect(dockerArgs.join(" ")).not.toContain(process.env.HOME ?? "unavailable-home");
		expect(dockerArgs.join(" ")).not.toContain("docker.sock");
		expect(dockerArgs.join(" ")).not.toMatch(/GITHUB|GH_TOKEN|SSH/i);
		await runner.run({
			...attempt,
			networkPolicy: {
				mode: "gateway_only",
				digest: "sha256:gateway-only",
				networkName: "selfpi-evaluation",
			},
			gatewaySession: {
				endpoint: "http://model-gateway.internal/v1",
				credential: "short-lived-credential",
			},
		});
		const gatewayArgs = JSON.parse(await readFile(capturePath, "utf8")) as string[];
		expect(gatewayArgs).toContain("selfpi-evaluation");
		expect(gatewayArgs).toContain("SELFPI_GATEWAY_TOKEN");
		expect(gatewayArgs.join(" ")).not.toContain("short-lived-credential");
		await expect(
			runner.run({
				...attempt,
				workspaceDirectory: process.env.HOME ?? path.parse(rootDirectory).root,
			}),
		).rejects.toThrow("Workspace mount is outside the allowed host root.");
	});
});
