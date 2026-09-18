import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createRunRecordStore } from "../records/run-record.ts";

const executeFile = promisify(execFile);

export interface PromotionReferenceAdapter {
	read(reference: string): Promise<string>;
	advance(input: {
		readonly reference: string;
		readonly expectedCommit: string;
		readonly nextCommit: string;
	}): Promise<void>;
}

export interface PromoteRunInput {
	readonly rootDirectory: string;
	readonly runId: string;
	readonly now: () => Date;
	readonly referenceAdapter: PromotionReferenceAdapter;
}

export type PromoteRunResult =
	| { readonly promoted: false; readonly reason: "not_recommended" | "engineering_evidence_only" }
	| {
			readonly promoted: true;
			readonly sourceCommit: string;
			readonly imageDigest: string;
	  };

export interface RollbackVersionInput {
	readonly rootDirectory: string;
	readonly version: string;
	readonly now: () => Date;
	readonly referenceAdapter: PromotionReferenceAdapter;
}

export type RollbackVersionResult =
	| { readonly rolledBack: false; readonly reason: "unrecorded" | "ambiguous" }
	| {
			readonly rolledBack: true;
			readonly sourceCommit: string;
			readonly imageDigest: string;
	  };

interface HarnessVersionIdentity {
	readonly sourceCommit: string;
	readonly imageDigest: string;
}

interface CandidateHarnessVersion extends HarnessVersionIdentity {
	readonly runId: string;
	readonly predecessorCommit: string;
	readonly candidateReference: string;
}

interface ActiveHarnessRecord {
	readonly version: 1;
	readonly reference: string;
	readonly current: HarnessVersionIdentity;
}

interface PromotionLineageEvent {
	readonly version: 1;
	readonly type: "promoted";
	readonly runId: string;
	readonly at: string;
	readonly reference: string;
	readonly activeCommit: string;
	readonly predecessorCommit: string;
	readonly imageDigest: string;
	readonly predecessorImageDigest: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseVersionIdentity(value: unknown, name: string): HarnessVersionIdentity {
	if (
		!isRecord(value) ||
		typeof value.sourceCommit !== "string" ||
		!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.sourceCommit) ||
		typeof value.imageDigest !== "string" ||
		!/^sha256:[0-9a-f]{64}$/.test(value.imageDigest)
	) {
		throw new Error(`${name} is invalid.`);
	}
	return Object.freeze({ sourceCommit: value.sourceCommit, imageDigest: value.imageDigest });
}

function parseActiveHarness(value: unknown): ActiveHarnessRecord {
	if (!isRecord(value) || value.version !== 1 || typeof value.reference !== "string") {
		throw new Error("Active harness record is invalid.");
	}
	return Object.freeze({
		version: 1,
		reference: value.reference,
		current: parseVersionIdentity(value.current, "Active harness version"),
	});
}

function parseCandidateHarnessVersion(value: unknown, runId: string): CandidateHarnessVersion {
	const identity = parseVersionIdentity(value, "Candidate harness version");
	if (
		!isRecord(value) ||
		value.runId !== runId ||
		typeof value.predecessorCommit !== "string" ||
		!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.predecessorCommit) ||
		value.candidateReference !== `refs/selfpi/candidates/${runId}`
	) {
		throw new Error("Candidate harness version is invalid.");
	}
	return Object.freeze({
		...identity,
		runId,
		predecessorCommit: value.predecessorCommit,
		candidateReference: value.candidateReference,
	});
}

function parsePromotionLineageEvent(value: unknown): PromotionLineageEvent | undefined {
	if (!isRecord(value) || value.type !== "promoted") return undefined;
	if (
		value.version !== 1 ||
		typeof value.runId !== "string" ||
		typeof value.at !== "string" ||
		typeof value.reference !== "string"
	) {
		throw new Error("Promotion lineage event is invalid.");
	}
	const active = parseVersionIdentity(
		{ sourceCommit: value.activeCommit, imageDigest: value.imageDigest },
		"Promoted harness version",
	);
	const predecessor = parseVersionIdentity(
		{ sourceCommit: value.predecessorCommit, imageDigest: value.predecessorImageDigest },
		"Predecessor harness version",
	);
	return Object.freeze({
		version: 1,
		type: "promoted",
		runId: value.runId,
		at: value.at,
		reference: value.reference,
		activeCommit: active.sourceCommit,
		predecessorCommit: predecessor.sourceCommit,
		imageDigest: active.imageDigest,
		predecessorImageDigest: predecessor.imageDigest,
	});
}

async function readJson(targetPath: string): Promise<unknown> {
	return JSON.parse(await readFile(targetPath, "utf8"));
}

async function writeJson(targetPath: string, value: unknown): Promise<void> {
	const temporaryPath = `${targetPath}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(temporaryPath, targetPath);
}

export function createGitPromotionReferenceAdapter(repositoryDirectory: string): PromotionReferenceAdapter {
	return {
		async read(reference) {
			const result = await executeFile("git", ["rev-parse", "--verify", reference], {
				cwd: repositoryDirectory,
			});
			return result.stdout.trim();
		},
		async advance(input) {
			await executeFile("git", ["update-ref", input.reference, input.nextCommit, input.expectedCommit], {
				cwd: repositoryDirectory,
			});
		},
	};
}

export async function promoteRun(input: PromoteRunInput): Promise<PromoteRunResult> {
	const store = createRunRecordStore({ rootDirectory: input.rootDirectory, now: input.now });
	const run = await store.open(input.runId);
	if (run.manifest.state !== "promotion_recommended") {
		return Object.freeze({ promoted: false, reason: "not_recommended" });
	}
	if (run.manifest.evidenceClass === "deterministic_engineering") {
		return Object.freeze({ promoted: false, reason: "engineering_evidence_only" });
	}

	const promotionDirectory = path.join(input.rootDirectory, "promotion");
	const runDirectory = path.join(input.rootDirectory, "runs", input.runId);
	const active = parseActiveHarness(await readJson(path.join(promotionDirectory, "active.json")));
	const candidate = parseCandidateHarnessVersion(
		await readJson(path.join(runDirectory, "candidate-version.json")),
		input.runId,
	);
	if (candidate.predecessorCommit !== active.current.sourceCommit) {
		throw new Error("Candidate predecessor does not match the active harness record.");
	}
	const [actualCommit, candidateCommit] = await Promise.all([
		input.referenceAdapter.read(active.reference),
		input.referenceAdapter.read(candidate.candidateReference),
	]);
	if (actualCommit !== active.current.sourceCommit) {
		throw new Error("Configured active reference does not match the active harness record.");
	}
	if (candidateCommit !== candidate.sourceCommit) {
		throw new Error("Candidate reference does not match the candidate harness record.");
	}

	await input.referenceAdapter.advance({
		reference: active.reference,
		expectedCommit: active.current.sourceCommit,
		nextCommit: candidate.sourceCommit,
	});
	const at = input.now().toISOString();
	const event = Object.freeze({
		version: 1,
		type: "promoted",
		runId: input.runId,
		at,
		reference: active.reference,
		activeCommit: candidate.sourceCommit,
		predecessorCommit: active.current.sourceCommit,
		imageDigest: candidate.imageDigest,
		predecessorImageDigest: active.current.imageDigest,
	});
	const nextActive = Object.freeze({
		version: 1,
		reference: active.reference,
		current: Object.freeze({ sourceCommit: candidate.sourceCommit, imageDigest: candidate.imageDigest }),
		predecessor: active.current,
		activatedByRunId: input.runId,
		activatedAt: at,
	});
	await mkdir(promotionDirectory, { recursive: true });
	await Promise.all([
		writeJson(path.join(promotionDirectory, "active.json"), nextActive),
		writeJson(path.join(runDirectory, "promotion.json"), event),
		appendFile(path.join(promotionDirectory, "lineage.jsonl"), `${JSON.stringify(event)}\n`, "utf8"),
	]);
	await store.transition(input.runId, "promoted");
	return Object.freeze({
		promoted: true,
		sourceCommit: candidate.sourceCommit,
		imageDigest: candidate.imageDigest,
	});
}

export async function rollbackVersion(input: RollbackVersionInput): Promise<RollbackVersionResult> {
	const promotionDirectory = path.join(input.rootDirectory, "promotion");
	const lineageSource = await readFile(path.join(promotionDirectory, "lineage.jsonl"), "utf8");
	const matches = lineageSource
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => {
			const value: unknown = JSON.parse(line);
			return parsePromotionLineageEvent(value);
		})
		.filter((event): event is PromotionLineageEvent => event?.activeCommit === input.version);
	if (matches.length === 0) return Object.freeze({ rolledBack: false, reason: "unrecorded" });
	if (matches.length > 1) return Object.freeze({ rolledBack: false, reason: "ambiguous" });

	const promotion = matches[0];
	const active = parseActiveHarness(await readJson(path.join(promotionDirectory, "active.json")));
	const actualCommit = await input.referenceAdapter.read(active.reference);
	if (
		promotion.reference !== active.reference ||
		promotion.activeCommit !== active.current.sourceCommit ||
		promotion.imageDigest !== active.current.imageDigest ||
		actualCommit !== active.current.sourceCommit
	) {
		throw new Error("Configured active reference does not match the recorded rollback target.");
	}

	await input.referenceAdapter.advance({
		reference: active.reference,
		expectedCommit: promotion.activeCommit,
		nextCommit: promotion.predecessorCommit,
	});
	const at = input.now().toISOString();
	const event = Object.freeze({
		version: 1,
		type: "rolled_back",
		runId: promotion.runId,
		at,
		reference: active.reference,
		rolledBackCommit: promotion.activeCommit,
		restoredCommit: promotion.predecessorCommit,
		rolledBackImageDigest: promotion.imageDigest,
		restoredImageDigest: promotion.predecessorImageDigest,
	});
	await Promise.all([
		writeJson(path.join(promotionDirectory, "active.json"), {
			version: 1,
			reference: active.reference,
			current: {
				sourceCommit: promotion.predecessorCommit,
				imageDigest: promotion.predecessorImageDigest,
			},
			predecessor: {
				sourceCommit: promotion.activeCommit,
				imageDigest: promotion.imageDigest,
			},
			activatedByRunId: promotion.runId,
			activatedAt: at,
		}),
		appendFile(path.join(promotionDirectory, "lineage.jsonl"), `${JSON.stringify(event)}\n`, "utf8"),
	]);
	const store = createRunRecordStore({ rootDirectory: input.rootDirectory, now: input.now });
	await store.transition(promotion.runId, "rolled_back");
	return Object.freeze({
		rolledBack: true,
		sourceCommit: promotion.predecessorCommit,
		imageDigest: promotion.predecessorImageDigest,
	});
}
