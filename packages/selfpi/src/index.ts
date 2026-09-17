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
	buildSealedEvidenceBundle,
	type EvidenceBundleSource,
	type ProposalChangeBudget,
	type ProposalSchemaSummary,
	type RedactedRepresentativeTrace,
	type SealedEvidenceBundle,
	type SealedEvidenceBundleArtifact,
} from "./evidence/build-sealed-evidence-bundle.ts";
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
	type CandidatePolicyInput,
	type CandidatePolicyResult,
	type CandidatePolicyViolation,
	evaluateCandidatePolicy,
} from "./policy/candidate-policy.ts";
export {
	createPathRecoveryExtension,
	type PathRecoveryPolicy,
} from "./policy/path-recovery-extension.ts";
export {
	type CandidateProposalProvenance,
	createGitProposalWorktreeAdapter,
	type GenerateCandidateProposalInput,
	type GeneratedCandidateProposalResult,
	generateCandidateProposal,
	type ProposalGitAdapter,
	type ProposalModel,
	type ProposalWorktree,
	type ProposerProcessAdapter,
} from "./proposal/generate-candidate-proposal.ts";
export { createPiProposerProcessAdapter } from "./proposal/pi-proposer-process.ts";
export {
	type CandidateProposal,
	type CandidateProposalValidationResult,
	validateCandidateProposal,
} from "./proposal/validate-candidate-proposal.ts";
export {
	createRunRecordStore,
	type RunEvent,
	type RunManifest,
	type RunRecord,
	type RunRecordStore,
	type RunRecordStoreOptions,
	type RunState,
} from "./records/run-record.ts";
