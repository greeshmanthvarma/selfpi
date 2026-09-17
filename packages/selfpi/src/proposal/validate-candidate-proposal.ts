export interface CandidateProposal {
	readonly version: 1;
	readonly hypothesis: string;
	readonly targetFailureSignature: string;
	readonly affectedEditableSurface: readonly string[];
	readonly unifiedDiff: string;
	readonly expectedBehavioralMechanism: string;
	readonly predictedBenefit: string;
	readonly regressionRisks: readonly string[];
	readonly changedPaths: readonly string[];
}

export type CandidateProposalValidationResult =
	| { readonly ok: true; readonly proposal: CandidateProposal }
	| { readonly ok: false; readonly errors: readonly { readonly code: string }[] };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateCandidateProposal(value: unknown): CandidateProposalValidationResult {
	if (!isRecord(value) || typeof value.hypothesis !== "string" || value.hypothesis.trim() === "") {
		return { ok: false, errors: [{ code: "missing_hypothesis" }] };
	}
	if (
		!Array.isArray(value.regressionRisks) ||
		!value.regressionRisks.some((risk) => typeof risk === "string" && risk.trim())
	) {
		return { ok: false, errors: [{ code: "missing_regression_risk" }] };
	}
	if (
		value.version !== 1 ||
		typeof value.targetFailureSignature !== "string" ||
		!Array.isArray(value.affectedEditableSurface) ||
		!value.affectedEditableSurface.every((path) => typeof path === "string") ||
		typeof value.unifiedDiff !== "string" ||
		typeof value.expectedBehavioralMechanism !== "string" ||
		typeof value.predictedBenefit !== "string"
	) {
		return { ok: false, errors: [{ code: "invalid_manifest" }] };
	}
	const changedPaths = [...value.unifiedDiff.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map((match) => match[2]);
	if (changedPaths.length !== 1 || !value.unifiedDiff.includes("\n@@ ")) {
		return { ok: false, errors: [{ code: "invalid_unified_diff" }] };
	}
	return {
		ok: true,
		proposal: Object.freeze({
			version: 1,
			hypothesis: value.hypothesis,
			targetFailureSignature: value.targetFailureSignature,
			affectedEditableSurface: Object.freeze([...value.affectedEditableSurface]),
			unifiedDiff: value.unifiedDiff,
			expectedBehavioralMechanism: value.expectedBehavioralMechanism,
			predictedBenefit: value.predictedBenefit,
			regressionRisks: Object.freeze(
				value.regressionRisks.filter((risk): risk is string => typeof risk === "string"),
			),
			changedPaths: Object.freeze(changedPaths),
		}),
	};
}
