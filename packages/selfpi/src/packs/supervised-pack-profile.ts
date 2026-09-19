import type { Experiment } from "../experiments/load-experiment.ts";
import { TOOL_CODE_PACK_V1_ID } from "./tool-code-pack-v1.ts";

export type SupervisedPackKind = "tool_code" | "path_recovery";

export interface SupervisedPackProfile {
	readonly kind: SupervisedPackKind;
	readonly evidenceSourcePaths: readonly string[];
	readonly typecheckProjectPath: string | undefined;
	readonly targetedTestPaths: readonly string[];
	readonly smokeTestPaths: readonly string[];
	readonly proposalPrompt: string;
	readonly reviewPrompt: string;
	readonly reviewPromptVersion: string;
}

const PATH_RECOVERY_CANDIDATE = "packages/selfpi-recovery-policy/src/index.ts";
const PATH_RECOVERY_POLICY_TEST = "packages/selfpi-recovery-policy/test/path-recovery-policy.test.ts";

export const TOOL_CODE_EVIDENCE_SOURCE_PATHS = Object.freeze([
	"packages/coding-agent/src/core/tools/read.ts",
	"packages/coding-agent/src/core/tools/edit.ts",
	"packages/coding-agent/src/core/tools/bash.ts",
	"packages/coding-agent/src/core/tools/truncate.ts",
	"packages/coding-agent/src/core/tools/path-utils.ts",
] as const);

export const TOOL_CODE_TARGETED_TEST_PATHS = Object.freeze([
	"packages/coding-agent/test/tools.test.ts",
	"packages/coding-agent/test/path-utils.test.ts",
] as const);

export const TOOL_CODE_SMOKE_TEST_PATHS = Object.freeze(["packages/coding-agent/test/path-utils.test.ts"] as const);

const pathRecoveryProfile: SupervisedPackProfile = Object.freeze({
	kind: "path_recovery",
	evidenceSourcePaths: Object.freeze([PATH_RECOVERY_CANDIDATE]),
	typecheckProjectPath: "packages/selfpi-recovery-policy/tsconfig.json",
	targetedTestPaths: Object.freeze([PATH_RECOVERY_POLICY_TEST]),
	smokeTestPaths: Object.freeze([] as string[]),
	proposalPrompt: [
		"Propose one bounded path-recovery change from the sealed held-in evidence.",
		"Use heldInFailures, redactedRepresentativeTraces, editableSource, and rejectedHypotheses.",
		"Do not repeat a rejected hypothesis.",
		"The editable policy may only rewrite failed read tool_result content; explain in expectedBehavioralMechanism how that rewritten content changes post-error agent behavior toward verified completion after a baited read failure.",
		"Edit only the editable surface, then return only one JSON object with exactly these fields:",
		"version (1), hypothesis, targetFailureSignature, affectedEditableSurface (string array of changed paths),",
		"unifiedDiff (exact git unified diff for those paths), expectedBehavioralMechanism, predictedBenefit,",
		"and regressionRisks (non-empty string array naming at least one concrete regression risk).",
		"Do not omit regressionRisks. Do not wrap the JSON in markdown.",
	].join(" "),
	reviewPrompt: [
		"Review the bounded candidate for safety, fireability, and hypothesis alignment.",
		"Reject with a blocking violation when any of these hold:",
		"(1) the policy can only fire if content is undefined/null (content is always a text-part array at the hook),",
		"(2) the decision returns empty content or drops the original error text,",
		"(3) expectedBehavioralMechanism does not connect rewritten tool_result content to post-error agent behavior toward verified completion.",
		"Return only one JSON object with exactly these fields:",
		'decision ("approve_for_evaluation" or "reject"),',
		'hypothesisAlignment ("aligned" or "misaligned"),',
		"risks (string array; use [] if none),",
		"and violations (array of {code, description, blocking} objects; use [] if none).",
		"Do not wrap the JSON in markdown.",
	].join(" "),
	reviewPromptVersion: "supervised-review-v2",
});

const toolCodeProfile: SupervisedPackProfile = Object.freeze({
	kind: "tool_code",
	evidenceSourcePaths: TOOL_CODE_EVIDENCE_SOURCE_PATHS,
	typecheckProjectPath: undefined,
	targetedTestPaths: TOOL_CODE_TARGETED_TEST_PATHS,
	smokeTestPaths: TOOL_CODE_SMOKE_TEST_PATHS,
	proposalPrompt: [
		"Propose one bounded coding-agent tools code change from the sealed held-in evidence.",
		"Use heldInFailures, redactedRepresentativeTraces, editableSource, and rejectedHypotheses.",
		"Do not repeat a rejected hypothesis.",
		"Edit only coding-agent tool implementation code on the editable surface.",
		"Explain in expectedBehavioralMechanism how the tools-code change improves agent recovery from the observed natural tool failure mode toward verified completion.",
		"Do not prescribe a concrete patch in prose outside unifiedDiff; the evidence must drive the change.",
		"Return only one JSON object with exactly these fields:",
		"version (1), hypothesis, targetFailureSignature, affectedEditableSurface (string array of changed paths),",
		"unifiedDiff (exact git unified diff for those paths), expectedBehavioralMechanism, predictedBenefit,",
		"and regressionRisks (non-empty string array naming at least one concrete regression risk).",
		"Do not omit regressionRisks. Do not wrap the JSON in markdown.",
	].join(" "),
	reviewPrompt: [
		"Review the bounded tools-code candidate for safety and hypothesis alignment.",
		"Reject with a blocking violation when any of these hold:",
		"(1) the diff leaves the editable coding-agent tools surface or touches protected SelfPi/session/auth/extensions code,",
		"(2) expectedBehavioralMechanism does not connect the tools-code change to the held-in natural tool failure mode,",
		"(3) the change removes or buries error information the agent needs after a tool failure.",
		"Return only one JSON object with exactly these fields:",
		'decision ("approve_for_evaluation" or "reject"),',
		'hypothesisAlignment ("aligned" or "misaligned"),',
		"risks (string array; use [] if none),",
		"and violations (array of {code, description, blocking} objects; use [] if none).",
		"Do not wrap the JSON in markdown.",
	].join(" "),
	reviewPromptVersion: "supervised-review-tool-code-v1",
});

export function resolveSupervisedPackProfile(experiment: Experiment): SupervisedPackProfile {
	if (
		experiment.id === TOOL_CODE_PACK_V1_ID ||
		experiment.editableSurface.some((pattern) => pattern.includes("coding-agent/src/core/tools"))
	) {
		return toolCodeProfile;
	}
	return pathRecoveryProfile;
}

export function pathRecoveryPolicyTestPath(): string {
	return PATH_RECOVERY_POLICY_TEST;
}
