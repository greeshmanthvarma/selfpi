import { describe, expect, it } from "vitest";
import type { Experiment } from "../src/experiments/load-experiment.ts";
import {
	createToolCodePackV1Experiment,
	resolveSupervisedPackProfile,
	TOOL_CODE_EVIDENCE_SOURCE_PATHS,
	TOOL_CODE_SMOKE_TEST_PATHS,
	TOOL_CODE_TARGETED_TEST_PATHS,
} from "../src/index.ts";

function pathRecoveryExperiment(): Experiment {
	return Object.freeze({
		version: 1,
		id: "path-recovery-v0",
		heldIn: ["path-recovery-held-in-01"],
		heldOut: ["path-recovery-held-out-01"],
		budget: Object.freeze({
			wallClockMs: 600_000,
			toolCalls: 40,
			turns: 20,
			tokens: 200_000,
			costUsd: 10,
		}),
		editableSurface: Object.freeze(["packages/selfpi-recovery-policy/src/**"]),
		protectedSurface: Object.freeze(["packages/selfpi/**", ".selfpi/**"]),
		promotionPolicy: Object.freeze({
			minimumHeldInCompletionGain: 2,
			maximumHeldOutCompletionLoss: 0,
			requireRecoveryRateImprovement: true,
		}),
	});
}

describe("supervised pack profile", () => {
	it("routes tool-code experiments to coding-agent tools evidence and tests", () => {
		const profile = resolveSupervisedPackProfile(createToolCodePackV1Experiment());
		expect(profile.kind).toBe("tool_code");
		expect(profile.evidenceSourcePaths).toEqual([...TOOL_CODE_EVIDENCE_SOURCE_PATHS]);
		expect(profile.targetedTestPaths).toEqual([...TOOL_CODE_TARGETED_TEST_PATHS]);
		expect(profile.smokeTestPaths).toEqual([...TOOL_CODE_SMOKE_TEST_PATHS]);
		expect(profile.typecheckProjectPath).toBeUndefined();
		expect(profile.proposalPrompt).toContain("coding-agent tools code");
		expect(profile.proposalPrompt).not.toContain("baited read");
		expect(profile.reviewPromptVersion).toBe("supervised-review-tool-code-v1");
	});

	it("keeps path-recovery as a legacy pack profile", () => {
		const profile = resolveSupervisedPackProfile(pathRecoveryExperiment());
		expect(profile.kind).toBe("path_recovery");
		expect(profile.evidenceSourcePaths).toEqual(["packages/selfpi-recovery-policy/src/index.ts"]);
		expect(profile.targetedTestPaths).toEqual(["packages/selfpi-recovery-policy/test/path-recovery-policy.test.ts"]);
		expect(profile.proposalPrompt).toContain("path-recovery");
		expect(profile.reviewPromptVersion).toBe("supervised-review-v2");
	});
});
