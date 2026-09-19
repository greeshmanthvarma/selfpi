import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PathPerturbationSchedule } from "../evaluation/path-perturbation-extension.ts";
import type { Experiment } from "../experiments/load-experiment.ts";

interface ModelIdentity {
	readonly provider: string;
	readonly model: string;
}

interface ProposerIdentity extends ModelIdentity {
	readonly thinking: "off" | "low" | "medium" | "high";
}

interface VersionIdentity {
	readonly sourceCommit: string;
	readonly imageDigest: string;
}

interface RepositoryIdentity {
	readonly url: string;
	readonly commit: string;
}

interface VerifierIdentity {
	readonly id: string;
	readonly digest: string;
}

export interface RegisteredTask {
	readonly id: string;
	readonly set: "held_in" | "held_out";
	readonly repository: RepositoryIdentity;
	readonly input: string;
	readonly verifier: VerifierIdentity;
	readonly perturbation?: PathPerturbationSchedule;
}

export interface ProtectedTaskRegistry {
	readonly version: 1;
	readonly id: string;
	readonly digest: string;
	readonly heldIn: readonly RegisteredTask[];
	readonly heldOut: readonly RegisteredTask[];
}

export interface ProposerTaskView {
	readonly id: string;
	readonly repository: RepositoryIdentity;
	readonly input: string;
}

export interface SupervisedRuntime {
	readonly version: 1;
	readonly mode: "supervised_v0";
	readonly activeVersion: VersionIdentity;
	readonly proposer: ProposerIdentity;
	readonly reviewer: ModelIdentity;
	readonly gateway: {
		readonly identity: string;
		readonly endpoint: string;
	};
	readonly container: {
		readonly imageDigest: string;
	};
	readonly evaluation: {
		readonly repetitions: number;
	};
	readonly taskRegistry: {
		readonly id: string;
		readonly digest: string;
	};
}

export interface LoadSupervisedRuntimeInput {
	readonly runtimePath: string;
	readonly activeVersionPath: string;
	readonly taskRegistryPath: string;
	readonly experiment: Experiment;
}

export type SupervisedRuntimeLoadResult =
	| {
			readonly ok: true;
			readonly runtime: SupervisedRuntime;
			readonly taskRegistry: ProtectedTaskRegistry;
			readonly proposerView: { readonly tasks: readonly ProposerTaskView[] };
	  }
	| { readonly ok: false; readonly message: string };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isCommit(value: unknown): value is string {
	return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function parseModel(value: unknown): ModelIdentity | undefined {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["provider", "model"]) ||
		!isNonEmptyString(value.provider) ||
		!isNonEmptyString(value.model)
	) {
		return undefined;
	}
	return Object.freeze({ provider: value.provider, model: value.model });
}

function parseProposer(value: unknown): ProposerIdentity | undefined {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["provider", "model", "thinking"]) ||
		!isNonEmptyString(value.provider) ||
		!isNonEmptyString(value.model) ||
		!["off", "low", "medium", "high"].includes(String(value.thinking))
	) {
		return undefined;
	}
	return Object.freeze({
		provider: value.provider,
		model: value.model,
		thinking: value.thinking as ProposerIdentity["thinking"],
	});
}

function parseVersionIdentity(value: unknown): VersionIdentity | undefined {
	if (!isRecord(value) || !isCommit(value.sourceCommit) || !isDigest(value.imageDigest)) {
		return undefined;
	}
	return Object.freeze({ sourceCommit: value.sourceCommit, imageDigest: value.imageDigest });
}

function parseRegisteredTask(value: unknown): RegisteredTask | undefined {
	if (
		!isRecord(value) ||
		!hasExactKeys(
			value,
			value.perturbation === undefined
				? ["id", "set", "repository", "input", "verifier"]
				: ["id", "set", "repository", "input", "verifier", "perturbation"],
		) ||
		!isNonEmptyString(value.id) ||
		(value.set !== "held_in" && value.set !== "held_out") ||
		!isNonEmptyString(value.input) ||
		!isRecord(value.repository) ||
		!hasExactKeys(value.repository, ["url", "commit"]) ||
		!isNonEmptyString(value.repository.url) ||
		!isCommit(value.repository.commit) ||
		!isRecord(value.verifier) ||
		!hasExactKeys(value.verifier, ["id", "digest"]) ||
		!isNonEmptyString(value.verifier.id) ||
		!isDigest(value.verifier.digest)
	) {
		return undefined;
	}
	let perturbation: PathPerturbationSchedule | undefined;
	if (value.perturbation !== undefined) {
		if (
			!isRecord(value.perturbation) ||
			!hasExactKeys(value.perturbation, ["version", "path", "error"]) ||
			value.perturbation.version !== 1 ||
			!isNonEmptyString(value.perturbation.path) ||
			!isNonEmptyString(value.perturbation.error)
		) {
			return undefined;
		}
		perturbation = Object.freeze({
			version: 1,
			path: value.perturbation.path,
			error: value.perturbation.error,
		});
	}
	return Object.freeze({
		id: value.id,
		set: value.set,
		repository: Object.freeze({ url: value.repository.url, commit: value.repository.commit }),
		input: value.input,
		verifier: Object.freeze({ id: value.verifier.id, digest: value.verifier.digest }),
		...(perturbation === undefined ? {} : { perturbation }),
	});
}

function resolveTasks(
	tasks: readonly RegisteredTask[],
	experiment: Experiment,
): ProtectedTaskRegistry["heldIn"] | undefined {
	const expected = new Map<string, RegisteredTask["set"]>();
	for (const id of experiment.heldIn) {
		if (expected.has(id)) return undefined;
		expected.set(id, "held_in");
	}
	for (const id of experiment.heldOut) {
		if (expected.has(id)) return undefined;
		expected.set(id, "held_out");
	}
	if (tasks.length !== expected.size) return undefined;
	const seen = new Set<string>();
	for (const task of tasks) {
		if (seen.has(task.id) || expected.get(task.id) !== task.set) return undefined;
		seen.add(task.id);
	}
	return tasks;
}

export async function loadSupervisedRuntime(input: LoadSupervisedRuntimeInput): Promise<SupervisedRuntimeLoadResult> {
	let runtimeValue: unknown;
	let activeValue: unknown;
	let registryValue: unknown;
	let registrySource: string;
	try {
		const [runtimeSource, activeSource, loadedRegistrySource] = await Promise.all([
			readFile(input.runtimePath, "utf8"),
			readFile(input.activeVersionPath, "utf8"),
			readFile(input.taskRegistryPath, "utf8"),
		]);
		runtimeValue = JSON.parse(runtimeSource);
		activeValue = JSON.parse(activeSource);
		registryValue = JSON.parse(loadedRegistrySource);
		registrySource = loadedRegistrySource;
	} catch {
		return Object.freeze({ ok: false, message: "Supervised runtime configuration could not be read." });
	}

	if (
		!isRecord(runtimeValue) ||
		!hasExactKeys(runtimeValue, [
			"version",
			"mode",
			"proposer",
			"reviewer",
			"gateway",
			"container",
			"evaluation",
			"taskRegistry",
		]) ||
		runtimeValue.version !== 1 ||
		runtimeValue.mode !== "supervised_v0"
	) {
		return Object.freeze({ ok: false, message: "Supervised runtime configuration is invalid." });
	}
	const proposer = parseProposer(runtimeValue.proposer);
	const reviewer = parseModel(runtimeValue.reviewer);
	const gateway = runtimeValue.gateway;
	const container = runtimeValue.container;
	const evaluation = runtimeValue.evaluation;
	const taskRegistryIdentity = runtimeValue.taskRegistry;
	if (
		proposer === undefined ||
		reviewer === undefined ||
		!isRecord(gateway) ||
		!hasExactKeys(gateway, ["identity", "endpoint"]) ||
		!isNonEmptyString(gateway.identity) ||
		!isNonEmptyString(gateway.endpoint) ||
		!isRecord(container) ||
		!hasExactKeys(container, ["imageDigest"]) ||
		!isDigest(container.imageDigest) ||
		!isRecord(evaluation) ||
		!hasExactKeys(evaluation, ["repetitions"]) ||
		typeof evaluation.repetitions !== "number" ||
		!Number.isInteger(evaluation.repetitions) ||
		evaluation.repetitions <= 0 ||
		!isRecord(taskRegistryIdentity) ||
		!hasExactKeys(taskRegistryIdentity, ["id", "digest"]) ||
		!isNonEmptyString(taskRegistryIdentity.id) ||
		!isDigest(taskRegistryIdentity.digest)
	) {
		return Object.freeze({ ok: false, message: "Supervised runtime configuration is invalid." });
	}

	if (!isRecord(activeValue) || activeValue.version !== 1) {
		return Object.freeze({ ok: false, message: "Active harness record is invalid." });
	}
	const activeVersion = parseVersionIdentity(activeValue.current);
	if (activeVersion === undefined) {
		return Object.freeze({ ok: false, message: "Active harness record is invalid." });
	}

	if (
		!isRecord(registryValue) ||
		!hasExactKeys(registryValue, ["version", "id", "tasks"]) ||
		registryValue.version !== 1 ||
		!isNonEmptyString(registryValue.id) ||
		!Array.isArray(registryValue.tasks)
	) {
		return Object.freeze({ ok: false, message: "Protected task registry is invalid." });
	}
	const tasks = registryValue.tasks.map(parseRegisteredTask);
	if (tasks.some((task) => task === undefined)) {
		return Object.freeze({ ok: false, message: "Protected task registry is invalid." });
	}
	const registeredTasks = resolveTasks(tasks as RegisteredTask[], input.experiment);
	const registryDigest = `sha256:${createHash("sha256").update(registrySource).digest("hex")}`;
	if (
		registeredTasks === undefined ||
		registryValue.id !== taskRegistryIdentity.id ||
		registryDigest !== taskRegistryIdentity.digest
	) {
		return Object.freeze({
			ok: false,
			message: "Protected task registry does not match the experiment or configured identity.",
		});
	}

	const heldIn = Object.freeze(registeredTasks.filter((task) => task.set === "held_in"));
	const heldOut = Object.freeze(registeredTasks.filter((task) => task.set === "held_out"));
	const taskRegistry = Object.freeze({
		version: 1 as const,
		id: registryValue.id,
		digest: registryDigest,
		heldIn,
		heldOut,
	});
	const proposerView = Object.freeze({
		tasks: Object.freeze(
			heldIn.map((task) =>
				Object.freeze({
					id: task.id,
					repository: task.repository,
					input: task.input,
				}),
			),
		),
	});
	const runtime = Object.freeze({
		version: 1 as const,
		mode: "supervised_v0" as const,
		activeVersion,
		proposer,
		reviewer,
		gateway: Object.freeze({ identity: gateway.identity, endpoint: gateway.endpoint }),
		container: Object.freeze({ imageDigest: container.imageDigest }),
		evaluation: Object.freeze({ repetitions: evaluation.repetitions }),
		taskRegistry: Object.freeze({ id: registryValue.id, digest: registryDigest }),
	});
	return Object.freeze({ ok: true, runtime, taskRegistry, proposerView });
}
