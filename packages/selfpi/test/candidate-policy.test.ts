import { describe, expect, it } from "vitest";
import { type CandidateProposal, evaluateCandidatePolicy } from "../src/index.ts";

const proposal = (path: string, addedLine: string): CandidateProposal => ({
	version: 1,
	hypothesis: "Path-search guidance improves recovery.",
	targetFailureSignature: "held-in-01:read-call",
	affectedEditableSurface: [path],
	unifiedDiff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-return undefined;\n+${addedLine}\n`,
	expectedBehavioralMechanism: "The failed read receives actionable guidance.",
	predictedBenefit: "More tasks recover.",
	regressionRisks: ["Guidance may distract the model."],
	changedPaths: [path],
});

describe("candidate policy", () => {
	it("accepts source-only editable changes and rejects paths outside the editable surface", () => {
		const policy = {
			editableSurface: ["packages/selfpi-recovery-policy/src/**"],
			protectedSurface: ["packages/selfpi/**", ".selfpi/**"],
			checks: { appliesCleanly: true, formatting: true, typeChecking: true, targetedTests: true },
			changeBudget: {
				expectedMaximumChangedLines: 100,
				justificationRequiredAbove: 100,
				humanApprovalAbove: 250,
			},
		};
		const allowed = evaluateCandidatePolicy({
			proposal: proposal("packages/selfpi-recovery-policy/src/index.ts", "return guidance;"),
			...policy,
		});
		const outside = evaluateCandidatePolicy({
			proposal: proposal("packages/selfpi/src/index.ts", "export const compromised = true;"),
			...policy,
		});

		expect(allowed).toEqual({ eligible: true, size: "expected", changedLines: 2, violations: [] });
		expect(outside).toMatchObject({
			eligible: false,
			violations: [
				{ code: "outside_editable_surface", path: "packages/selfpi/src/index.ts" },
				{ code: "protected_surface_change", path: "packages/selfpi/src/index.ts" },
			],
		});
	});
});
