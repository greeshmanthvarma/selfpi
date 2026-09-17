import type { CandidatePolicyResult } from "../policy/candidate-policy.ts";
import type { CandidateProposal } from "../proposal/validate-candidate-proposal.ts";

export interface CandidateReviewViolation {
	readonly code: string;
	readonly description: string;
	readonly blocking: boolean;
}

export interface CandidateReviewRecord {
	readonly version: 1;
	readonly reviewerModel: string;
	readonly promptVersion: string;
	readonly decision: "approve_for_evaluation" | "reject";
	readonly hypothesisAlignment: "aligned" | "misaligned";
	readonly risks: readonly string[];
	readonly violations: readonly CandidateReviewViolation[];
}

export interface CandidateReviewerAdapter {
	review(input: {
		readonly candidate: CandidateProposal;
		readonly editableSurface: readonly string[];
		readonly relevantSource: string;
		readonly repositoryInstructions: string;
	}): Promise<unknown>;
}

export interface CandidateReviewInput {
	readonly candidate: CandidateProposal;
	readonly policyResult: CandidatePolicyResult;
	readonly editableSurface: readonly string[];
	readonly relevantSource: string;
	readonly repositoryInstructions: string;
	readonly reviewer: { readonly model: string; readonly promptVersion: string };
}

export type CandidateReviewGateResult =
	| {
			readonly proceed: boolean;
			readonly candidate: CandidateProposal;
			readonly review: CandidateReviewRecord;
	  }
	| {
			readonly proceed: false;
			readonly candidate: CandidateProposal;
			readonly error: "candidate_ineligible" | "invalid_review";
	  };

export async function reviewCandidate(
	input: CandidateReviewInput,
	adapter: CandidateReviewerAdapter,
): Promise<CandidateReviewGateResult> {
	if (!input.policyResult.eligible) {
		return Object.freeze({ proceed: false, candidate: input.candidate, error: "candidate_ineligible" });
	}
	const value = await adapter.review({
		candidate: input.candidate,
		editableSurface: input.editableSurface,
		relevantSource: input.relevantSource,
		repositoryInstructions: input.repositoryInstructions,
	});
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return Object.freeze({ proceed: false, candidate: input.candidate, error: "invalid_review" });
	}
	const response = value as Readonly<Record<string, unknown>>;
	if (
		(response.decision !== "approve_for_evaluation" && response.decision !== "reject") ||
		(response.hypothesisAlignment !== "aligned" && response.hypothesisAlignment !== "misaligned") ||
		!Array.isArray(response.risks) ||
		!response.risks.every((risk) => typeof risk === "string") ||
		!Array.isArray(response.violations) ||
		!response.violations.every(
			(violation) =>
				typeof violation === "object" &&
				violation !== null &&
				"code" in violation &&
				typeof violation.code === "string" &&
				"description" in violation &&
				typeof violation.description === "string" &&
				"blocking" in violation &&
				typeof violation.blocking === "boolean",
		)
	) {
		return Object.freeze({ proceed: false, candidate: input.candidate, error: "invalid_review" });
	}
	const violations = response.violations.map((violation) => {
		const item = violation as { readonly code: string; readonly description: string; readonly blocking: boolean };
		return Object.freeze({ code: item.code, description: item.description, blocking: item.blocking });
	});
	const review: CandidateReviewRecord = Object.freeze({
		version: 1,
		reviewerModel: input.reviewer.model,
		promptVersion: input.reviewer.promptVersion,
		decision: response.decision,
		hypothesisAlignment: response.hypothesisAlignment,
		risks: Object.freeze([...response.risks]),
		violations: Object.freeze(violations),
	});
	return Object.freeze({
		proceed:
			review.decision === "approve_for_evaluation" &&
			review.hypothesisAlignment === "aligned" &&
			!review.violations.some((violation) => violation.blocking),
		candidate: input.candidate,
		review,
	});
}
