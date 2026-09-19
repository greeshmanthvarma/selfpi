import { spawn } from "node:child_process";
import type { CandidateReviewerAdapter } from "./candidate-review.ts";

function readFinalAssistantJson(jsonLines: string): unknown {
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
		throw new Error("Pi reviewer did not return a final assistant message.");
	}
	return JSON.parse(finalText) as unknown;
}

export function createPiReviewerProcessAdapter(options: {
	readonly activeHarnessCommand: string;
	readonly activeHarnessDirectory: string;
	readonly baseArgs?: readonly string[];
	readonly environment: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
}): CandidateReviewerAdapter {
	return {
		async review(input) {
			const taskPrompt = [
				input.reviewPrompt,
				"Review only; do not modify or replace the candidate.",
				`Candidate: ${JSON.stringify(input.candidate)}`,
				`Editable surface: ${JSON.stringify(input.editableSurface)}`,
				`Relevant source: ${input.relevantSource}`,
				`Repository instructions: ${input.repositoryInstructions}`,
				"Return only structured candidate-review JSON.",
			].join("\n\n");
			const thinking = input.reviewer.modelConfiguration?.thinking;
			const args = [
				...(options.baseArgs ?? []),
				"--mode",
				"json",
				"--no-session",
				"--approve",
				"--provider",
				input.reviewer.provider,
				"--model",
				input.reviewer.model,
				...(typeof thinking === "string" ? ["--thinking", thinking] : []),
				"--tools",
				"read,grep,find,ls",
				taskPrompt,
			];
			const child = spawn(options.activeHarnessCommand, args, {
				cwd: options.activeHarnessDirectory,
				env: { ...options.environment },
				stdio: ["ignore", "pipe", "pipe"],
			});
			const stdoutChunks: Buffer[] = [];
			child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
			child.stderr.resume();
			let timedOut = false;
			const timeout =
				options.timeoutMs === undefined
					? undefined
					: setTimeout(() => {
							timedOut = true;
							child.kill("SIGKILL");
						}, options.timeoutMs);
			const exitCode = await new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", resolve);
			}).finally(() => {
				if (timeout !== undefined) clearTimeout(timeout);
			});
			if (timedOut) throw new Error("Pi reviewer process timed out.");
			if (exitCode !== 0) {
				throw new Error(`Pi reviewer process failed with exit code ${String(exitCode)}.`);
			}
			return readFinalAssistantJson(Buffer.concat(stdoutChunks).toString("utf8"));
		},
	};
}
