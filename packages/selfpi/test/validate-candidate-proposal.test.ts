import { describe, expect, it } from "vitest";
import { validateCandidateProposal } from "../src/index.ts";

describe("candidate proposal validation", () => {
	it("accepts a complete proposal with one unified diff and rejects missing hypothesis or risks", () => {
		const valid = {
			version: 1,
			hypothesis: "Search guidance after a missing path improves recovery.",
			targetFailureSignature: "held-in-01:read-call",
			affectedEditableSurface: ["packages/selfpi-recovery-policy/src/index.ts"],
			unifiedDiff:
				"diff --git a/packages/selfpi-recovery-policy/src/index.ts b/packages/selfpi-recovery-policy/src/index.ts\n--- a/packages/selfpi-recovery-policy/src/index.ts\n+++ b/packages/selfpi-recovery-policy/src/index.ts\n@@ -1 +1 @@\n-return undefined;\n+return guidance;\n",
			expectedBehavioralMechanism: "The model receives a search strategy.",
			predictedBenefit: "More tasks recover from stale paths.",
			regressionRisks: ["Extra guidance may distract the model."],
		};

		expect(validateCandidateProposal(valid)).toMatchObject({
			ok: true,
			proposal: { changedPaths: ["packages/selfpi-recovery-policy/src/index.ts"] },
		});
		expect(validateCandidateProposal({ ...valid, hypothesis: "" })).toEqual({
			ok: false,
			errors: [{ code: "missing_hypothesis" }],
		});
		expect(validateCandidateProposal({ ...valid, regressionRisks: [] })).toEqual({
			ok: false,
			errors: [{ code: "missing_regression_risk" }],
		});
		expect(validateCandidateProposal({ ...valid, targetFailureSignature: "" })).toEqual({
			ok: false,
			errors: [{ code: "invalid_manifest" }],
		});
		expect(
			validateCandidateProposal({
				...valid,
				unifiedDiff: valid.unifiedDiff.replace(
					"b/packages/selfpi-recovery-policy/src/index.ts",
					"b/packages/selfpi-recovery-policy/src/other.ts",
				),
			}),
		).toEqual({ ok: false, errors: [{ code: "invalid_unified_diff" }] });
	});
});
