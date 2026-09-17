import { describe, expect, it } from "vitest";
import { decidePromotionRecommendation, type PromotionRecommendationInput } from "../src/index.ts";

describe("promotion recommendation", () => {
	it("recommends only candidates satisfying every correctness-first condition", () => {
		const passing: PromotionRecommendationInput = {
			gates: {
				policyPassed: true,
				reviewPassed: true,
				buildPassed: true,
				targetedTestsPassed: true,
				smokePassed: true,
				integrityViolation: false,
			},
			policy: {
				minimumHeldInCompletionGain: 2,
				maximumHeldOutCompletionLoss: 0,
				requireRecoveryRateImprovement: true,
			},
			outcomes: {
				baselineHeldInCompletions: 3,
				candidateHeldInCompletions: 5,
				baselineHeldOutCompletions: 10,
				candidateHeldOutCompletions: 10,
				baselineRecoveryRate: 0.25,
				candidateRecoveryRate: 0.5,
			},
			efficiency: { baselineTokens: 100, candidateTokens: 1000, baselineCostUsd: 0.1, candidateCostUsd: 1 },
		};

		const recommended = decidePromotionRecommendation(passing);
		expect(recommended).toMatchObject({
			decision: "promotion_recommended",
			metrics: { heldInCompletionGain: 2, heldOutCompletionLoss: 0, recoveryRateChange: 0.25 },
		});

		const failingInputs: PromotionRecommendationInput[] = [
			{ ...passing, outcomes: { ...passing.outcomes, candidateHeldInCompletions: 4 } },
			{ ...passing, outcomes: { ...passing.outcomes, candidateHeldOutCompletions: 9 } },
			{ ...passing, outcomes: { ...passing.outcomes, candidateRecoveryRate: 0.25 } },
			{ ...passing, gates: { ...passing.gates, integrityViolation: true } },
			{ ...passing, gates: { ...passing.gates, reviewPassed: false } },
		];
		expect(failingInputs.map((input) => decidePromotionRecommendation(input).decision)).toEqual([
			"rejected",
			"rejected",
			"rejected",
			"rejected",
			"rejected",
		]);
	});
});
