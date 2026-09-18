import { realpath } from "node:fs/promises";
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
	readonly networkPolicy:
		| { readonly mode: "none"; readonly digest: string }
		| { readonly mode: "gateway_only"; readonly digest: string; readonly networkName: string };
	readonly gatewaySession?: {
		readonly endpoint: string;
		readonly credential: string;
	};
	readonly environment: Readonly<Record<string, string>>;
}

export interface DockerHarnessRunner {
	run(input: DockerHarnessAttemptInput): Promise<HarnessAttemptResult>;
}

export interface DockerHarnessRunnerOptions {
	readonly dockerCommand: string;
	readonly baseArgs?: readonly string[];
	readonly hostEnvironment: Readonly<Record<string, string>>;
	readonly allowedHostRoot: string;
}

async function assertWithinAllowedHostRoot(
	target: string,
	allowedHostRoot: string,
	name: "Workspace" | "Immutable input",
): Promise<string> {
	const [resolvedTarget, resolvedRoot] = await Promise.all([realpath(target), realpath(allowedHostRoot)]);
	const relative = path.relative(resolvedRoot, resolvedTarget);
	if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
		throw new Error(`${name} mount is outside the allowed host root.`);
	}
	return resolvedTarget;
}

async function assertSafeInput(
	input: DockerHarnessAttemptInput,
	allowedHostRoot: string,
): Promise<{ readonly workspace: string; readonly immutableInputs: readonly string[] }> {
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
	if (!input.networkPolicy.digest) {
		throw new Error("Container network policy is invalid.");
	}
	if (
		(input.networkPolicy.mode === "none" && input.gatewaySession !== undefined) ||
		(input.networkPolicy.mode === "gateway_only" &&
			(input.gatewaySession === undefined ||
				!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(input.networkPolicy.networkName) ||
				!input.gatewaySession.endpoint.startsWith("http://") ||
				input.gatewaySession.credential.length === 0))
	) {
		throw new Error("Container gateway policy is invalid.");
	}
	for (const [key] of Object.entries(input.environment)) {
		if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|GITHUB|GH_|SSH)/i.test(key)) {
			throw new Error(`Container environment variable ${key} may expose credentials.`);
		}
	}
	const workspace = await assertWithinAllowedHostRoot(input.workspaceDirectory, allowedHostRoot, "Workspace");
	const immutableInputs = await Promise.all(
		input.immutableInputs.map((mount) =>
			assertWithinAllowedHostRoot(mount.source, allowedHostRoot, "Immutable input"),
		),
	);
	for (const [index, mount] of input.immutableInputs.entries()) {
		const source = immutableInputs[index];
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
	return Object.freeze({ workspace, immutableInputs: Object.freeze(immutableInputs) });
}

export function createDockerHarnessRunner(options: DockerHarnessRunnerOptions): DockerHarnessRunner {
	return {
		async run(input) {
			const mounts = await assertSafeInput(input, options.allowedHostRoot);
			const dockerArgs = [
				...(options.baseArgs ?? []),
				"run",
				"--rm",
				"--read-only",
				"--network",
				input.networkPolicy.mode === "none" ? "none" : input.networkPolicy.networkName,
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
				`type=bind,src=${mounts.workspace},dst=/workspace`,
				...input.immutableInputs.flatMap((mount, index) => [
					"--mount",
					`type=bind,src=${mounts.immutableInputs[index]},dst=${mount.target},readonly`,
				]),
				"--env",
				"HOME=/tmp/selfpi-home",
				...(input.gatewaySession === undefined
					? []
					: [
							"--env",
							`SELFPI_GATEWAY_ENDPOINT=${input.gatewaySession.endpoint}`,
							"--env",
							"SELFPI_GATEWAY_TOKEN",
						]),
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
				environment: {
					...options.hostEnvironment,
					...(input.gatewaySession === undefined ? {} : { SELFPI_GATEWAY_TOKEN: input.gatewaySession.credential }),
				},
			});
		},
	};
}
