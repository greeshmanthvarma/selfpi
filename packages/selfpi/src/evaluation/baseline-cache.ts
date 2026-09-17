import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface EvaluationFingerprintInputs {
	readonly version: 1;
	readonly harness: {
		readonly baselineCommit: string;
		readonly candidateParentCommit: string;
	};
	readonly model: {
		readonly provider: string;
		readonly id: string;
		readonly parameters: Readonly<Record<string, string | number | boolean | null>>;
	};
	readonly systemInputsDigest: string;
	readonly task: {
		readonly setVersion: string;
		readonly repositoryCommits: Readonly<Record<string, string>>;
	};
	readonly dependencies: { readonly lockfileDigest: string };
	readonly evaluator: { readonly version: string };
	readonly verifier: { readonly version: string };
	readonly container: {
		readonly imageDigest: string;
		readonly networkPolicyDigest: string;
		readonly cpuLimit: number;
		readonly memoryMb: number;
	};
	readonly budget: {
		readonly timeoutMs: number;
		readonly toolCalls: number;
		readonly turns: number;
		readonly tokens: number;
		readonly costUsd: number;
	};
	readonly repetitions: number;
}

export interface BaselineEvidence {
	readonly version: 1;
	readonly baselineId: string;
	readonly verifiedCompletions: number;
}

export interface BaselineCacheResult {
	readonly fingerprint: string;
	readonly source: "cache" | "created";
	readonly evidence: BaselineEvidence;
}

export interface BaselineCache {
	getOrCreate(
		inputs: EvaluationFingerprintInputs,
		createEvidence: () => Promise<BaselineEvidence>,
	): Promise<BaselineCacheResult>;
}

export interface BaselineCacheOptions {
	readonly rootDirectory: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalSerialize(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalSerialize).join(",")}]`;
	}
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalSerialize(value[key])}`)
			.join(",")}}`;
	}
	throw new Error("Evaluation fingerprint input is not canonically serializable.");
}

function normalizeEvidence(value: unknown): BaselineEvidence {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.baselineId !== "string" ||
		typeof value.verifiedCompletions !== "number" ||
		!Number.isInteger(value.verifiedCompletions) ||
		value.verifiedCompletions < 0
	) {
		throw new Error("Cached baseline evidence is invalid.");
	}
	return Object.freeze({
		version: 1,
		baselineId: value.baselineId,
		verifiedCompletions: value.verifiedCompletions,
	});
}

const fingerprintPrefix = "selfpi-evaluation-v1:sha256:";

export function createEvaluationFingerprint(inputs: EvaluationFingerprintInputs): string {
	const digest = createHash("sha256").update(canonicalSerialize(inputs)).digest("hex");
	return `${fingerprintPrefix}${digest}`;
}

export function createBaselineCache(options: BaselineCacheOptions): BaselineCache {
	return {
		async getOrCreate(inputs, createEvidence) {
			const fingerprint = createEvaluationFingerprint(inputs);
			const digest = fingerprint.slice(fingerprintPrefix.length);
			const directory = path.join(options.rootDirectory, "baselines", digest);
			const evidencePath = path.join(directory, "evidence.json");

			try {
				const source = await readFile(evidencePath, "utf8");
				const stored: unknown = JSON.parse(source);
				if (!isRecord(stored) || stored.version !== 1 || stored.fingerprint !== fingerprint) {
					throw new Error("Cached baseline record is invalid.");
				}
				return Object.freeze({
					fingerprint,
					source: "cache",
					evidence: normalizeEvidence(stored.evidence),
				});
			} catch (error) {
				if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
					throw error;
				}
			}

			const evidence = normalizeEvidence(await createEvidence());
			await mkdir(directory, { recursive: true });
			const temporaryPath = path.join(directory, "evidence.json.tmp");
			await writeFile(temporaryPath, `${JSON.stringify({ version: 1, fingerprint, evidence }, null, 2)}\n`, "utf8");
			await rename(temporaryPath, evidencePath);
			return Object.freeze({ fingerprint, source: "created", evidence });
		},
	};
}
