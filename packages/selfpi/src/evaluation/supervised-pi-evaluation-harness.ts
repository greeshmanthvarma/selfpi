import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gatewayModelProviderConfig } from "../gateway/openai-gateway-model-config.ts";
import type { NormalizedTranscriptEntry } from "./run-harness-attempt.ts";

const defaultCodingAgentCli = "/opt/selfpi/packages/coding-agent/dist/bundle/cli.js";
const agentDirectory = "/tmp/selfpi-eval-agent";
const extensionPath = "/tmp/selfpi-eval-extension.ts";
const perturbationOutPath = "/tmp/selfpi-perturbation.json";

async function resolveCodingAgentCli(harnessRoot: string): Promise<string> {
	const harnessCli = path.join(harnessRoot, "packages/coding-agent/dist/bundle/cli.js");
	try {
		await access(harnessCli);
		return harnessCli;
	} catch {
		return defaultCodingAgentCli;
	}
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) {
		throw new Error(`${name} is required for supervised evaluation.`);
	}
	return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { readonly type: "text"; readonly text: string } =>
				isRecord(part) && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("");
}

function parsePiJsonl(stdout: string): {
	readonly transcript: readonly NormalizedTranscriptEntry[];
	readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
} {
	const transcript: NormalizedTranscriptEntry[] = [];
	let inputTokens = 0;
	let outputTokens = 0;
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") continue;
		const value: unknown = JSON.parse(line);
		if (!isRecord(value) || value.type !== "message_end" || !isRecord(value.message)) continue;
		const message = value.message;
		if (message.role === "assistant") {
			const text = textFromContent(message.content);
			if (text.length > 0) {
				transcript.push(Object.freeze({ type: "assistant", content: text }));
			}
			if (isRecord(message.usage)) {
				if (typeof message.usage.input === "number") inputTokens += message.usage.input;
				if (typeof message.usage.output === "number") outputTokens += message.usage.output;
			}
			continue;
		}
		if (message.role === "toolResult" && typeof message.toolName === "string") {
			transcript.push(
				Object.freeze({
					type: "tool_result",
					toolName: message.toolName,
					isError: message.isError === true,
					content: textFromContent(message.content),
				}),
			);
		}
	}
	return Object.freeze({
		transcript: Object.freeze(transcript),
		usage: Object.freeze({ inputTokens, outputTokens }),
	});
}

async function writeGatewayAgentConfig(input: {
	readonly provider: string;
	readonly model: string;
	readonly endpoint: string;
	readonly credential: string;
	readonly maxTokens: number;
}): Promise<void> {
	await mkdir(agentDirectory, { recursive: true });
	await writeFile(
		path.join(agentDirectory, "models.json"),
		`${JSON.stringify(
			gatewayModelProviderConfig({
				provider: input.provider,
				model: input.model,
				endpoint: input.endpoint,
				maxTokens: input.maxTokens,
			}),
			null,
			2,
		)}\n`,
		"utf8",
	);
	await writeFile(
		path.join(agentDirectory, "auth.json"),
		`${JSON.stringify({ [input.provider]: { type: "api_key", key: input.credential } }, null, 2)}\n`,
		"utf8",
	);
}

async function writeEvaluationExtension(harnessRoot: string): Promise<void> {
	const policyPath = `${harnessRoot}/packages/selfpi-recovery-policy/src/index.ts`;
	const recoveryExtensionPath = `${harnessRoot}/packages/selfpi/src/policy/path-recovery-extension.ts`;
	const perturbationExtensionPath = `${harnessRoot}/packages/selfpi/src/evaluation/path-perturbation-extension.ts`;
	await writeFile(
		extensionPath,
		[
			'import { writeFileSync } from "node:fs";',
			'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
			`import { applyPathRecoveryPolicy } from ${JSON.stringify(policyPath)};`,
			`import { createPathRecoveryExtension } from ${JSON.stringify(recoveryExtensionPath)};`,
			`import { createPathPerturbationExtension } from ${JSON.stringify(perturbationExtensionPath)};`,
			"",
			`const perturbationOutPath = ${JSON.stringify(perturbationOutPath)};`,
			"",
			"export default function supervisedEvaluationExtension(pi: ExtensionAPI): void {",
			"\tcreatePathRecoveryExtension(applyPathRecoveryPolicy)(pi);",
			"\tconst raw = process.env.SELFPI_PERTURBATION_JSON;",
			"\tlet getRecord = () => ({ version: 1 as const, fired: false as const });",
			"\tif (raw !== undefined && raw.length > 0) {",
			"\t\tconst schedule = JSON.parse(raw);",
			"\t\tconst perturbation = createPathPerturbationExtension(schedule);",
			"\t\tperturbation.extension(pi);",
			"\t\tgetRecord = () => perturbation.getRecord();",
			"\t}",
			'\tpi.on("agent_end", () => {',
			'\t\twriteFileSync(perturbationOutPath, JSON.stringify(getRecord()) + "\\n", "utf8");',
			"\t});",
			"}",
			"",
		].join("\n"),
		"utf8",
	);
}

async function runPiEvaluation(input: {
	readonly codingAgentCli: string;
	readonly provider: string;
	readonly model: string;
	readonly taskInput: string;
}): Promise<string> {
	const args = [
		input.codingAgentCli,
		"--no-extensions",
		"-e",
		extensionPath,
		"--mode",
		"json",
		"--no-session",
		"--approve",
		"--provider",
		input.provider,
		"--model",
		input.model,
		"--tools",
		"read,bash,write,edit,grep,find,ls",
		input.taskInput,
	];
	const child = spawn(process.execPath, args, {
		cwd: "/workspace",
		env: {
			...process.env,
			HOME: "/tmp/selfpi-home",
			PI_CODING_AGENT_DIR: agentDirectory,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	const stdout = Buffer.concat(stdoutChunks).toString("utf8");
	const stderr = Buffer.concat(stderrChunks).toString("utf8");
	if (exitCode !== 0) {
		process.stderr.write(stderr);
		throw new Error(`Supervised Pi evaluation failed with exit code ${String(exitCode)}.`);
	}
	if (stderr.length > 0) process.stderr.write(stderr);
	return stdout;
}

const provider = requireEnv("SELFPI_PROVIDER");
const model = requireEnv("SELFPI_MODEL");
const endpoint = requireEnv("SELFPI_GATEWAY_ENDPOINT");
const credential = requireEnv("SELFPI_GATEWAY_TOKEN");
const taskInput = requireEnv("SELFPI_TASK_INPUT");
const harnessRoot = process.env.SELFPI_HARNESS_ROOT ?? "/inputs/harness";
const modelBudget = Number(process.env.SELFPI_MODEL_BUDGET ?? "4096");
if (!Number.isInteger(modelBudget) || modelBudget <= 0) {
	throw new Error("SELFPI_MODEL_BUDGET must be a positive integer.");
}
const maxTokens = Math.min(16_384, modelBudget);

await mkdir("/tmp/selfpi-home", { recursive: true });
await writeGatewayAgentConfig({ provider, model, endpoint, credential, maxTokens });
await writeEvaluationExtension(harnessRoot);
const codingAgentCli = await resolveCodingAgentCli(harnessRoot);
const stdout = await runPiEvaluation({ codingAgentCli, provider, model, taskInput });
const parsed = parsePiJsonl(stdout);
if (parsed.transcript.length === 0 || parsed.usage.inputTokens + parsed.usage.outputTokens === 0) {
	throw new Error("Supervised Pi evaluation produced no model transcript or usage.");
}
let perturbation: unknown = Object.freeze({ version: 1, fired: false });
try {
	perturbation = JSON.parse(await readFile(perturbationOutPath, "utf8")) as unknown;
} catch {
	// Naturalistic tasks may omit perturbation; default to unfired.
}

process.stdout.write(
	`${JSON.stringify({
		transcript: parsed.transcript,
		usage: parsed.usage,
		perturbation,
	})}\n`,
);
