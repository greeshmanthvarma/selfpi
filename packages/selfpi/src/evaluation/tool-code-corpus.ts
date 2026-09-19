import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RegisteredTask } from "../config/load-supervised-runtime.ts";

export type ToolCodeToolName = "read" | "bash" | "edit" | "grep" | "write" | "find" | "ls";

export interface ToolCodeNaturalFailure {
	readonly version: 1;
	readonly toolName: ToolCodeToolName;
	readonly arguments: Readonly<Record<string, unknown>>;
	readonly errorContent: string;
	readonly mechanism: string;
}

export interface ToolCodeCorpus {
	readonly registryId: string;
	readonly digest: string;
	readonly heldIn: readonly RegisteredTask[];
	readonly heldOut: readonly RegisteredTask[];
	readonly failureCatalog: Readonly<Record<string, ToolCodeNaturalFailure>>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toolCodeCorpusRoot(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "../../protected/tool-code-corpus-v1");
}

function parseRegisteredTask(value: unknown): RegisteredTask | undefined {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		(value.set !== "held_in" && value.set !== "held_out") ||
		typeof value.input !== "string" ||
		!isRecord(value.repository) ||
		typeof value.repository.url !== "string" ||
		typeof value.repository.commit !== "string" ||
		!isRecord(value.verifier) ||
		typeof value.verifier.id !== "string" ||
		typeof value.verifier.digest !== "string"
	) {
		return undefined;
	}
	if (value.perturbation !== undefined) {
		return undefined;
	}
	return Object.freeze({
		id: value.id,
		set: value.set,
		repository: Object.freeze({
			url: value.repository.url,
			commit: value.repository.commit,
		}),
		input: value.input,
		verifier: Object.freeze({ id: value.verifier.id, digest: value.verifier.digest }),
	});
}

function parseNaturalFailure(value: unknown): ToolCodeNaturalFailure | undefined {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.toolName !== "string" ||
		typeof value.errorContent !== "string" ||
		typeof value.mechanism !== "string" ||
		!isRecord(value.arguments)
	) {
		return undefined;
	}
	const toolName = value.toolName;
	if (
		toolName !== "read" &&
		toolName !== "bash" &&
		toolName !== "edit" &&
		toolName !== "grep" &&
		toolName !== "write" &&
		toolName !== "find" &&
		toolName !== "ls"
	) {
		return undefined;
	}
	return Object.freeze({
		version: 1 as const,
		toolName,
		arguments: Object.freeze({ ...value.arguments }),
		errorContent: value.errorContent,
		mechanism: value.mechanism,
	});
}

export async function loadToolCodeCorpus(): Promise<ToolCodeCorpus> {
	const root = toolCodeCorpusRoot();
	const registryPath = path.join(root, "task-registry.json");
	const catalogPath = path.join(root, "failure-catalog.json");
	const source = await readFile(registryPath, "utf8");
	const digest = `sha256:${createHash("sha256").update(source).digest("hex")}`;
	const value: unknown = JSON.parse(source);
	if (!isRecord(value) || value.version !== 1 || typeof value.id !== "string" || !Array.isArray(value.tasks)) {
		throw new Error("Tool-code task corpus registry is invalid.");
	}
	const tasks = value.tasks.map(parseRegisteredTask);
	const registered: RegisteredTask[] = [];
	for (const task of tasks) {
		if (task === undefined) {
			throw new Error("Tool-code task corpus registry is invalid.");
		}
		registered.push(task);
	}
	const heldIn = Object.freeze(registered.filter((task) => task.set === "held_in"));
	const heldOut = Object.freeze(registered.filter((task) => task.set === "held_out"));
	if (heldIn.length !== 4 || heldOut.length !== 4) {
		throw new Error("Tool-code task corpus must contain four held-in and four held-out tasks.");
	}

	const catalogSource = await readFile(catalogPath, "utf8");
	const catalogValue: unknown = JSON.parse(catalogSource);
	if (
		!isRecord(catalogValue) ||
		catalogValue.version !== 1 ||
		typeof catalogValue.id !== "string" ||
		!isRecord(catalogValue.failures)
	) {
		throw new Error("Tool-code failure catalog is invalid.");
	}
	const failureCatalog: Record<string, ToolCodeNaturalFailure> = {};
	for (const task of heldIn) {
		const failure = parseNaturalFailure(catalogValue.failures[task.id]);
		if (failure === undefined) {
			throw new Error(`Tool-code failure catalog missing held-in task ${task.id}.`);
		}
		failureCatalog[task.id] = failure;
	}

	return Object.freeze({
		registryId: value.id,
		digest,
		heldIn,
		heldOut,
		failureCatalog: Object.freeze(failureCatalog),
	});
}

export async function installToolCodeCorpus(
	targetRoot: string,
): Promise<{ readonly digest: string; readonly registryId: string }> {
	const corpus = await loadToolCodeCorpus();
	const sourceRoot = toolCodeCorpusRoot();
	const registrySource = await readFile(path.join(sourceRoot, "task-registry.json"), "utf8");
	await mkdir(path.join(targetRoot, "protected-verifiers"), { recursive: true });
	await writeFile(path.join(targetRoot, "task-registry.json"), registrySource, "utf8");
	for (const task of [...corpus.heldIn, ...corpus.heldOut]) {
		await copyFile(
			path.join(sourceRoot, "protected-verifiers", `${task.verifier.id}.json`),
			path.join(targetRoot, "protected-verifiers", `${task.verifier.id}.json`),
		);
	}
	return Object.freeze({ digest: corpus.digest, registryId: corpus.registryId });
}
