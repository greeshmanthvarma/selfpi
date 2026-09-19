import { describe, expect, it } from "vitest";
import { type CandidateProposal, type CandidateReviewerAdapter, reviewCandidate } from "../src/index.ts";

const candidate: CandidateProposal = {
	version: 1,
	hypothesis: "Path-search guidance improves recovery.",
	targetFailureSignature: "held-in-01:read-call",
	affectedEditableSurface: ["packages/selfpi-recovery-policy/src/index.ts"],
	unifiedDiff: "original candidate diff",
	expectedBehavioralMechanism: "The model receives search guidance.",
	predictedBenefit: "More tasks recover.",
	regressionRisks: ["Guidance may distract the model."],
	changedPaths: ["packages/selfpi-recovery-policy/src/index.ts"],
};

describe("candidate review", () => {
	it("proceeds only for a valid approval with no blocking violation", async () => {
		const receivedPrompts: string[] = [];
		const responses = [
			{
				decision: "approve_for_evaluation",
				hypothesisAlignment: "aligned",
				risks: ["Guidance may be overused."],
				violations: [],
				unifiedDiff: "reviewer replacement must be ignored",
			},
			{
				decision: "approve_for_evaluation",
				hypothesisAlignment: "aligned",
				risks: [],
				violations: [{ code: "unsafe_assumption", description: "Unbounded guidance.", blocking: true }],
			},
		];
		const reviewer: CandidateReviewerAdapter = {
			async review(input) {
				receivedPrompts.push(input.reviewPrompt);
				return responses.shift();
			},
		};
		const input = {
			candidate,
			policyResult: { eligible: true, size: "expected" as const, changedLines: 2, violations: [] },
			editableSurface: ["packages/selfpi-recovery-policy/src/**"],
			relevantSource: "export function applyPathRecoveryPolicy() {}",
			repositoryInstructions: "No filesystem access.",
			reviewer: {
				provider: "faux-reviewer",
				model: "review-model",
				promptVersion: "candidate-review-v1",
				prompt: "Review only; do not rewrite the candidate.",
			},
		};

		const approved = await reviewCandidate(input, reviewer);
		const blocked = await reviewCandidate(input, reviewer);

		expect(approved).toMatchObject({
			proceed: true,
			candidate: { unifiedDiff: "original candidate diff" },
			review: {
				reviewerModel: "review-model",
				promptVersion: "candidate-review-v1",
				reviewerProvider: "faux-reviewer",
				prompt: "Review only; do not rewrite the candidate.",
				decision: "approve_for_evaluation",
				violations: [],
			},
		});
		expect(blocked).toMatchObject({ proceed: false, review: { decision: "approve_for_evaluation" } });
		expect(receivedPrompts).toEqual([
			"Review only; do not rewrite the candidate.",
			"Review only; do not rewrite the candidate.",
		]);
	});
});
