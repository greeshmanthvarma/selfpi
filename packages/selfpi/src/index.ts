export {
	type BaselineCache,
	type BaselineCacheOptions,
	type BaselineCacheResult,
	type BaselineEvidence,
	createBaselineCache,
	createEvaluationFingerprint,
	type EvaluationFingerprintInputs,
} from "./evaluation/baseline-cache.ts";
export {
	compareHarnessAttempts,
	type EvaluatedHarnessAttempt,
	type HarnessAttemptComparison,
	type HarnessAttemptComparisonInput,
} from "./evaluation/compare-harness-attempts.ts";
export {
	measurePathRecovery,
	type PathRecoveryMeasurement,
} from "./evaluation/measure-path-recovery.ts";
export {
	createPathPerturbationExtension,
	type PathPerturbationExtension,
	type PathPerturbationRecord,
	type PathPerturbationSchedule,
} from "./evaluation/path-perturbation-extension.ts";
export {
	type HarnessAttemptInput,
	type HarnessAttemptResult,
	type HarnessTermination,
	type HarnessUsage,
	type NormalizedTranscriptEntry,
	runHarnessAttempt,
} from "./evaluation/run-harness-attempt.ts";
export {
	type EvaluationTask,
	type ExactFileVerifier,
	type VerificationResult,
	verifyEvaluationTask,
} from "./evaluation/verify-task.ts";
export {
	extractPathRecoveryFailureSignatures,
	type PathRecoveryFailureSignature,
	type SubsequentToolCall,
} from "./evidence/extract-path-recovery-failures.ts";
export {
	type Experiment,
	type ExperimentBudget,
	type ExperimentLoadResult,
	type ExperimentValidationError,
	loadExperiment,
	type PromotionPolicy,
} from "./experiments/load-experiment.ts";
export {
	createPathRecoveryExtension,
	type PathRecoveryPolicy,
} from "./policy/path-recovery-extension.ts";
export {
	createRunRecordStore,
	type RunEvent,
	type RunManifest,
	type RunRecord,
	type RunRecordStore,
	type RunRecordStoreOptions,
	type RunState,
} from "./records/run-record.ts";
