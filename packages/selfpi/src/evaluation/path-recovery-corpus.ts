import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RegisteredTask } from "../config/load-supervised-runtime.ts";

export interface PathRecoveryCorpus {
	readonly registryId: string;
	readonly digest: string;
	readonly heldIn: readonly RegisteredTask[];
	readonly heldOut: readonly RegisteredTask[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function pathRecoveryCorpusRoot(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "../../protected/path-recovery-corpus-v1");
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
	let perturbation: RegisteredTask["perturbation"];
	if (value.perturbation !== undefined) {
		if (
			!isRecord(value.perturbation) ||
			value.perturbation.version !== 1 ||
			typeof value.perturbation.path !== "string" ||
			typeof value.perturbation.error !== "string"
		) {
			return undefined;
		}
		perturbation = Object.freeze({
			version: 1 as const,
			path: value.perturbation.path,
			error: value.perturbation.error,
		});
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
		...(perturbation === undefined ? {} : { perturbation }),
	});
}

export async function loadPathRecoveryCorpus(): Promise<PathRecoveryCorpus> {
	const registryPath = path.join(pathRecoveryCorpusRoot(), "task-registry.json");
	const source = await readFile(registryPath, "utf8");
	const digest = `sha256:${createHash("sha256").update(source).digest("hex")}`;
	const value: unknown = JSON.parse(source);
	if (!isRecord(value) || value.version !== 1 || typeof value.id !== "string" || !Array.isArray(value.tasks)) {
		throw new Error("Path-recovery task corpus registry is invalid.");
	}
	const tasks = value.tasks.map(parseRegisteredTask);
	const registered: RegisteredTask[] = [];
	for (const task of tasks) {
		if (task === undefined) {
			throw new Error("Path-recovery task corpus registry is invalid.");
		}
		registered.push(task);
	}
	const heldIn = Object.freeze(registered.filter((task) => task.set === "held_in"));
	const heldOut = Object.freeze(registered.filter((task) => task.set === "held_out"));
	if (heldIn.length !== 8 || heldOut.length !== 12) {
		throw new Error("Path-recovery task corpus must contain eight held-in and twelve held-out tasks.");
	}
	return Object.freeze({
		registryId: value.id,
		digest,
		heldIn,
		heldOut,
	});
}

export async function installPathRecoveryCorpus(
	targetRoot: string,
): Promise<{ readonly digest: string; readonly registryId: string }> {
	const corpus = await loadPathRecoveryCorpus();
	const sourceRoot = pathRecoveryCorpusRoot();
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
