import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SupervisedRuntime } from "../config/load-supervised-runtime.ts";
import type { ModelGatewaySession } from "../gateway/model-gateway.ts";
import type { ProposerProcessAdapter } from "../proposal/generate-candidate-proposal.ts";
import { createPiProposerProcessAdapter } from "../proposal/pi-proposer-process.ts";
import type { CandidateReviewerAdapter } from "../review/candidate-review.ts";
import { createPiReviewerProcessAdapter } from "../review/pi-reviewer-process.ts";

interface PiProcessOptions {
	readonly activeHarnessCommand: string;
	readonly baseArgs?: readonly string[];
	readonly agentDirectory: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
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
}

function gatewayEnvironment(options: PiProcessOptions, session: ModelGatewaySession): Readonly<Record<string, string>> {
	return Object.freeze({
		...options.environment,
		PI_CODING_AGENT_DIR: options.agentDirectory,
		PI_OFFLINE: "1",
		SELFPI_GATEWAY_TOKEN: session.credential,
	});
}

export async function createGatewayPiProposerAdapter(input: {
	readonly runtime: SupervisedRuntime;
	readonly session: ModelGatewaySession;
	readonly process: PiProcessOptions;
}): Promise<ProposerProcessAdapter> {
	await writeGatewayModel(input.process.agentDirectory, input.runtime.proposer, input.session);
	return createPiProposerProcessAdapter({
		activeHarnessCommand: input.process.activeHarnessCommand,
		baseArgs: input.process.baseArgs,
		environment: gatewayEnvironment(input.process, input.session),
		timeoutMs: input.process.timeoutMs,
	});
}

export async function createGatewayPiReviewerAdapter(input: {
	readonly runtime: SupervisedRuntime;
	readonly session: ModelGatewaySession;
	readonly activeHarnessDirectory: string;
	readonly process: PiProcessOptions;
}): Promise<CandidateReviewerAdapter> {
	await writeGatewayModel(input.process.agentDirectory, input.runtime.reviewer, input.session);
	return createPiReviewerProcessAdapter({
		activeHarnessCommand: input.process.activeHarnessCommand,
		activeHarnessDirectory: input.activeHarnessDirectory,
		baseArgs: input.process.baseArgs,
		environment: gatewayEnvironment(input.process, input.session),
		timeoutMs: input.process.timeoutMs,
	});
}
