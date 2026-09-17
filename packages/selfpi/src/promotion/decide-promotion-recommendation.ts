import type { PromotionPolicy } from "../experiments/load-experiment.ts";

export interface PromotionRecommendationInput {
	readonly gates: {
		readonly policyPassed: boolean;
		readonly reviewPassed: boolean;
		readonly buildPassed: boolean;
		readonly targetedTestsPassed: boolean;
		readonly smokePassed: boolean;
		readonly integrityViolation: boolean;
	};
	readonly policy: PromotionPolicy;
	readonly outcomes: {
		readonly baselineRepetitions: number;
		readonly candidateRepetitions: number;
		readonly baselineHeldInCompletions: number;
		readonly candidateHeldInCompletions: number;
		readonly baselineHeldOutCompletions: number;
		readonly candidateHeldOutCompletions: number;
		readonly baselineRecoveryRate: number;
		readonly candidateRecoveryRate: number;
	};
	readonly efficiency: {
		readonly baselineTokens: number;
		readonly candidateTokens: number;
		readonly baselineCostUsd: number;
		readonly candidateCostUsd: number;
	};
}

export interface PromotionReason {
	readonly code:
		| "policy_gate"
		| "review_gate"
		| "build_gate"
		| "targeted_tests_gate"
		| "smoke_gate"
		| "evaluation_integrity"
		| "held_in_completion_gain"
		| "held_out_non_regression"
		| "recovery_rate_improvement"
		| "equal_repetitions";
	readonly passed: boolean;
}

export interface PromotionRecommendation {
	readonly version: 1;
	readonly decision: "promotion_recommended" | "rejected";
	readonly metrics: {
		readonly heldInCompletionGain: number;
		readonly heldOutCompletionLoss: number;
		readonly recoveryRateChange: number;
		readonly outcomes: PromotionRecommendationInput["outcomes"];
		readonly efficiency: PromotionRecommendationInput["efficiency"];
	};
	readonly reasons: readonly PromotionReason[];
}

export function decidePromotionRecommendation(input: PromotionRecommendationInput): PromotionRecommendation {
	const heldInCompletionGain = input.outcomes.candidateHeldInCompletions - input.outcomes.baselineHeldInCompletions;
	const heldOutCompletionLoss = input.outcomes.baselineHeldOutCompletions - input.outcomes.candidateHeldOutCompletions;
	const recoveryRateChange = input.outcomes.candidateRecoveryRate - input.outcomes.baselineRecoveryRate;
	const reasons: PromotionReason[] = [
		{ code: "policy_gate", passed: input.gates.policyPassed },
		{ code: "review_gate", passed: input.gates.reviewPassed },
		{ code: "build_gate", passed: input.gates.buildPassed },
		{ code: "targeted_tests_gate", passed: input.gates.targetedTestsPassed },
		{ code: "smoke_gate", passed: input.gates.smokePassed },
		{ code: "evaluation_integrity", passed: !input.gates.integrityViolation },
		{
			code: "equal_repetitions",
			passed: input.outcomes.baselineRepetitions === input.outcomes.candidateRepetitions,
		},
		{
			code: "held_in_completion_gain",
			passed: heldInCompletionGain >= input.policy.minimumHeldInCompletionGain,
		},
		{
			code: "held_out_non_regression",
			passed: heldOutCompletionLoss <= Math.min(0, input.policy.maximumHeldOutCompletionLoss),
		},
		{
			code: "recovery_rate_improvement",
			passed: !input.policy.requireRecoveryRateImprovement || recoveryRateChange > 0,
		},
	];
	return Object.freeze({
		version: 1,
		decision: reasons.every((reason) => reason.passed) ? "promotion_recommended" : "rejected",
		metrics: Object.freeze({
			heldInCompletionGain,
			heldOutCompletionLoss,
			recoveryRateChange,
			outcomes: Object.freeze({ ...input.outcomes }),
			efficiency: Object.freeze({ ...input.efficiency }),
		}),
		reasons: Object.freeze(reasons.map((reason) => Object.freeze(reason))),
	});
}
