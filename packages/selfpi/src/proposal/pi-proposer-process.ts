import { spawn } from "node:child_process";
import type { ProposerProcessAdapter } from "./generate-candidate-proposal.ts";

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
		throw new Error("Pi proposer did not return a final assistant message.");
	}
	return JSON.parse(finalText) as unknown;
}

export function createPiProposerProcessAdapter(options: {
	readonly activeHarnessCommand: string;
	readonly baseArgs?: readonly string[];
	readonly environment: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
}): ProposerProcessAdapter {
	return {
		async run(input) {
			const taskPrompt = [
				input.prompt,
				"Use only the following sealed evidence and editable surface.",
				`Evidence bundle: ${JSON.stringify(input.evidenceBundle)}`,
				`Editable surface: ${JSON.stringify(input.editableSurface)}`,
				"Edit the worktree, then return only the versioned candidate-proposal JSON manifest with its exact git unified diff.",
			].join("\n\n");
			const args = [
				...(options.baseArgs ?? []),
				"--mode",
				"json",
				"--no-session",
				"--approve",
				"--provider",
				input.model.provider,
				"--model",
				input.model.id,
				...(input.model.configuration.thinking === undefined
					? []
					: ["--thinking", input.model.configuration.thinking]),
				"--tools",
				"read,write,edit,grep,find,ls,bash",
				taskPrompt,
			];
			const child = spawn(options.activeHarnessCommand, args, {
				cwd: input.worktreeDirectory,
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
			if (timedOut) {
				throw new Error("Pi proposer process timed out.");
			}
			if (exitCode !== 0) {
				throw new Error(`Pi proposer process failed with exit code ${String(exitCode)}.`);
			}
			return readFinalAssistantJson(Buffer.concat(stdoutChunks).toString("utf8"));
		},
	};
}
