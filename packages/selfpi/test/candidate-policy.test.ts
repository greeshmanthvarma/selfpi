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
			humanApproval: false,
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

		const forbidden = evaluateCandidatePolicy({
			proposal: proposal("packages/selfpi-recovery-policy/src/index.ts", 'const fs = require("fs");'),
			...policy,
		});
		const largeDiff = `diff --git a/packages/selfpi-recovery-policy/src/index.ts b/packages/selfpi-recovery-policy/src/index.ts\n--- a/packages/selfpi-recovery-policy/src/index.ts\n+++ b/packages/selfpi-recovery-policy/src/index.ts\n@@ -1 +1,101 @@\n-old\n${Array.from({ length: 101 }, (_, index) => `+line ${index}`).join("\n")}\n`;
		const large = evaluateCandidatePolicy({
			proposal: {
				...proposal("packages/selfpi-recovery-policy/src/index.ts", "return guidance;"),
				unifiedDiff: largeDiff,
			},
			...policy,
		});

		expect(forbidden.violations).toContainEqual({ code: "forbidden_capability" });
		expect(large).toMatchObject({
			eligible: false,
			size: "justification_required",
			violations: [{ code: "missing_size_justification" }],
		});

		const unfireable = evaluateCandidatePolicy({
			proposal: proposal(
				"packages/selfpi-recovery-policy/src/index.ts",
				"if (typeof input.content === 'undefined') return { content: [] };",
			),
			...policy,
		});
		expect(unfireable.violations).toContainEqual({ code: "unfireable_recovery_policy" });
		expect(unfireable.violations).toContainEqual({ code: "destructive_recovery_content" });

		const toolsPack = {
			editableSurface: ["packages/coding-agent/src/core/tools/**"],
			protectedSurface: ["packages/selfpi/**", "packages/coding-agent/src/core/extensions/**"],
			checks: { appliesCleanly: true, formatting: true, typeChecking: true, targetedTests: true },
			changeBudget: {
				expectedMaximumChangedLines: 100,
				justificationRequiredAbove: 100,
				humanApprovalAbove: 250,
			},
			humanApproval: false,
		};
		const toolEdit = evaluateCandidatePolicy({
			proposal: proposal(
				"packages/coding-agent/src/core/tools/truncate.ts",
				"if (typeof input.content === 'undefined') return { content: [] };",
			),
			...toolsPack,
		});
		expect(toolEdit.eligible).toBe(true);
		expect(toolEdit.violations).toEqual([]);

		const toolFsImport = evaluateCandidatePolicy({
			proposal: proposal(
				"packages/coding-agent/src/core/tools/read.ts",
				'import { readdir as fsReaddir } from "fs/promises";',
			),
			...toolsPack,
		});
		expect(toolFsImport.eligible).toBe(true);
		expect(toolFsImport.violations).toEqual([]);

		const toolNetwork = evaluateCandidatePolicy({
			proposal: proposal("packages/coding-agent/src/core/tools/read.ts", 'import { connect } from "net";'),
			...toolsPack,
		});
		expect(toolNetwork.violations).toContainEqual({ code: "forbidden_capability" });
	});
});
