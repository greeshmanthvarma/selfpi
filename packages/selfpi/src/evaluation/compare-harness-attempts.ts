import { createEvaluationFingerprint, type EvaluationFingerprintInputs } from "./baseline-cache.ts";
import type { HarnessAttemptResult } from "./run-harness-attempt.ts";

export interface EvaluatedHarnessAttempt {
	readonly fingerprintInputs: EvaluationFingerprintInputs;
	readonly result: HarnessAttemptResult;
}

export interface HarnessAttemptComparison {
	readonly baseline: EvaluatedHarnessAttempt;
	readonly candidate: EvaluatedHarnessAttempt;
	readonly baselineCompletions: 0 | 1;
	readonly candidateCompletions: 0 | 1;
	readonly completionGain: -1 | 0 | 1;
}

export interface HarnessAttemptComparisonInput {
	readonly baseline: EvaluatedHarnessAttempt;
	readonly candidate: EvaluatedHarnessAttempt;
}

export function compareHarnessAttempts(input: HarnessAttemptComparisonInput): HarnessAttemptComparison {
	if (
		createEvaluationFingerprint(input.baseline.fingerprintInputs) !==
		createEvaluationFingerprint(input.candidate.fingerprintInputs)
	) {
		throw new Error("Cannot compare harness attempts with different controlled inputs.");
	}

	const baselineCompletions = input.baseline.result.verifier.verifiedCompletion ? 1 : 0;
	const candidateCompletions = input.candidate.result.verifier.verifiedCompletion ? 1 : 0;
	const completionGain =
		candidateCompletions > baselineCompletions ? 1 : candidateCompletions < baselineCompletions ? -1 : 0;

	return Object.freeze({
		baseline: input.baseline,
		candidate: input.candidate,
		baselineCompletions,
		candidateCompletions,
		completionGain,
	});
}
