import { readFile } from "node:fs/promises";

interface DeterministicModel {
	readonly provider: "faux";
	readonly model: string;
}

export interface DeterministicRuntime {
	readonly version: 1;
	readonly mode: "deterministic_v0";
	readonly proposer: DeterministicModel & { readonly thinking: "off" | "low" };
	readonly reviewer: DeterministicModel;
	readonly evaluation: {
		readonly repetitions: number;
	};
}

export type RuntimeLoadResult =
	| { readonly ok: true; readonly runtime: DeterministicRuntime }
	| { readonly ok: false; readonly message: string };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parseModel(value: unknown): DeterministicModel | undefined {
	if (!isRecord(value) || value.provider !== "faux" || typeof value.model !== "string" || value.model.length === 0) {
		return undefined;
	}
	return Object.freeze({
		provider: "faux",
		model: value.model,
	});
}

export async function loadDeterministicRuntime(filePath: string): Promise<RuntimeLoadResult> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(filePath, "utf8"));
	} catch {
		return Object.freeze({ ok: false, message: `Runtime configuration could not be read: ${filePath}.` });
	}
	if (!isRecord(value) || value.version !== 1 || value.mode !== "deterministic_v0") {
		return Object.freeze({ ok: false, message: "Runtime configuration is invalid." });
	}
	const proposer = parseModel(value.proposer);
	const reviewer = parseModel(value.reviewer);
	const evaluation = value.evaluation;
	if (
		proposer === undefined ||
		reviewer === undefined ||
		!isRecord(value.proposer) ||
		(value.proposer.thinking !== "off" && value.proposer.thinking !== "low") ||
		!isRecord(evaluation) ||
		!isPositiveInteger(evaluation.repetitions)
	) {
		return Object.freeze({ ok: false, message: "Runtime configuration is invalid." });
	}
	return Object.freeze({
		ok: true,
		runtime: Object.freeze({
			version: 1,
			mode: "deterministic_v0",
			proposer: Object.freeze({ ...proposer, thinking: value.proposer.thinking }),
			reviewer,
			evaluation: Object.freeze({
				repetitions: evaluation.repetitions,
			}),
		}),
	});
}
