import { cp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProtectedTaskRegistry, RegisteredTask } from "../config/load-supervised-runtime.ts";

export function terminalBenchSmokeCorpusRoot(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "../../protected/terminal-bench-smoke-v1");
}

export interface TerminalBenchSmokeCorpus {
	readonly registryId: string;
	readonly digest: string;
	readonly heldIn: readonly RegisteredTask[];
	readonly heldOut: readonly RegisteredTask[];
	readonly registry: ProtectedTaskRegistry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRegisteredTask(value: unknown, set: "held_in" | "held_out"): RegisteredTask {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		!isRecord(value.repository) ||
		typeof value.repository.url !== "string" ||
		typeof value.repository.commit !== "string" ||
		typeof value.input !== "string" ||
		!isRecord(value.verifier) ||
		typeof value.verifier.id !== "string" ||
		typeof value.verifier.digest !== "string"
	) {
		throw new Error("Terminal-Bench smoke task registry entry is invalid.");
	}
	return Object.freeze({
		id: value.id,
		set,
		repository: Object.freeze({
			url: value.repository.url,
			commit: value.repository.commit,
		}),
		input: value.input,
		verifier: Object.freeze({
			id: value.verifier.id,
			digest: value.verifier.digest,
		}),
	});
}

export async function loadTerminalBenchSmokeCorpus(
	rootDirectory = terminalBenchSmokeCorpusRoot(),
): Promise<TerminalBenchSmokeCorpus> {
	const registry = JSON.parse(await readFile(path.join(rootDirectory, "task-registry.json"), "utf8")) as unknown;
	const metadata = JSON.parse(
		await readFile(path.join(rootDirectory, "task-registry.metadata.json"), "utf8"),
	) as unknown;
	if (
		!isRecord(registry) ||
		registry.version !== 1 ||
		typeof registry.id !== "string" ||
		!Array.isArray(registry.heldIn) ||
		!Array.isArray(registry.heldOut) ||
		!isRecord(metadata) ||
		typeof metadata.digest !== "string"
	) {
		throw new Error("Terminal-Bench smoke corpus metadata is invalid.");
	}
	const heldIn = Object.freeze(registry.heldIn.map((task) => parseRegisteredTask(task, "held_in")));
	const heldOut = Object.freeze(registry.heldOut.map((task) => parseRegisteredTask(task, "held_out")));
	return Object.freeze({
		registryId: registry.id,
		digest: metadata.digest,
		heldIn,
		heldOut,
		registry: Object.freeze({
			version: 1 as const,
			id: registry.id,
			digest: metadata.digest,
			heldIn,
			heldOut,
		}),
	});
}

/** Install TB smoke verifiers beside the tool-code registry; does not replace task-registry.json. */
export async function installTerminalBenchSmokeVerifiers(targetRoot: string): Promise<TerminalBenchSmokeCorpus> {
	const corpus = await loadTerminalBenchSmokeCorpus();
	const sourceRoot = terminalBenchSmokeCorpusRoot();
	await mkdir(path.join(targetRoot, "protected-verifiers"), { recursive: true });
	for (const task of [...corpus.heldIn, ...corpus.heldOut]) {
		await cp(
			path.join(sourceRoot, "protected-verifiers", `${task.verifier.id}.json`),
			path.join(targetRoot, "protected-verifiers", `${task.verifier.id}.json`),
		);
	}
	return corpus;
}
