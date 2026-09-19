export interface CandidateProposal {
	readonly version: 1;
	readonly hypothesis: string;
	readonly targetFailureSignature: string;
	readonly affectedEditableSurface: readonly string[];
	readonly unifiedDiff: string;
	readonly expectedBehavioralMechanism: string;
	readonly predictedBenefit: string;
	readonly regressionRisks: readonly string[];
	readonly changeJustification?: string;
	readonly changedPaths: readonly string[];
}

export type CandidateProposalValidationResult =
	| { readonly ok: true; readonly proposal: CandidateProposal }
	| {
			readonly ok: false;
			readonly errors: readonly {
				readonly code:
					| "missing_hypothesis"
					| "missing_regression_risk"
					| "invalid_manifest"
					| "invalid_unified_diff";
			}[];
	  };

export function validateCandidateProposal(value: unknown): CandidateProposalValidationResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, errors: [{ code: "missing_hypothesis" }] };
	}
	const candidate = value as Readonly<Record<string, unknown>>;
	if (typeof candidate.hypothesis !== "string" || candidate.hypothesis.trim() === "") {
		return { ok: false, errors: [{ code: "missing_hypothesis" }] };
	}
	if (
		!Array.isArray(candidate.regressionRisks) ||
		!candidate.regressionRisks.some((risk) => typeof risk === "string" && risk.trim())
	) {
		return { ok: false, errors: [{ code: "missing_regression_risk" }] };
	}
	if (
		candidate.version !== 1 ||
		typeof candidate.targetFailureSignature !== "string" ||
		candidate.targetFailureSignature.trim() === "" ||
		!Array.isArray(candidate.affectedEditableSurface) ||
		candidate.affectedEditableSurface.length === 0 ||
		!candidate.affectedEditableSurface.every((path) => typeof path === "string" && path.trim() !== "") ||
		typeof candidate.unifiedDiff !== "string" ||
		typeof candidate.expectedBehavioralMechanism !== "string" ||
		candidate.expectedBehavioralMechanism.trim() === "" ||
		typeof candidate.predictedBenefit !== "string" ||
		candidate.predictedBenefit.trim() === "" ||
		(candidate.changeJustification !== undefined &&
			(typeof candidate.changeJustification !== "string" || candidate.changeJustification.trim() === "")) ||
		!candidate.regressionRisks.every((risk) => typeof risk === "string" && risk.trim() !== "")
	) {
		return { ok: false, errors: [{ code: "invalid_manifest" }] };
	}
	const affectedEditableSurface = candidate.affectedEditableSurface as readonly string[];
	const headers = [...candidate.unifiedDiff.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)];
	const changedPaths: string[] = [];
	for (const [index, header] of headers.entries()) {
		const oldPath = header[1];
		const newPath = header[2];
		const section = candidate.unifiedDiff.slice(header.index, headers[index + 1]?.index);
		if (
			oldPath !== newPath ||
			!section.includes(`\n+++ b/${newPath}\n`) ||
			(!section.includes(`\n--- a/${oldPath}\n`) && !section.includes("\n--- /dev/null\n")) ||
			!section.includes("\n@@ ")
		) {
			return { ok: false, errors: [{ code: "invalid_unified_diff" }] };
		}
		changedPaths.push(newPath);
	}
	if (changedPaths.length === 0 || changedPaths.some((path) => !affectedEditableSurface.includes(path))) {
		return { ok: false, errors: [{ code: "invalid_unified_diff" }] };
	}
	return {
		ok: true,
		proposal: Object.freeze({
			version: 1,
			hypothesis: candidate.hypothesis,
			targetFailureSignature: candidate.targetFailureSignature,
			affectedEditableSurface: Object.freeze([...affectedEditableSurface]),
			unifiedDiff: candidate.unifiedDiff,
			expectedBehavioralMechanism: candidate.expectedBehavioralMechanism,
			predictedBenefit: candidate.predictedBenefit,
			regressionRisks: Object.freeze(
				candidate.regressionRisks.filter((risk): risk is string => typeof risk === "string"),
			),
			...(typeof candidate.changeJustification === "string"
				? { changeJustification: candidate.changeJustification }
				: {}),
			changedPaths: Object.freeze(changedPaths),
		}),
	};
}
