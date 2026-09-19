import { readFile } from "node:fs/promises";

export interface ExperimentBudget {
	readonly wallClockMs: number;
	readonly toolCalls: number;
	readonly turns: number;
	readonly tokens: number;
	readonly costUsd: number;
}

export interface PromotionPolicy {
	readonly minimumHeldInCompletionGain: number;
	readonly maximumHeldOutCompletionLoss: number;
	readonly requireRecoveryRateImprovement: boolean;
}

export interface Experiment {
	readonly version: 1;
	readonly id: string;
	readonly heldIn: readonly string[];
	readonly heldOut: readonly string[];
	readonly budget: ExperimentBudget;
	readonly editableSurface: readonly string[];
	readonly protectedSurface: readonly string[];
	readonly promotionPolicy: PromotionPolicy;
}

export interface ExperimentValidationError {
	readonly code:
		| "experiment_unreadable"
		| "experiment_invalid_json"
		| "experiment_invalid"
		| "editable_surface_overlaps_protected_surface";
	readonly path: string;
	readonly message: string;
}

export type ExperimentLoadResult =
	| { readonly ok: true; readonly experiment: Experiment }
	| { readonly ok: false; readonly errors: readonly ExperimentValidationError[] };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.length > 0)
	);
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function surfaceRootsOverlap(leftPattern: string, rightPattern: string): boolean {
	const leftRoot = leftPattern.endsWith("/**") ? leftPattern.slice(0, -3) : leftPattern;
	const rightRoot = rightPattern.endsWith("/**") ? rightPattern.slice(0, -3) : rightPattern;
	return leftRoot === rightRoot || leftRoot.startsWith(`${rightRoot}/`) || rightRoot.startsWith(`${leftRoot}/`);
}

function normalizeExperiment(value: unknown): Experiment | undefined {
	if (!isRecord(value) || value.version !== 1 || typeof value.id !== "string" || value.id.length === 0) {
		return undefined;
	}
	if (!isNonEmptyStringArray(value.heldIn) || !isNonEmptyStringArray(value.heldOut)) {
		return undefined;
	}
	if (
		!isNonEmptyStringArray(value.editableSurface) ||
		!isNonEmptyStringArray(value.protectedSurface) ||
		!isRecord(value.budget) ||
		!isRecord(value.promotionPolicy)
	) {
		return undefined;
	}

	const { budget, promotionPolicy } = value;
	if (
		!isNonNegativeNumber(budget.wallClockMs) ||
		!isNonNegativeNumber(budget.toolCalls) ||
		!isNonNegativeNumber(budget.turns) ||
		!isNonNegativeNumber(budget.tokens) ||
		!isNonNegativeNumber(budget.costUsd) ||
		!isNonNegativeNumber(promotionPolicy.minimumHeldInCompletionGain) ||
		!isNonNegativeNumber(promotionPolicy.maximumHeldOutCompletionLoss) ||
		typeof promotionPolicy.requireRecoveryRateImprovement !== "boolean"
	) {
		return undefined;
	}

	return Object.freeze({
		version: 1,
		id: value.id,
		heldIn: Object.freeze([...value.heldIn]),
		heldOut: Object.freeze([...value.heldOut]),
		budget: Object.freeze({
			wallClockMs: budget.wallClockMs,
			toolCalls: budget.toolCalls,
			turns: budget.turns,
			tokens: budget.tokens,
			costUsd: budget.costUsd,
		}),
		editableSurface: Object.freeze([...value.editableSurface]),
		protectedSurface: Object.freeze([...value.protectedSurface]),
		promotionPolicy: Object.freeze({
			minimumHeldInCompletionGain: promotionPolicy.minimumHeldInCompletionGain,
			maximumHeldOutCompletionLoss: promotionPolicy.maximumHeldOutCompletionLoss,
			requireRecoveryRateImprovement: promotionPolicy.requireRecoveryRateImprovement,
		}),
	});
}

export async function loadExperiment(filePath: string): Promise<ExperimentLoadResult> {
	let source: string;
	try {
		source = await readFile(filePath, "utf8");
	} catch {
		return {
			ok: false,
			errors: [{ code: "experiment_unreadable", path: filePath, message: "Experiment file could not be read." }],
		};
	}

	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		return {
			ok: false,
			errors: [{ code: "experiment_invalid_json", path: filePath, message: "Experiment file is not valid JSON." }],
		};
	}

	const experiment = normalizeExperiment(value);
	if (!experiment) {
		return {
			ok: false,
			errors: [{ code: "experiment_invalid", path: filePath, message: "Experiment declaration is invalid." }],
		};
	}

	for (const [editableIndex, editablePath] of experiment.editableSurface.entries()) {
		const protectedPath = experiment.protectedSurface.find((candidate) =>
			surfaceRootsOverlap(editablePath, candidate),
		);
		if (protectedPath) {
			return {
				ok: false,
				errors: [
					{
						code: "editable_surface_overlaps_protected_surface",
						path: `editableSurface[${editableIndex}]`,
						message: `Editable path ${editablePath} overlaps protected path ${protectedPath}.`,
					},
				],
			};
		}
	}

	return { ok: true, experiment };
}
