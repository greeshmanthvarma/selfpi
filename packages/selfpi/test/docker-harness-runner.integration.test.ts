import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDockerHarnessRunner } from "../src/evaluation/docker-harness-runner.ts";
import { pathRecovery01Task } from "../src/evaluation/tasks/path-recovery-01.ts";

const describeDocker = process.env.SELFPI_DOCKER_INTEGRATION === "1" ? describe : describe.skip;

describeDocker("Docker harness runner integration", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("runs an attempt inside the restricted container boundary", async () => {
		const rootDirectory = await mkdtemp(path.join(tmpdir(), "selfpi-docker-integration-"));
		temporaryDirectories.push(rootDirectory);
		const workspaceDirectory = path.join(rootDirectory, "workspace");
		const immutableInputDirectory = path.join(rootDirectory, "immutable-input");
		await Promise.all([mkdir(workspaceDirectory), mkdir(immutableInputDirectory)]);
		await Promise.all([
			writeFile(path.join(immutableInputDirectory, "marker.txt"), "immutable\n", "utf8"),
			chmod(workspaceDirectory, 0o777),
			chmod(immutableInputDirectory, 0o755),
		]);
		const resultJson = JSON.stringify({
			transcript: [{ type: "assistant", content: "The configuration is in src/settings.ts." }],
			usage: { inputTokens: 4, outputTokens: 6 },
		});
		const hostEnvironment = Object.fromEntries(
			Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);
		const runner = createDockerHarnessRunner({
			dockerCommand: process.env.SELFPI_DOCKER_COMMAND ?? "/usr/local/bin/docker",
			hostEnvironment,
		});

		const result = await runner.run({
			image:
				process.env.SELFPI_DOCKER_IMAGE ??
				"busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662",
			command: "/bin/sh",
			args: [
				"-c",
				'test "$HOME" = /tmp/selfpi-home && test "$SELFPI_MODE" = evaluation && test -r /inputs/harness/marker.txt && test ! -e /var/run/docker.sock && test ! -d /root/.ssh && ! touch /blocked 2>/dev/null && ! touch /inputs/harness/blocked 2>/dev/null && printf "Configuration file: src/settings.ts\\n" > /workspace/answer.txt && printf "%s" "$SELFPI_RESULT"',
			],
			workspaceDirectory,
			immutableInputs: [{ source: immutableInputDirectory, target: "/inputs/harness" }],
			task: pathRecovery01Task,
			timeoutMs: 10_000,
			resources: { cpuLimit: 1, memoryMb: 128 },
			networkPolicy: { mode: "none", digest: "sha256:no-network" },
			environment: { SELFPI_MODE: "evaluation", SELFPI_RESULT: resultJson },
		});

		expect(result.termination, result.processOutput.stderr).toEqual({
			reason: "completed",
			exitCode: 0,
			signal: null,
		});
		expect(result.verifier).toEqual({
			taskId: "path-recovery-01",
			verifiedCompletion: true,
			reason: "verified",
		});
		expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10 });
	});
});
