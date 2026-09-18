import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SupervisedRuntime } from "../config/load-supervised-runtime.ts";
import type { ModelGatewaySession } from "../gateway/model-gateway.ts";
import type { ProposerProcessAdapter } from "../proposal/generate-candidate-proposal.ts";
import type { CandidateReviewerAdapter } from "../review/candidate-review.ts";

function readFinalAssistantJson(jsonLines: string, role: "proposer" | "reviewer"): unknown {
	let finalText: string | undefined;
	for (const line of jsonLines.split("\n")) {
		if (line.trim() === "") continue;
		const value: unknown = JSON.parse(line);
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const event = value as Readonly<Record<string, unknown>>;
		if (event.type !== "message_end" || typeof event.message !== "object" || event.message === null) continue;
		const message = event.message as Readonly<Record<string, unknown>>;
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		finalText = message.content
			.filter(
				(part): part is { readonly type: "text"; readonly text: string } =>
					typeof part === "object" &&
					part !== null &&
					"type" in part &&
					part.type === "text" &&
					"text" in part &&
					typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("");
	}
	if (finalText === undefined) {
		throw new Error(`Pi ${role} did not return a final assistant message.`);
	}
	return JSON.parse(finalText) as unknown;
}

async function writeGatewayModel(
	agentDirectory: string,
	model: { readonly provider: string; readonly model: string },
	session: ModelGatewaySession,
): Promise<void> {
	await mkdir(agentDirectory, { recursive: true });
	await writeFile(
		path.join(agentDirectory, "models.json"),
		`${JSON.stringify(
			{
				providers: {
					[model.provider]: {
						baseUrl: session.endpoint,
						api: "openai-completions",
						apiKey: "$SELFPI_GATEWAY_TOKEN",
						models: [
							{
								id: model.model,
								name: model.model,
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128_000,
								maxTokens: 16_384,
								compat: {
									maxTokensField: "max_tokens",
									supportsStore: false,
									supportsDeveloperRole: false,
								},
							},
						],
					},
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	await writeFile(
		path.join(agentDirectory, "auth.json"),
		`${JSON.stringify({ [model.provider]: { type: "api_key", key: session.credential } }, null, 2)}\n`,
		"utf8",
	);
}

async function runPinnedImageProcess(input: {
	readonly dockerCommand: string;
	readonly dockerBaseArgs?: readonly string[];
	readonly image: string;
	readonly networkName: string;
	readonly worktreeDirectory: string;
	readonly agentDirectory: string;
	readonly session: ModelGatewaySession;
	readonly environment: Readonly<Record<string, string>>;
	readonly processArgs: readonly string[];
	readonly timeoutMs?: number;
	readonly role: "proposer" | "reviewer";
}): Promise<unknown> {
	if (!/@sha256:[0-9a-f]{64}$/.test(input.image)) {
		throw new Error("Pinned active harness image must use an immutable sha256 digest.");
	}
	const args = [
		...(input.dockerBaseArgs ?? []),
		"run",
		"--rm",
		"--network",
		input.networkName,
		"--workdir",
		"/workspace",
		"--mount",
		`type=bind,src=${input.worktreeDirectory},dst=/workspace`,
		"--mount",
		`type=bind,src=${input.agentDirectory},dst=/agent`,
		"--env",
		"PI_CODING_AGENT_DIR=/agent",
		"--env",
		`SELFPI_GATEWAY_ENDPOINT=${input.session.endpoint}`,
		"--env",
		"SELFPI_GATEWAY_TOKEN",
		...Object.entries(input.environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
		"--entrypoint",
		"node",
		input.image,
		"/opt/selfpi/packages/coding-agent/dist/bundle/cli.js",
		...input.processArgs,
	];
	const child = spawn(input.dockerCommand, args, {
		env: {
			...input.environment,
			PATH: input.environment.PATH ?? process.env.PATH ?? "",
			SELFPI_GATEWAY_TOKEN: input.session.credential,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
	let timedOut = false;
	const timeout =
		input.timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, input.timeoutMs);
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	}).finally(() => {
		if (timeout !== undefined) clearTimeout(timeout);
	});
	if (timedOut) throw new Error(`Pinned ${input.role} process timed out.`);
	if (exitCode !== 0) {
		const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
		throw new Error(
			`Pinned ${input.role} process failed with exit code ${String(exitCode)}.${stderr.length === 0 ? "" : ` ${stderr.slice(0, 2000)}`}`,
		);
	}
	const stdout = Buffer.concat(stdoutChunks).toString("utf8");
	try {
		return readFinalAssistantJson(stdout, input.role);
	} catch (error) {
		const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
		throw new Error(
			`Pinned ${input.role} output could not be parsed: ${error instanceof Error ? error.message : String(error)}.${stderr.length === 0 ? "" : ` ${stderr.slice(0, 1500)}`}`,
		);
	}
}

export async function createPinnedImagePiProposerAdapter(input: {
	readonly runtime: SupervisedRuntime;
	readonly session: ModelGatewaySession;
	readonly image: string;
	readonly networkName: string;
	readonly dockerCommand: string;
	readonly dockerBaseArgs?: readonly string[];
	readonly agentDirectory: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
}): Promise<ProposerProcessAdapter> {
	await writeGatewayModel(input.agentDirectory, input.runtime.proposer, input.session);
	return {
		async run(proposerInput) {
			const taskPrompt = [
				proposerInput.prompt,
				"Use only the following sealed evidence and editable surface.",
				`Evidence bundle: ${JSON.stringify(proposerInput.evidenceBundle)}`,
				`Editable surface: ${JSON.stringify(proposerInput.editableSurface)}`,
				"Edit the worktree, then return only the versioned candidate-proposal JSON manifest with its exact git unified diff.",
			].join("\n\n");
			return runPinnedImageProcess({
				dockerCommand: input.dockerCommand,
				dockerBaseArgs: input.dockerBaseArgs,
				image: input.image,
				networkName: input.networkName,
				worktreeDirectory: proposerInput.worktreeDirectory,
				agentDirectory: input.agentDirectory,
				session: input.session,
				environment: input.environment,
				timeoutMs: input.timeoutMs,
				role: "proposer",
				processArgs: [
					"--no-extensions",
					"--mode",
					"json",
					"--no-session",
					"--approve",
					"--provider",
					proposerInput.model.provider,
					"--model",
					proposerInput.model.id,
					...(proposerInput.model.configuration.thinking === undefined
						? []
						: ["--thinking", proposerInput.model.configuration.thinking]),
					"--tools",
					"read,write,edit,grep,find,ls,bash",
					taskPrompt,
				],
			});
		},
	};
}

export async function createPinnedImagePiReviewerAdapter(input: {
	readonly runtime: SupervisedRuntime;
	readonly session: ModelGatewaySession;
	readonly image: string;
	readonly networkName: string;
	readonly dockerCommand: string;
	readonly dockerBaseArgs?: readonly string[];
	readonly agentDirectory: string;
	readonly activeHarnessDirectory: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
}): Promise<CandidateReviewerAdapter> {
	await writeGatewayModel(input.agentDirectory, input.runtime.reviewer, input.session);
	return {
		async review(reviewInput) {
			const taskPrompt = [
				reviewInput.reviewPrompt,
				"Review only; do not modify or replace the candidate.",
				`Candidate: ${JSON.stringify(reviewInput.candidate)}`,
				`Editable surface: ${JSON.stringify(reviewInput.editableSurface)}`,
				`Relevant source: ${reviewInput.relevantSource}`,
				`Repository instructions: ${reviewInput.repositoryInstructions}`,
				'Return only JSON: {"decision":"approve_for_evaluation"|"reject","hypothesisAlignment":"aligned"|"misaligned","risks":string[],"violations":[{"code":string,"description":string,"blocking":boolean}]}',
			].join("\n\n");
			const thinking = reviewInput.reviewer.modelConfiguration?.thinking;
			return runPinnedImageProcess({
				dockerCommand: input.dockerCommand,
				dockerBaseArgs: input.dockerBaseArgs,
				image: input.image,
				networkName: input.networkName,
				worktreeDirectory: input.activeHarnessDirectory,
				agentDirectory: input.agentDirectory,
				session: input.session,
				environment: input.environment,
				timeoutMs: input.timeoutMs,
				role: "reviewer",
				processArgs: [
					"--no-extensions",
					"--mode",
					"json",
					"--no-session",
					"--approve",
					"--provider",
					reviewInput.reviewer.provider,
					"--model",
					reviewInput.reviewer.model,
					...(typeof thinking === "string" ? ["--thinking", thinking] : []),
					"--tools",
					"read,grep,find,ls",
					taskPrompt,
				],
			});
		},
	};
}
