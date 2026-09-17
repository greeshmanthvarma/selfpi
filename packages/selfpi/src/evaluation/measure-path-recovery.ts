import type { PathPerturbationRecord } from "./path-perturbation-extension.ts";
import type { VerificationResult } from "./verify-task.ts";

export interface PathRecoveryMeasurement {
	readonly version: 1;
	readonly taskId: string;
	readonly perturbationFired: boolean;
	readonly verifiedCompletion: boolean;
	readonly recovered: boolean;
	readonly subsequentMatchingReadSuccesses: number;
	readonly repeatedIdenticalFailures: number;
}

export function measurePathRecovery(
	perturbation: PathPerturbationRecord,
	verification: VerificationResult,
): PathRecoveryMeasurement {
	return Object.freeze({
		version: 1,
		taskId: verification.taskId,
		perturbationFired: perturbation.fired,
		verifiedCompletion: verification.verifiedCompletion,
		recovered: perturbation.fired && verification.verifiedCompletion,
		subsequentMatchingReadSuccesses: perturbation.fired ? perturbation.subsequentMatchingReadSuccesses : 0,
		repeatedIdenticalFailures: perturbation.fired ? perturbation.repeatedIdenticalFailures : 0,
	});
}
