import path from "node:path";
import { type HarnessAttemptResult, runHarnessAttempt } from "./run-harness-attempt.ts";
import type { EvaluationTask } from "./verify-task.ts";

export interface DockerHarnessAttemptInput {
	readonly image: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly workspaceDirectory: string;
	readonly immutableInputs: readonly { readonly source: string; readonly target: string }[];
	readonly task: EvaluationTask;
	readonly timeoutMs: number;
	readonly resources: { readonly cpuLimit: number; readonly memoryMb: number };
	readonly networkPolicy: { readonly mode: "none"; readonly digest: string };
	readonly environment: Readonly<Record<string, string>>;
}

export interface DockerHarnessRunner {
	run(input: DockerHarnessAttemptInput): Promise<HarnessAttemptResult>;
}

export interface DockerHarnessRunnerOptions {
	readonly dockerCommand: string;
	readonly baseArgs?: readonly string[];
	readonly hostEnvironment: Readonly<Record<string, string>>;
}

function assertSafeInput(input: DockerHarnessAttemptInput): void {
	if (!/@sha256:[0-9a-f]{64}$/.test(input.image)) {
		throw new Error("Container image must use an immutable sha256 digest.");
	}
	if (
		!Number.isFinite(input.resources.cpuLimit) ||
		input.resources.cpuLimit <= 0 ||
		!Number.isInteger(input.resources.memoryMb) ||
		input.resources.memoryMb <= 0
	) {
		throw new Error("Container resource policy is invalid.");
	}
	if (input.networkPolicy.mode !== "none" || !input.networkPolicy.digest) {
		throw new Error("Container network policy is invalid.");
	}
	for (const [key] of Object.entries(input.environment)) {
		if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|GITHUB|GH_|SSH)/i.test(key)) {
			throw new Error(`Container environment variable ${key} may expose credentials.`);
		}
	}
	for (const mount of input.immutableInputs) {
		const source = path.resolve(mount.source);
		if (
			mount.source.includes(",") ||
			mount.target.includes(",") ||
			!mount.target.startsWith("/inputs/") ||
			/(?:^|[/\\])(?:\.ssh|\.aws|\.docker)(?:[/\\]|$)/.test(source) ||
			source.endsWith("docker.sock")
		) {
			throw new Error(`Immutable input mount is not allowed: ${mount.source}.`);
		}
	}
}

export function createDockerHarnessRunner(options: DockerHarnessRunnerOptions): DockerHarnessRunner {
	return {
		async run(input) {
			assertSafeInput(input);
			const dockerArgs = [
				...(options.baseArgs ?? []),
				"run",
				"--rm",
				"--read-only",
				"--network",
				"none",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				"--pids-limit",
				"128",
				"--cpus",
				String(input.resources.cpuLimit),
				"--memory",
				`${input.resources.memoryMb}m`,
				"--user",
				"65532:65532",
				"--tmpfs",
				"/tmp:rw,noexec,nosuid,size=64m",
				"--workdir",
				"/workspace",
				"--mount",
				`type=bind,src=${path.resolve(input.workspaceDirectory)},dst=/workspace`,
				...input.immutableInputs.flatMap((mount) => [
					"--mount",
					`type=bind,src=${path.resolve(mount.source)},dst=${mount.target},readonly`,
				]),
				"--env",
				"HOME=/tmp/selfpi-home",
				...Object.entries(input.environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
				input.image,
				input.command,
				...input.args,
			];
			return runHarnessAttempt({
				command: options.dockerCommand,
				args: dockerArgs,
				workspaceDirectory: input.workspaceDirectory,
				task: input.task,
				timeoutMs: input.timeoutMs,
				environment: options.hostEnvironment,
			});
		},
	};
}
