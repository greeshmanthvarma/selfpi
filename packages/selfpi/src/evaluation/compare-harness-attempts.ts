import type { HarnessAttemptResult } from "./run-harness-attempt.ts";

export interface ControlledAttemptInputs {
	readonly experimentId: string;
	readonly taskId: string;
	readonly model: {
		readonly provider: string;
		readonly id: string;
	};
	readonly limits: {
		readonly timeoutMs: number;
		readonly toolCalls: number;
		readonly turns: number;
	};
}

export interface EvaluatedHarnessAttempt {
	readonly controlledInputs: ControlledAttemptInputs;
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

function controlledInputsMatch(left: ControlledAttemptInputs, right: ControlledAttemptInputs): boolean {
	return (
		left.experimentId === right.experimentId &&
		left.taskId === right.taskId &&
		left.model.provider === right.model.provider &&
		left.model.id === right.model.id &&
		left.limits.timeoutMs === right.limits.timeoutMs &&
		left.limits.toolCalls === right.limits.toolCalls &&
		left.limits.turns === right.limits.turns
	);
}

export function compareHarnessAttempts(input: HarnessAttemptComparisonInput): HarnessAttemptComparison {
	if (!controlledInputsMatch(input.baseline.controlledInputs, input.candidate.controlledInputs)) {
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
