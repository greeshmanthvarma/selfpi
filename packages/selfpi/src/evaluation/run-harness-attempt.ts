import { spawn } from "node:child_process";
import type { EvaluationTask, VerificationResult } from "./verify-task.ts";
import { verifyEvaluationTask } from "./verify-task.ts";

export type NormalizedTranscriptEntry =
	| { readonly type: "assistant"; readonly content: string }
	| {
			readonly type: "tool_result";
			readonly toolName: string;
			readonly isError: boolean;
			readonly content: string;
	  };

export interface HarnessUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens: number;
}

export interface HarnessTermination {
	readonly reason: "completed" | "failed" | "timed_out";
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
}

export interface HarnessAttemptResult {
	readonly transcript: readonly NormalizedTranscriptEntry[];
	readonly usage: HarnessUsage;
	readonly termination: HarnessTermination;
	readonly verifier: VerificationResult;
	readonly processOutput: {
		readonly stdout: string;
		readonly stderr: string;
	};
}

export interface HarnessAttemptInput {
	readonly command: string;
	readonly args: readonly string[];
	readonly workspaceDirectory: string;
	readonly task: EvaluationTask;
	readonly timeoutMs: number;
	readonly environment: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseTranscriptEntry(value: unknown): NormalizedTranscriptEntry {
	if (!isRecord(value) || typeof value.content !== "string") {
		throw new Error("Harness transcript entry is invalid.");
	}
	if (value.type === "assistant") {
		return Object.freeze({ type: "assistant", content: value.content });
	}
	if (value.type === "tool_result" && typeof value.toolName === "string" && typeof value.isError === "boolean") {
		return Object.freeze({
			type: "tool_result",
			toolName: value.toolName,
			isError: value.isError,
			content: value.content,
		});
	}
	throw new Error("Harness transcript entry is invalid.");
}

function parseHarnessOutput(stdout: string): {
	readonly transcript: readonly NormalizedTranscriptEntry[];
	readonly usage: HarnessUsage;
} {
	const value: unknown = JSON.parse(stdout);
	if (
		!isRecord(value) ||
		!Array.isArray(value.transcript) ||
		!isRecord(value.usage) ||
		!isNonNegativeNumber(value.usage.inputTokens) ||
		!isNonNegativeNumber(value.usage.outputTokens)
	) {
		throw new Error("Harness output is invalid.");
	}
	const transcript = Object.freeze(value.transcript.map(parseTranscriptEntry));
	const usage = Object.freeze({
		inputTokens: value.usage.inputTokens,
		outputTokens: value.usage.outputTokens,
		totalTokens: value.usage.inputTokens + value.usage.outputTokens,
	});
	return Object.freeze({ transcript, usage });
}

export async function runHarnessAttempt(input: HarnessAttemptInput): Promise<HarnessAttemptResult> {
	const child = spawn(input.command, [...input.args], {
		cwd: input.workspaceDirectory,
		env: { ...input.environment },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, input.timeoutMs);
	const processResult = await new Promise<{
		readonly exitCode: number | null;
		readonly signal: NodeJS.Signals | null;
	}>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
	}).finally(() => clearTimeout(timeout));

	const stdout = Buffer.concat(stdoutChunks).toString("utf8");
	const stderr = Buffer.concat(stderrChunks).toString("utf8");
	const normalized = parseHarnessOutput(stdout);
	const termination = Object.freeze({
		reason: timedOut ? "timed_out" : processResult.exitCode === 0 ? "completed" : "failed",
		exitCode: processResult.exitCode,
		signal: processResult.signal,
	} satisfies HarnessTermination);
	const verifier = await verifyEvaluationTask(input.task, input.workspaceDirectory);

	return Object.freeze({
		transcript: normalized.transcript,
		usage: normalized.usage,
		termination,
		verifier,
		processOutput: Object.freeze({ stdout, stderr }),
	});
}
