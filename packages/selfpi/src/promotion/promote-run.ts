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
	| { readonly promoted: false; readonly reason: "not_recommended" }
	| {
			readonly promoted: true;
			readonly sourceCommit: string;
			readonly imageDigest: string;
	  };

interface HarnessVersionIdentity {
	readonly sourceCommit: string;
	readonly imageDigest: string;
}

interface ActiveHarnessRecord {
	readonly version: 1;
	readonly reference: string;
	readonly current: HarnessVersionIdentity;
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

	const promotionDirectory = path.join(input.rootDirectory, "promotion");
	const runDirectory = path.join(input.rootDirectory, "runs", input.runId);
	const active = parseActiveHarness(await readJson(path.join(promotionDirectory, "active.json")));
	const candidate = parseVersionIdentity(
		await readJson(path.join(runDirectory, "candidate-version.json")),
		"Candidate harness version",
	);
	const actualCommit = await input.referenceAdapter.read(active.reference);
	if (actualCommit !== active.current.sourceCommit) {
		throw new Error("Configured active reference does not match the active harness record.");
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
		current: candidate,
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
