import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createEvaluationFingerprint } from "../evaluation/baseline-cache.ts";
import type { HarnessAttemptComparison } from "../evaluation/compare-harness-attempts.ts";
import type { SealedEvidenceBundleArtifact } from "../evidence/build-sealed-evidence-bundle.ts";

export type RunState = "created" | "evidence_ready";

export interface RunManifest {
	readonly version: 1;
	readonly runId: string;
	readonly experimentId: string;
	readonly state: RunState;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly evidenceBundleDigest?: string;
}

export type RunEvent =
	| {
			readonly version: 1;
			readonly sequence: 1;
			readonly at: string;
			readonly type: "run_created";
			readonly state: "created";
	  }
	| {
			readonly version: 1;
			readonly sequence: number;
			readonly at: string;
			readonly type: "state_transitioned";
			readonly from: RunState;
			readonly state: RunState;
	  };

export interface RunRecord {
	readonly manifest: RunManifest;
	readonly events: readonly RunEvent[];
}

export interface RunRecordStore {
	create(input: { readonly runId: string; readonly experimentId: string }): Promise<RunRecord>;
	recordEvaluation(runId: string, comparison: HarnessAttemptComparison): Promise<void>;
	recordEvidenceBundle(runId: string, artifact: SealedEvidenceBundleArtifact): Promise<RunRecord>;
	transition(runId: string, state: RunState): Promise<RunRecord>;
	open(runId: string): Promise<RunRecord>;
}

export interface RunRecordStoreOptions {
	readonly rootDirectory: string;
	readonly now: () => Date;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunState(value: unknown): value is RunState {
	return value === "created" || value === "evidence_ready";
}

function parseManifest(value: unknown): RunManifest {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.runId !== "string" ||
		typeof value.experimentId !== "string" ||
		!isRunState(value.state) ||
		typeof value.createdAt !== "string" ||
		typeof value.updatedAt !== "string"
	) {
		throw new Error("Run manifest is invalid.");
	}
	return Object.freeze({
		version: 1,
		runId: value.runId,
		experimentId: value.experimentId,
		state: value.state,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		...(typeof value.evidenceBundleDigest === "string" ? { evidenceBundleDigest: value.evidenceBundleDigest } : {}),
	});
}

function parseEvent(value: unknown): RunEvent {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.sequence !== "number" ||
		typeof value.at !== "string" ||
		!isRunState(value.state)
	) {
		throw new Error("Run event is invalid.");
	}
	if (value.type === "run_created" && value.sequence === 1 && value.state === "created") {
		return Object.freeze({ version: 1, sequence: 1, at: value.at, type: "run_created", state: "created" });
	}
	if (value.type === "state_transitioned" && isRunState(value.from)) {
		return Object.freeze({
			version: 1,
			sequence: value.sequence,
			at: value.at,
			type: "state_transitioned",
			from: value.from,
			state: value.state,
		});
	}
	throw new Error("Run event is invalid.");
}

export function createRunRecordStore(options: RunRecordStoreOptions): RunRecordStore {
	const runDirectory = (runId: string) => path.join(options.rootDirectory, "runs", runId);

	const writeJson = async (targetPath: string, value: unknown): Promise<void> => {
		const temporaryPath = `${targetPath}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await rename(temporaryPath, targetPath);
	};

	const writeManifest = async (directory: string, manifest: RunManifest): Promise<void> => {
		await writeJson(path.join(directory, "manifest.json"), manifest);
	};

	const open = async (runId: string): Promise<RunRecord> => {
		const directory = runDirectory(runId);
		const [manifestSource, eventsSource] = await Promise.all([
			readFile(path.join(directory, "manifest.json"), "utf8"),
			readFile(path.join(directory, "events.jsonl"), "utf8"),
		]);
		const manifestValue: unknown = JSON.parse(manifestSource);
		const events = eventsSource
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => {
				const value: unknown = JSON.parse(line);
				return parseEvent(value);
			});
		return Object.freeze({ manifest: parseManifest(manifestValue), events: Object.freeze(events) });
	};

	return {
		async create(input) {
			const directory = runDirectory(input.runId);
			await mkdir(path.dirname(directory), { recursive: true });
			await mkdir(directory);
			const at = options.now().toISOString();
			const manifest: RunManifest = Object.freeze({
				version: 1,
				runId: input.runId,
				experimentId: input.experimentId,
				state: "created",
				createdAt: at,
				updatedAt: at,
			});
			const event: RunEvent = Object.freeze({
				version: 1,
				sequence: 1,
				at,
				type: "run_created",
				state: "created",
			});
			await writeManifest(directory, manifest);
			await writeFile(path.join(directory, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
			return Object.freeze({ manifest, events: Object.freeze([event]) });
		},

		async recordEvaluation(runId, comparison) {
			const current = await open(runId);
			if (current.manifest.state !== "created") {
				throw new Error(`Cannot record evaluation evidence for a run in state ${current.manifest.state}.`);
			}
			const baselineFingerprint = createEvaluationFingerprint(comparison.baseline.fingerprintInputs);
			const candidateFingerprint = createEvaluationFingerprint(comparison.candidate.fingerprintInputs);
			if (baselineFingerprint !== candidateFingerprint) {
				throw new Error("Cannot record evaluation evidence with different fingerprints.");
			}
			const directory = runDirectory(runId);
			await Promise.all([
				writeJson(path.join(directory, "baseline-results.json"), comparison.baseline),
				writeJson(path.join(directory, "candidate-results.json"), comparison.candidate),
				writeJson(path.join(directory, "comparison.json"), {
					version: 1,
					fingerprint: baselineFingerprint,
					baselineCompletions: comparison.baselineCompletions,
					candidateCompletions: comparison.candidateCompletions,
					completionGain: comparison.completionGain,
				}),
			]);
		},

		async recordEvidenceBundle(runId, artifact) {
			const current = await open(runId);
			const directory = runDirectory(runId);
			await writeJson(path.join(directory, "evidence-bundle.json"), artifact.bundle);
			const manifest: RunManifest = Object.freeze({
				...current.manifest,
				evidenceBundleDigest: artifact.digest,
				updatedAt: options.now().toISOString(),
			});
			await writeManifest(directory, manifest);
			return Object.freeze({ manifest, events: current.events });
		},

		async transition(runId, state) {
			const current = await open(runId);
			if (current.manifest.state !== "created" || state !== "evidence_ready") {
				throw new Error(`Invalid run transition: ${current.manifest.state} -> ${state}.`);
			}
			const at = options.now().toISOString();
			const event: RunEvent = Object.freeze({
				version: 1,
				sequence: current.events.length + 1,
				at,
				type: "state_transitioned",
				from: current.manifest.state,
				state,
			});
			const manifest: RunManifest = Object.freeze({ ...current.manifest, state, updatedAt: at });
			const directory = runDirectory(runId);
			await appendFile(path.join(directory, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
			await writeManifest(directory, manifest);
			return Object.freeze({ manifest, events: Object.freeze([...current.events, event]) });
		},

		open,
	};
}
